// The wrist: how a nudge, a recap or an if-then cue reaches the wearer.
//
// BeeTodoWrist creates a Bee to-do with an alarm a few seconds ahead
// (`bee todos create --text "[coach] ..." --alarm-at <iso> --json`). Verified 2026-10-16: the alarm
// fires with as little as 5-10 s of lead, and it reaches the Apple Watch only while Bee is
// recording and the iPhone is locked; otherwise it lands on the iPhone. Recaps fire after the
// recording stopped, so they land on the wrist or the phone.
//
//   - execFile, never a shell; the CLI owns authentication (this code never reads the token).
//   - One call at a time, at least MIN_GAP_MS apart, each with a 10 s timeout. A create is retried
//     twice; after a timeout the to-do list is checked first, so a slow create is not duplicated.
//   - Circuit breaker: 3 consecutive failed creates open it for 10 min (the live engine then
//     turns live mode off with reason "wrist-down").
//   - Ledger: <stateDir>/live/todos.json (ids, generated text, alarm times; never transcript text).
//   - Cleanup: a nudge or cue to-do is deleted 10 min after its alarm; a recap to-do is completed (it
//     shows ticked in the Bee app) 30 min after its alarm. At startup and every hour, any open
//     "[coach]" to-do whose alarm passed more than 30 min ago and that the ledger does not track
//     is deleted.
//
// ReplayWrist is the demo and test channel: no CLI; it reports the hops a real to-do would have
// (create ~1.45 s, alarm lead), scaled by the demo pace.
import { execFile } from "node:child_process";
import { trackChild } from "../processGuards.js";
import { readJsonSafe, writeJsonAtomic } from "../atomic.js";
import { promisify } from "node:util";
import { WRIST_TEXT_MAX, type WristChannel, type WristStatus } from "../contract.js";
import { CUE_TEXT } from "./rules.js";

export const DEFAULT_LEAD_MS = Number(process.env.NUDGE_ALARM_LEAD_S ?? 10) * 1000 || 10_000;
export const MIN_GAP_MS = 1500;
export const CALL_TIMEOUT_MS = 10_000;
export const CREATE_RETRIES = 2;
export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 10 * 60_000;
export const NUDGE_CLEANUP_MS = 10 * 60_000;
export const RECAP_CLEANUP_MS = 30 * 60_000;
export const STALE_MS = 30 * 60_000;
export const SWEEP_EVERY_MS = 60 * 60_000;
export const REPLAY_TODO_MS = 1450; // a measured create round trip, for the replay hops

export type WristKind = "nudge" | "recap" | "cue";
export interface WristRequest {
  kind: WristKind;
  refId: string; // the nudge, recap or cue id
  text: string; // generated "[coach] ..." text, <= WRIST_TEXT_MAX
  alarmAt?: number; // a later alarm (a cue "in N minutes"); never sooner than the lead
}
export interface WristResult {
  channel: WristChannel;
  status: "scheduled" | "failed" | "replay";
  todoId: string | null;
  todoAt: number | null;
  alarmAt: number | null;
  leadMs: number;
  error: string | null;
}
export interface Wrist {
  readonly channel: WristChannel;
  send(req: WristRequest): Promise<WristResult>;
  status(): WristStatus;
  circuitOpenUntil(): number | null;
  start(): void;
  stop(): void;
  onCircuitOpen?: () => void;
  reconcileDeleted?(todoId: string): void; // Bee's todo-deleted event (by us or by the wearer)
}

// The wrist texts the coach generates (src/hub/live/rules.ts nudgeText, recap.ts, scripts/wrist-probe.ts),
// current wording first, then the earlier wording (to-dos created before the rewording still match).
const MIN = "[\\d.]+ (?:minutes?|min)";
const literal = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const GENERATED_WRIST_RE = new RegExp(
  "^\\[coach\\] (?:" +
    [
      `\\d+ unsure words in ${MIN}\\. Say it plainly\\.`,
      `"Like" \\d+ times in ${MIN}\\. Pause instead\\.`,
      `You've talked ${MIN} straight\\. Check in\\.`,
      "\\d+ words a minute\\. Slow down a little\\.",
      `\\d+ hedges in ${MIN}\\. Say it plainly\\.`,
      `\\d+ "like"s in ${MIN}\\. Pause instead\\.`,
      `${MIN} without a break\\. Check in\\.`,
      "\\d+ words a minute\\. Slow down\\.",
      "Recap: .+",
      "probe \\d+s",
      ...Object.values(CUE_TEXT).map((t) => literal(t.slice("[coach] ".length))),
    ].join("|") +
    ")$",
);

export function assertWristText(text: string) {
  if (!text.startsWith("[coach] ") || text.length > WRIST_TEXT_MAX) throw new Error(`wrist text must start "[coach] " and be at most ${WRIST_TEXT_MAX} characters`);
}

// Replay (demo, tests, COACH_WRIST=replay)

export class ReplayWrist implements Wrist {
  readonly channel = "replay" as const;
  private timers = new Set<NodeJS.Timeout>();
  private waiting = new Set<() => void>();
  sent: WristRequest[] = [];
  constructor(private opts: { clock: () => number; pace: number; leadMs?: number; todoMs?: number }) {}
  get leadMs() {
    return this.opts.leadMs ?? DEFAULT_LEAD_MS;
  }
  async send(req: WristRequest): Promise<WristResult> {
    assertWristText(req.text);
    this.sent.push(req);
    await new Promise<void>((resolve) => {
      const done = () => (this.waiting.delete(done), resolve());
      this.waiting.add(done);
      const t = setTimeout(() => (this.timers.delete(t), done()), (this.opts.todoMs ?? REPLAY_TODO_MS) * this.opts.pace);
      this.timers.add(t);
    });
    const todoAt = this.opts.clock();
    const alarmAt = Math.max(todoAt + Math.round(this.leadMs * this.opts.pace), req.alarmAt ?? 0);
    return { channel: "replay", status: "replay", todoId: null, todoAt, alarmAt, leadMs: this.leadMs, error: null };
  }
  status(): WristStatus {
    return { channel: "replay", healthy: true, failures: 0, circuitOpenUntil: null, leadMs: this.leadMs, pendingTodos: 0 };
  }
  circuitOpenUntil() {
    return null;
  }
  start() {}
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of [...this.waiting]) w();
  }
}

// Bee to-dos

export type ExecFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr?: string }>;
const execFileP = promisify(execFile);
export const defaultExec: ExecFn = async (file, args, opts) => {
  const p = execFileP(file, args, { timeout: opts.timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  trackChild(p.child);
  const r = await p;
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

export interface TodoEntry {
  todoId: string;
  kind: WristKind;
  refId: string;
  text: string; // generated coach text only
  createdAt: number;
  alarmAt: number;
  cleanup: "delete" | "complete";
  cleanupAt: number;
  state: "pending" | "done" | "gone" | "error";
  attempts: number;
}

// "2026-10-16T20:22:10Z": whole seconds, rounded up, the format the probe verified.
export const alarmIso = (ms: number) => new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  return null;
};
// The JSON a CLI printed, or the last JSON value in its output when notice lines (an update banner,
// a warning) come before it, after it, or both. Throws when there is none.
export function cliJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    const lines = stdout.split(/\r?\n/);
    // The value ends on a line that closes it; try the last few such lines, then look up for its start.
    let ends = 0;
    for (let end = lines.length; end > 0 && ends < 4; end--) {
      if (!/[}\]]\s*$/.test(lines[end - 1]!)) continue;
      ends++;
      for (let i = end - 1; i >= 0; i--) {
        if (!/^\s*[[{]/.test(lines[i]!)) continue;
        try {
          return JSON.parse(lines.slice(i, end).join("\n"));
        } catch {
          /* not the start of the value: look further up */
        }
      }
    }
    throw err;
  }
}

// `bee todos create --json` printed {id, text, alarm_at (ms), completed, created_at, ...} on
// 2026-10-16; read defensively (a wrapper object, string ids, a notice line before the JSON).
export function parseTodo(stdout: string): { id: string; alarmAt: number | null } | null {
  try {
    const o = cliJson(stdout) as Record<string, any>;
    const t = (o && (o.todo ?? o.data ?? o)) as Record<string, unknown>;
    const id = t?.id;
    if (typeof id !== "number" && typeof id !== "string") return null;
    return { id: String(id), alarmAt: toMs(t.alarm_at ?? t.alarmAt) };
  } catch {
    return null;
  }
}
export interface ListedTodo {
  id: string;
  text: string;
  completed: boolean;
  alarmAt: number | null;
}
export function parseTodoList(stdout: string): ListedTodo[] {
  try {
    const o = cliJson(stdout);
    const arr = (Array.isArray(o) ? o : ((o as Record<string, unknown>).todos ?? (o as Record<string, unknown>).items ?? (o as Record<string, unknown>).data ?? [])) as Record<string, unknown>[];
    return (Array.isArray(arr) ? arr : [])
      .filter((t) => t && (typeof t.id === "number" || typeof t.id === "string"))
      // any truthy completed (true, 1, "true") or a completion time counts as done
      .map((t) => ({ id: String(t.id), text: typeof t.text === "string" ? t.text : "", completed: !!t.completed && t.completed !== "false" ? true : t.completed_at != null || t.completedAt != null, alarmAt: toMs(t.alarm_at ?? t.alarmAt) }));
  } catch {
    return [];
  }
}

export const errText = (e: unknown) => {
  const x = e as { killed?: boolean; signal?: string; code?: unknown; message?: string };
  if (x?.killed || x?.signal === "SIGTERM") return "timeout";
  return (x?.message ?? String(e)).split("\n")[0]!.slice(0, 160);
};

interface Job {
  run: () => Promise<void>;
  priority: boolean;
}

export interface BeeTodoWristOptions {
  bin?: string;
  exec?: ExecFn;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ledgerPath: string | null;
  leadMs?: number;
  minGapMs?: number;
  timeoutMs?: number;
  retries?: number;
  breakerThreshold?: number;
  breakerOpenMs?: number;
  cleanupCheckMs?: number;
  sweepEveryMs?: number;
  maxQueueWaitMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class BeeTodoWrist implements Wrist {
  readonly channel = "bee-todo" as const;
  onCircuitOpen?: () => void;
  private q: Job[] = [];
  private running = false;
  private lastCallEnd = -Infinity;
  private failures = 0;
  private openUntil: number | null = null;
  private ledger: TodoEntry[] = [];
  private createdIds = new Set<string>(); // every to-do id this coach ever created (kept past the ledger's trim)
  private queuedCleanup = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  readonly calls: { args: string[]; at: number; ok: boolean }[] = []; // for tests and describe()

  constructor(private o: BeeTodoWristOptions) {
    if (o.ledgerPath) {
      // a damaged ledger is moved aside and its last good copy used (atomic.ts), so createdIds survive
      const saved = readJsonSafe<{ todos?: TodoEntry[]; createdIds?: string[] }>(o.ledgerPath, () => ({}), (m) => this.log("wrist.ledger.recovered", { message: m }));
      this.ledger = Array.isArray(saved?.todos) ? saved.todos : [];
      this.createdIds = new Set([...(Array.isArray(saved?.createdIds) ? saved.createdIds : []), ...this.ledger.map((t) => t.todoId)]);
    }
  }

  private get clock() {
    return this.o.clock ?? Date.now;
  }
  get leadMs() {
    return this.o.leadMs ?? DEFAULT_LEAD_MS;
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.o.log?.(event, data);
  }
  private sleep(ms: number) {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  entries(): readonly TodoEntry[] {
    return this.ledger;
  }

  status(): WristStatus {
    const open = this.circuitOpenUntil();
    return { channel: "bee-todo", healthy: open == null && this.failures < (this.o.breakerThreshold ?? BREAKER_THRESHOLD), failures: this.failures, circuitOpenUntil: open, leadMs: this.leadMs, pendingTodos: this.ledger.filter((t) => t.state === "pending").length };
  }

  circuitOpenUntil(): number | null {
    return this.openUntil != null && this.clock() < this.openUntil ? this.openUntil : null;
  }

  start() {
    const tick = this.o.cleanupCheckMs ?? 60_000;
    const t1 = setInterval(() => this.cleanupDue(), tick);
    const t2 = setInterval(() => this.sweep(), this.o.sweepEveryMs ?? SWEEP_EVERY_MS);
    t1.unref?.();
    t2.unref?.();
    this.timers.push(t1, t2);
    this.sweep();
    this.cleanupDue();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.q = [];
  }

  // The serialized queue: creates jump ahead of cleanups; calls are at least minGapMs apart.
  private enqueue<T>(fn: () => Promise<T>, priority: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { priority, run: () => fn().then(resolve, reject) };
      if (priority) {
        const i = this.q.findIndex((j) => !j.priority);
        if (i < 0) this.q.push(job);
        else this.q.splice(i, 0, job);
      } else this.q.push(job);
      void this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length && !this.stopped) {
        const j = this.q.shift()!;
        await j.run().catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }
  private async call(args: string[]): Promise<string> {
    const wait = this.lastCallEnd + (this.o.minGapMs ?? MIN_GAP_MS) - this.clock();
    if (wait > 0) await this.sleep(wait);
    try {
      const r = await (this.o.exec ?? defaultExec)(this.o.bin ?? process.env.BEE_BIN ?? "bee", args, { timeout: this.o.timeoutMs ?? CALL_TIMEOUT_MS });
      this.calls.push({ args: args.slice(0, 2), at: this.clock(), ok: true });
      return r.stdout;
    } catch (e) {
      this.calls.push({ args: args.slice(0, 2), at: this.clock(), ok: false });
      throw e;
    } finally {
      this.lastCallEnd = this.clock();
    }
  }

  private saveLedger() {
    const p = this.o.ledgerPath;
    if (!p) return;
    const keepFrom = this.clock() - 7 * 24 * 3600_000;
    this.ledger = this.ledger.filter((t) => t.state === "pending" || t.createdAt >= keepFrom).slice(-500);
    const createdIds = [...this.createdIds].slice(-5000);
    // A failed write (full or read-only disk) is logged once and the wrist carries on in memory: a
    // nudge must still reach the wrist and the screens.
    try {
      writeJsonAtomic(p, { note: "Bee to-dos created by the live coach (generated text only; no transcript text)", todos: this.ledger, createdIds });
      this.saveFailed = false;
    } catch (err) {
      if (!this.saveFailed) this.log("wrist.ledger.save-failed", { error: errText(err) });
      this.saveFailed = true;
    }
  }
  private saveFailed = false;

  private fail(error: string): WristResult {
    return { channel: "bee-todo", status: "failed", todoId: null, todoAt: null, alarmAt: null, leadMs: this.leadMs, error };
  }

  private noteFailure() {
    this.failures++;
    if (this.failures >= (this.o.breakerThreshold ?? BREAKER_THRESHOLD) && this.circuitOpenUntil() == null) {
      this.openUntil = this.clock() + (this.o.breakerOpenMs ?? BREAKER_OPEN_MS);
      this.log("wrist.circuit.open", { failures: this.failures, until: this.openUntil });
      this.onCircuitOpen?.();
    }
  }

  send(req: WristRequest): Promise<WristResult> {
    try {
      assertWristText(req.text);
    } catch (e) {
      return Promise.resolve(this.fail((e as Error).message));
    }
    const queuedAt = this.clock();
    return this.enqueue(async () => {
      if (this.clock() - queuedAt > (this.o.maxQueueWaitMs ?? 30_000)) return this.fail("stale: waited too long in the wrist queue");
      const attempts = 1 + (this.o.retries ?? CREATE_RETRIES);
      let last = "";
      for (let i = 0; i < attempts; i++) {
        if (this.circuitOpenUntil() != null) return this.fail(`wrist circuit open after ${this.failures} failures`);
        const alarm = Math.ceil(Math.max(this.clock() + this.leadMs, req.alarmAt ?? 0) / 1000) * 1000;
        // The create may have landed without us knowing its id: adopt it from the list rather than
        // create a duplicate alarm.
        const adopt = async () => {
          const found = await this.call(["todos", "list", "--limit", "50", "--json"]).then(parseTodoList, () => [] as ListedTodo[]);
          const hit = found.find((x) => x.text === req.text && x.alarmAt != null && Math.abs(x.alarmAt - alarm) <= 2000);
          return hit ? this.created(req, hit.id, hit.alarmAt!) : null;
        };
        let out: string;
        try {
          out = await this.call(["todos", "create", "--text", req.text, "--alarm-at", alarmIso(alarm), "--json"]);
        } catch (e) {
          last = errText(e);
          this.noteFailure();
          this.log("wrist.create.failed", { kind: req.kind, refId: req.refId, attempt: i + 1, error: last });
          const adopted = last === "timeout" ? await adopt() : null;
          if (adopted) return adopted;
          continue;
        }
        // The CLI exited 0, so the to-do exists even when its output has no id: never create it
        // again (a second alarm), and do not count it against the circuit (Bee is fine).
        const t = parseTodo(out);
        if (t) return this.created(req, t.id, t.alarmAt ?? alarm);
        const adopted = await adopt();
        if (adopted) return adopted;
        this.log("wrist.create.no-id", { kind: req.kind, refId: req.refId });
        return this.createdWithoutId(alarm);
      }
      return this.fail(last || "bee todos create failed");
    }, true);
  }

  // Created, but neither the CLI's output nor the list gave its id: scheduled, with no id to clean up.
  private createdWithoutId(alarmAt: number): WristResult {
    this.failures = 0;
    return { channel: "bee-todo", status: "scheduled", todoId: null, todoAt: this.clock(), alarmAt, leadMs: this.leadMs, error: "bee todos create printed no to-do id; it will not be cleaned up" };
  }

  private created(req: WristRequest, id: string, alarmAt: number): WristResult {
    this.failures = 0;
    const now = this.clock();
    const cleanup = req.kind === "recap" ? "complete" : "delete";
    this.createdIds.add(id);
    this.ledger.push({ todoId: id, kind: req.kind, refId: req.refId, text: req.text, createdAt: now, alarmAt, cleanup, cleanupAt: alarmAt + (req.kind === "recap" ? RECAP_CLEANUP_MS : NUDGE_CLEANUP_MS), state: "pending", attempts: 0 });
    this.saveLedger();
    this.log("wrist.todo.created", { kind: req.kind, refId: req.refId, todoId: id, alarmAt });
    return { channel: "bee-todo", status: "scheduled", todoId: id, todoAt: now, alarmAt, leadMs: this.leadMs, error: null };
  }

  // Bee reported a to-do deleted (our cleanup, or the wearer in the Bee app): a pending ledger
  // entry for it needs no cleanup any more.
  reconcileDeleted(todoId: string) {
    const t = this.ledger.find((x) => x.todoId === todoId && x.state === "pending");
    if (!t) return;
    t.state = "gone";
    this.saveLedger();
    this.log("wrist.todo.gone", { todoId, kind: t.kind });
  }

  // Delete nudges and cues 10 min after their alarm; complete recaps 30 min after theirs.
  cleanupDue(): Promise<void[]> {
    const now = this.clock();
    const due = this.ledger.filter((t) => t.state === "pending" && t.cleanupAt <= now && !this.queuedCleanup.has(t.todoId));
    return Promise.all(
      due.map((t) => {
        this.queuedCleanup.add(t.todoId);
        return this.enqueue(async () => {
          try {
            await this.call(["todos", t.cleanup, t.todoId, "--json"]);
            t.state = "done";
          } catch (e) {
            const msg = errText(e);
            t.attempts++;
            if (/not found|404|no such/i.test(msg)) t.state = "gone";
            else if (t.attempts >= 3) t.state = "error";
            this.log("wrist.cleanup.failed", { todoId: t.todoId, action: t.cleanup, error: msg });
          } finally {
            this.queuedCleanup.delete(t.todoId);
            this.saveLedger();
          }
        }, false);
      }),
    );
  }

  // Delete open "[coach]" to-dos that are stale and untracked (a crash, a lost ledger, probes).
  async sweep(): Promise<number> {
    let deleted = 0;
    try {
      const list = await this.enqueue(() => this.call(["todos", "list", "--limit", "100", "--json"]).then(parseTodoList), false);
      const now = this.clock();
      const tracked = new Set(this.ledger.filter((t) => t.state === "pending").map((t) => t.todoId));
      // Ours: an id this coach created, or text in exactly the shape the coach generates (nudges,
      // recaps, wrist probes). A personal "[coach] prep 1:1 notes" or "[coach]: ..." is never touched.
      const ours = (t: ListedTodo) => this.createdIds.has(t.id) || GENERATED_WRIST_RE.test(t.text);
      const stale = list.filter((t) => t.text.startsWith("[coach] ") && ours(t) && !t.completed && !tracked.has(t.id) && t.alarmAt != null && now - t.alarmAt > STALE_MS);
      for (const t of stale) {
        await this.enqueue(() => this.call(["todos", "delete", t.id, "--json"]), false).then(
          () => deleted++,
          (e) => this.log("wrist.sweep.failed", { todoId: t.id, error: errText(e) }),
        );
      }
      this.log("wrist.sweep", { listed: list.length, stale: stale.length, deleted });
    } catch (e) {
      this.log("wrist.sweep.failed", { error: errText(e) });
    }
    return deleted;
  }
}
