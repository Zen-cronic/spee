// Bee memory: the coach keeps ONE goal fact in Bee, and reads how many insights and facts Bee has.
//
//   off (default)   no Bee call of any kind. Opt in with COACH_FACTS=1, live mode only, with the stream.
//   demo            nothing is written: the route shows the goal the coach would write (synthetic).
//   live            after a Bee-verified pass, `bee facts create --text <goal> --json`, then
//                   `bee facts confirm <id> --json` (a new fact comes back unconfirmed). Later passes
//                   and verdict changes `bee facts update <id> --text <goal> --confirmed true --json`
//                   the SAME id. Every 6 h, `bee insights list` and `bee facts list` are read for
//                   their COUNTS only.
//
// The goal text is a template filled with numbers, the fixed habit names and the transfer verdicts
// (composeGoal), and GOAL_TEXT_RE refuses anything else before the CLI is called: never transcript
// text, never another speaker, never another fact's text. Bee's chat and Alexa+ may not read it
// (no source says they do), so the route always carries BEE_MEMORY_NOTE.
//
// Idempotent. The ledger (<stateDir>/live/facts.json) records the intent before every create, so a
// restart or a create that timed out never makes a second fact: the coach looks for its own text in
// `bee facts list` (up to COUNT_PAGES pages) and adopts the fact it finds. A create whose outcome is
// not known is never made again: it is looked for at most LOOKS_MAX times, further apart each time
// (a restart keeps that schedule), never on stats.updated, and then the status stays "failed" with
// `stopped` until the operator clears it. Every call, the goal's and the count read's, runs on one
// chain: serialized, 1.5 s apart, 10 s timeout each. Its own breaker (3 consecutive failed calls
// open it for 30 min; a look that falls due meanwhile runs when it closes) never touches the wrist,
// so live coaching carries on.
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../atomic.js";
import { BEE_MEMORY_NOTE, type Attempt, type BeeMemory } from "../contract.js";
import type { CoachHub, HubEvent } from "../core.js";
import { HABIT_NAME, habitNameOf } from "../habitNames.js";
import { maskOut } from "../mask.js";
import { outputShape, parseFact, parseFactList, parseInsightCount, sameFactText, type ParsedFact } from "./factsParse.js";
import { defaultExec, errText, type ExecFn } from "./wrist.js";

export const FACTS_CALL_TIMEOUT_MS = 10_000;
export const FACTS_MIN_GAP_MS = 1500;
export const FACTS_BREAKER_THRESHOLD = 3;
export const FACTS_BREAKER_OPEN_MS = 30 * 60_000;
export const COUNTS_EVERY_MS = 6 * 3600_000;
export const COUNTS_FIRST_MS = 60_000; // the first count read, after the hub's start-up calls
export const UPDATE_MIN_MS = 10 * 60_000; // a text-only change (the pass count) updates at most this often
export const STATS_DEBOUNCE_MS = 5_000;
export const FACT_TEXT_MAX = 2000; // Bee's limit for a fact's text
export const COUNT_LIMIT = 100;
export const COUNT_PAGES = 5;
export const LOOK_FIRST_MS = 60_000; // a create of unknown outcome is looked for again after 1, 2, 4 and 8 min
export const LOOKS_MAX = 5; // looks for it, the first right after the create; then the coach stops looking
export const LOOK_EARLY_MS = 50; // the look timer still looks when it fires up to this early

export type FactsMode = "off" | "demo" | "live";
type Log = (event: string, data?: Record<string, unknown>) => void;

/** COACH_FACTS=1 turns it on, in live mode with the Bee stream only. */
export function factsModeFor(o: { demo: boolean; stream: boolean; env?: Record<string, string | undefined> }): FactsMode {
  if (o.demo) return "demo";
  return (o.env ?? process.env).COACH_FACTS === "1" && o.stream ? "live" : "off";
}

/** A pass Bee checked: graded on Bee's own text, counted, passed. */
export const beePass = (a: Attempt | null | undefined): boolean => !!a && a.status === "graded" && a.counted && a.final?.source === "bee" && a.final.pass === true;

// The goal text

const literal = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME = `(?:${[...new Set(Object.values(HABIT_NAME))].map(literal).join("|")})`;
const PART = `${NAME} (?:\\d+\\.\\d → \\d+\\.\\d per 100 words|needs more speech|not practised yet|can't be compared yet)`;
// The only text the coach ever writes to Bee.
export const GOAL_TEXT_RE = new RegExp(`^Speaking goal \\(Speaking Mirror\\): fewer ${NAME}(?:(?:, | and )${NAME})*\\. (?:Since [A-Z][a-z]{2,3} \\d{1,2}|So far): ${PART}(?:; ${PART})*; \\d+ lines? passed, checked by Bee\\.$`);

export function assertGoalText(text: string): void {
  if (text.length > FACT_TEXT_MAX || !GOAL_TEXT_RE.test(text)) throw new Error("goal text must be the coach's template (numbers and habit names only)");
}

export interface GoalDraft {
  text: string;
  verdictKey: string; // the drilled habits' verdicts: an update is due when this changes
}

const f1 = (x: number) => x.toFixed(1);
const listNames = (ns: string[]) => (ns.length <= 2 ? ns.join(" and ") : `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
const monthDay = (ms: number, tz?: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(ms));

/** The goal fact from the hub's numbers: the pre-registered drilled habits, their verdicts, Bee's passes. */
export function composeGoal(hub: Pick<CoachHub, "transfer" | "attempts" | "tz">): GoalDraft | null {
  const t = hub.transfer();
  const drilled = t?.habits.filter((h) => h.role === "drilled") ?? [];
  if (!drilled.length) return null;
  const first = Math.min(...drilled.map((h) => h.firstDrillAt ?? Infinity));
  const parts = drilled.map((h) => {
    const n = habitNameOf(h.habit);
    if (h.verdict === "dropped" || h.verdict === "no change" || h.verdict === "rose") return `${n} ${f1(h.before.per100)} → ${f1(h.after.per100)} per 100 words`;
    if (h.verdict === "too little data") return `${n} needs more speech`;
    if (h.verdict === "not drilled yet") return `${n} not practised yet`;
    return `${n} can't be compared yet`;
  });
  const passes = hub.attempts.filter(beePass).length;
  const since = Number.isFinite(first) ? `Since ${monthDay(first, hub.tz)}` : "So far";
  const text = `Speaking goal (Speaking Mirror): fewer ${listNames(drilled.map((h) => habitNameOf(h.habit)))}. ${since}: ${parts.join("; ")}; ${passes} ${passes === 1 ? "line" : "lines"} passed, checked by Bee.`;
  return { text, verdictKey: drilled.map((h) => `${h.habit}:${h.verdict}`).join("|") };
}

// The ledger

interface GoalEntry {
  factId: string;
  text: string; // what Bee holds (generated text only)
  verdictKey: string;
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}
// A create whose result is not known yet. "unknown": it may have landed (a timeout, or the hub
// stopped during the call); "landed": the CLI exited 0 without printing an id, so it exists. Either
// way it is never created again, only looked for (a ledger from before `looks` looks at once).
interface PendingCreate {
  text: string;
  verdictKey: string;
  at: number;
  outcome: "unknown" | "landed";
  looks?: number; // how many times the coach looked for it in Bee's lists
  nextLookAt?: number | null; // when the next look is due; null: it stopped looking (status "failed", `stopped`)
}
interface FactsLedger {
  goal: GoalEntry | null;
  pendingCreate: PendingCreate | null;
  insights: { count: number; readAt: number } | null;
  facts: { count: number; readAt: number } | null;
}

export type SyncReason = "pass" | "stats" | "tick" | "start" | "look";

export interface BeeFactsOptions {
  hub: CoachHub;
  mode: FactsMode;
  stateDir: string | null;
  exec?: ExecFn;
  bin?: string;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
  timeoutMs?: number;
  minGapMs?: number;
  breakerThreshold?: number;
  breakerOpenMs?: number;
  countsEveryMs?: number;
  countsFirstMs?: number;
  statsDebounceMs?: number;
  updateMinMs?: number;
  lookFirstMs?: number;
  looksMax?: number;
  onChange?: () => void; // the Bee memory changed (the plugin re-sends stats.updated so screens refetch)
}

const notFound = (e: unknown) => {
  const x = e as { message?: string; stderr?: string };
  return /not[ _-]?found|404|no such/i.test(`${x?.message ?? ""}\n${x?.stderr ?? ""}`);
};
// For logs: the exit and the first line of stderr, never the command line (it carries the text).
const callError = (e: unknown): string => {
  const t = errText(e);
  if (t === "timeout") return t;
  const x = e as { code?: unknown; stderr?: string };
  if (!/^Command failed/.test(t)) return t.slice(0, 120);
  const err = String(x?.stderr ?? "").split(/\r?\n/).find((l) => l.trim());
  return `exit ${String(x?.code ?? "?")}${err ? `: ${err.trim().slice(0, 100)}` : ""}`;
};

export class BeeFacts {
  private ledger: FactsLedger = { goal: null, pendingCreate: null, insights: null, facts: null };
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<SyncReason>();
  private failures = 0;
  private openUntil: number | null = null;
  private goalError: string | null = null;
  private lastCallEnd = -Infinity;
  private timers: NodeJS.Timeout[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private lookTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false; // stop() ran: this instance makes no more calls (not BeeMemory.stopped)
  private saveFailed = false;
  readonly calls: { args: string[]; ok: boolean }[] = []; // the command and subcommand only (tests, describe)

  constructor(private o: BeeFactsOptions) {
    if (o.mode === "live" && this.path) {
      const saved = readJsonSafe<Partial<FactsLedger>>(this.path, () => ({}), (m) => this.log("facts.ledger.recovered", { message: m }));
      this.ledger = { goal: saved?.goal ?? null, pendingCreate: saved?.pendingCreate ?? null, insights: saved?.insights ?? null, facts: saved?.facts ?? null };
    }
  }

  get mode(): FactsMode {
    return this.o.mode;
  }
  private get path() {
    return this.o.stateDir ? join(this.o.stateDir, "live", "facts.json") : null;
  }
  private now() {
    return (this.o.clock ?? Date.now)();
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.o.log?.(event, data);
  }
  private sleep(ms: number) {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  circuitOpenUntil(): number | null {
    return this.openUntil != null && this.now() < this.openUntil ? this.openUntil : null;
  }

  // GET /api/coach/facts
  memory(): BeeMemory {
    const hub = this.o.hub;
    const base = { dataLabel: hub.dataLabel, synthetic: this.o.mode === "demo", note: BEE_MEMORY_NOTE };
    if (this.o.mode === "off") return { ...base, enabled: false, status: "off", goal: null, insights: null, facts: null, stopped: false };
    if (this.o.mode === "demo") {
      // What the coach would write; nothing is written in demo.
      const d = composeGoal(hub);
      const last = hub.attempts.filter(beePass).at(-1);
      return { ...base, enabled: true, status: "demo", goal: d ? { factId: null, text: d.text, confirmed: false, updatedAt: last?.settledAt ?? null } : null, insights: null, facts: null, stopped: false };
    }
    const L = this.ledger;
    const gaveUp = L.pendingCreate?.nextLookAt === null; // a create Bee never listed: not made again, and nothing retries it
    const status: BeeMemory["status"] = this.circuitOpenUntil() != null || this.goalError || gaveUp ? "failed" : L.goal && L.goal.confirmed && !L.pendingCreate ? "synced" : "pending";
    const goal = L.goal ? { factId: L.goal.factId, text: L.goal.text, confirmed: L.goal.confirmed, updatedAt: L.goal.updatedAt } : L.pendingCreate ? { factId: null, text: L.pendingCreate.text, confirmed: false, updatedAt: null } : null;
    return { ...base, enabled: true, status, goal, insights: L.insights, facts: L.facts, stopped: gaveUp };
  }

  start() {
    if (this.o.mode !== "live") return; // off and demo: no subscription, no timer, no call
    const hub = this.o.hub;
    const onEvent = (ev: HubEvent) => this.onEvent(ev);
    hub.on("event", onEvent);
    this.unsubscribe = () => hub.off("event", onEvent);
    const first = setTimeout(() => void this.tick(), this.o.countsFirstMs ?? COUNTS_FIRST_MS);
    const every = setInterval(() => void this.tick(), this.o.countsEveryMs ?? COUNTS_EVERY_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
    if (this.ledger.pendingCreate || (this.ledger.goal && !this.ledger.goal.confirmed)) void this.sync("start");
  }

  stop() {
    this.closed = true;
    this.unsubscribe?.();
    for (const t of this.timers) clearTimeout(t);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.timers = [];
  }

  onEvent(ev: HubEvent) {
    if (this.o.mode !== "live" || this.closed) return;
    if (ev.topic === "attempt.graded" && beePass((ev.payload as { attempt?: Attempt }).attempt)) void this.sync("pass");
    else if (ev.topic === "stats.updated") {
      if (this.statsTimer) clearTimeout(this.statsTimer);
      this.statsTimer = setTimeout(() => void this.sync("stats"), this.o.statsDebounceMs ?? STATS_DEBOUNCE_MS);
      this.statsTimer.unref?.();
    }
  }

  // The counts, then the goal (a text-only change waits for this tick or a pass).
  async tick(): Promise<void> {
    await this.readCounts();
    await this.sync("tick");
  }

  // Every Bee call runs on this one chain, so calls never overlap and stay FACTS_MIN_GAP_MS apart.
  private enqueue(job: () => Promise<void>, onError: (e: unknown) => void): Promise<void> {
    this.chain = this.chain.then(job).catch(onError);
    return this.chain;
  }

  /** Queue a goal sync (coalesced per reason); resolves when the queue is idle. */
  sync(reason: SyncReason): Promise<void> {
    if (this.o.mode !== "live" || this.closed) return Promise.resolve();
    if (!this.queued.has(reason)) {
      this.queued.add(reason);
      return this.enqueue(() => (this.queued.delete(reason), this.syncNow(reason)), (e) => this.log("facts.sync.error", { reason, error: callError(e) }));
    }
    return this.chain;
  }
  settle(): Promise<void> {
    return this.chain;
  }

  private save() {
    const p = this.path;
    if (!p) return;
    try {
      writeJsonAtomic(p, { note: "The coach's one goal fact in Bee (generated template text only) and Bee's insight and fact counts (counts only, never their text)", ...this.ledger });
      this.saveFailed = false;
    } catch (err) {
      if (!this.saveFailed) this.log("facts.ledger.save-failed", { error: (err as Error).message });
      this.saveFailed = true;
    }
  }

  private async call(args: string[]): Promise<string> {
    if (this.circuitOpenUntil() != null) throw new Error("facts circuit open");
    const wait = this.lastCallEnd + (this.o.minGapMs ?? FACTS_MIN_GAP_MS) - this.now();
    if (wait > 0) await this.sleep(wait);
    try {
      const r = await (this.o.exec ?? defaultExec)(this.o.bin ?? process.env.BEE_BIN ?? "bee", args, { timeout: this.o.timeoutMs ?? FACTS_CALL_TIMEOUT_MS });
      this.calls.push({ args: args.slice(0, 2), ok: true });
      this.failures = 0;
      return r.stdout;
    } catch (e) {
      this.calls.push({ args: args.slice(0, 2), ok: false });
      this.failures++;
      if (this.failures >= (this.o.breakerThreshold ?? FACTS_BREAKER_THRESHOLD) && this.circuitOpenUntil() == null) {
        this.openUntil = this.now() + (this.o.breakerOpenMs ?? FACTS_BREAKER_OPEN_MS);
        this.log("facts.circuit.open", { failures: this.failures, until: this.openUntil });
      }
      throw e;
    } finally {
      this.lastCallEnd = this.now();
    }
  }

  // The coach's own goal fact in Bee's lists, matched by its exact text (a new fact is unconfirmed),
  // following each list's cursor for up to COUNT_PAGES pages, as the count read does. `read`: both
  // lists answered, so a miss means Bee does not list it.
  private async findOwn(text: string): Promise<{ hit: ParsedFact | null; read: boolean }> {
    let read = true;
    for (const extra of [["--unconfirmed"], []]) {
      let cursor: string | null = null;
      for (let page = 0; page < COUNT_PAGES; page++) {
        const out = await this.call(["facts", "list", ...extra, "--limit", String(COUNT_LIMIT), ...(cursor ? ["--cursor", cursor] : []), "--json"]).catch(() => null);
        if (out == null) {
          read = false;
          break;
        }
        const l = parseFactList(out);
        const hit = l.items.find((f) => sameFactText(f.text, text));
        if (hit) return { hit, read: true };
        if (!l.cursor || l.items.length < COUNT_LIMIT) break;
        cursor = l.cursor;
      }
    }
    return { hit: null, read };
  }

  // A look for a create of unknown outcome, once its time has come: at a pass, the tick, the look
  // timer or a restart. A hub stopped during the create, or a ledger from before `looks`, has no
  // time yet and looks at once. Never on stats.updated, and never after the coach stopped looking.
  // The timer's own look keeps the time too (LOOK_EARLY_MS of slack for a timer that fires early):
  // a pass queued behind a busy chain may have looked first and moved the time on.
  private lookDue(p: PendingCreate, reason: SyncReason): boolean {
    if (p.nextLookAt === null || reason === "stats") return false;
    return this.now() >= (p.nextLookAt ?? 0) - (reason === "look" ? LOOK_EARLY_MS : 0);
  }

  // Bee does not list it: look again later (twice as long each time), or stop after LOOKS_MAX looks.
  // Only a look that read Bee's lists counts (a Bee outage never uses them up). It is never created
  // again either way.
  private notListed(p: PendingCreate, read: boolean) {
    const looks = (p.looks ?? 0) + (read ? 1 : 0);
    p.looks = looks;
    if (looks >= (this.o.looksMax ?? LOOKS_MAX)) p.nextLookAt = null;
    else {
      const wait = (this.o.lookFirstMs ?? LOOK_FIRST_MS) * 2 ** Math.max(0, looks - 1);
      p.nextLookAt = this.now() + wait;
      this.scheduleLook(wait);
    }
    return this.fail(this.notListedReason(p, read));
  }

  // Why the goal is not in Bee yet (the status's failure and the log line).
  private notListedReason(p: PendingCreate, read: boolean): string {
    const what = p.outcome === "landed" ? "create printed no fact id" : "create timed out";
    const looks = p.looks ?? 0;
    if (p.nextLookAt === null) return `${what} and Bee never listed it (${looks} looks); the coach stopped looking and never creates it again`;
    return `${what} and ${read ? `Bee does not list it yet (look ${looks} of ${this.o.looksMax ?? LOOKS_MAX})` : "Bee's lists could not be read"}; it is never created again`;
  }

  private scheduleLook(ms: number) {
    if (this.closed) return;
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.lookTimer = setTimeout(() => ((this.lookTimer = null), void this.sync("look")), ms);
    this.lookTimer.unref?.();
  }

  private fail(reason: string) {
    this.goalError = reason;
    this.save();
    this.log("facts.goal.failed", { error: reason });
  }

  private adopt(f: ParsedFact, p: PendingCreate, how: "created" | "adopted") {
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.lookTimer = null;
    const now = this.now();
    this.ledger.goal = { factId: f.id, text: p.text, verdictKey: p.verdictKey, confirmed: f.confirmed === true, createdAt: now, updatedAt: now };
    this.ledger.pendingCreate = null;
    this.save();
    this.log(`facts.goal.${how}`, { factId: f.id });
  }

  private async syncNow(reason: SyncReason): Promise<void> {
    if (this.closed) return;
    const open = this.circuitOpenUntil();
    if (open != null) {
      // The look timer fired inside the breaker's window: it looks again once the breaker closes.
      const p = this.ledger.pendingCreate;
      if (reason === "look" && p && !this.ledger.goal && p.nextLookAt !== null) this.scheduleLook(open - this.now());
      return;
    }
    const L = this.ledger;
    const before = JSON.stringify(this.memory());
    try {
      // 1. A create whose result is not known: nothing else happens until Bee lists it. Look for it
      // when a look is due; it is never created again.
      if (L.pendingCreate && !L.goal) {
        const p = L.pendingCreate;
        if (!this.lookDue(p, reason)) {
          // A restart before the look is due keeps the schedule: the timer waits out the time left,
          // and the status stays failed for the reason the last look gave.
          if (reason === "start" && p.nextLookAt != null) {
            this.scheduleLook(p.nextLookAt - this.now());
            this.goalError = this.notListedReason(p, (p.looks ?? 0) > 0);
            this.log("facts.goal.failed", { error: this.goalError });
          } else if (reason === "look" && p.nextLookAt != null && !this.lookTimer) this.scheduleLook(p.nextLookAt - this.now()); // a timer that fired far too early
          return;
        }
        const { hit, read } = await this.findOwn(p.text);
        if (!hit) return this.notListed(p, read);
        this.adopt(hit, p, "adopted");
      }
      const draft = composeGoal(this.o.hub);
      // 2. No goal fact yet: only a Bee-verified pass creates it.
      if (!L.goal && !L.pendingCreate) {
        if (reason !== "pass" || !draft) return;
        const text = maskOut(draft.text, "screen");
        assertGoalText(text);
        const p: PendingCreate = { text, verdictKey: draft.verdictKey, at: this.now(), outcome: "unknown" };
        L.pendingCreate = p;
        this.save(); // the intent first: a restart mid-call looks for it instead of creating again
        let out: string;
        try {
          out = await this.call(["facts", "create", "--text", text, "--json"]);
        } catch (e) {
          const err = callError(e);
          if (err !== "timeout") {
            L.pendingCreate = null;
            return this.fail(`create failed: ${err}`);
          }
          const { hit, read } = await this.findOwn(text);
          if (!hit) return this.notListed(p, read);
          this.adopt(hit, p, "adopted");
          out = "";
        }
        if (out) {
          const parsed = parseFact(out);
          if (!parsed) this.log("facts.create.unreadable", { output: outputShape(out) }); // keys and types only
          const found = parsed ? { hit: parsed, read: true } : await this.findOwn(text);
          if (!found.hit) {
            p.outcome = "landed";
            return this.notListed(p, found.read);
          }
          this.adopt(found.hit, p, "created");
        }
      }
      const g = L.goal;
      if (!g) return;
      // 3. Confirm it (a new fact comes back unconfirmed).
      if (!g.confirmed) {
        try {
          await this.call(["facts", "confirm", g.factId, "--json"]);
        } catch (e) {
          if (notFound(e)) return this.gone(g.factId);
          return this.fail(`confirm failed: ${callError(e)}`);
        }
        g.confirmed = true;
        g.updatedAt = this.now();
        this.save();
        this.log("facts.goal.confirmed", { factId: g.factId });
      }
      // 4. Update the same id: a verdict change at once; a text-only change (the pass count) at a
      // pass or the 6-hourly tick, at most every UPDATE_MIN_MS.
      if (draft && reason !== "start") {
        const text = maskOut(draft.text, "screen");
        const verdictChanged = draft.verdictKey !== g.verdictKey;
        const textDue = reason !== "stats" && !sameFactText(text, g.text) && this.now() - g.updatedAt >= (this.o.updateMinMs ?? UPDATE_MIN_MS);
        if (verdictChanged || textDue) {
          assertGoalText(text);
          let out: string;
          try {
            out = await this.call(["facts", "update", g.factId, "--text", text, "--confirmed", "true", "--json"]);
          } catch (e) {
            if (notFound(e)) return this.gone(g.factId);
            return this.fail(`update failed: ${callError(e)}`);
          }
          Object.assign(g, { text, verdictKey: draft.verdictKey, confirmed: parseFact(out)?.confirmed !== false, updatedAt: this.now() });
          this.save();
          this.log("facts.goal.updated", { factId: g.factId, verdictChanged });
          if (!g.confirmed) return void this.queueConfirm();
        }
      }
      this.goalError = null;
    } finally {
      if (JSON.stringify(this.memory()) !== before) this.o.onChange?.();
    }
  }

  private queueConfirm() {
    void this.sync("start");
  }

  // Bee no longer has it (deleted in the Bee app): forget it; the next pass writes one goal fact again.
  private gone(factId: string) {
    this.ledger.goal = null;
    this.goalError = null;
    this.save();
    this.log("facts.goal.gone", { factId });
  }

  /** Read Bee's insight and fact counts, on the call chain after any goal sync; resolves when it is idle. */
  readCounts(): Promise<void> {
    if (this.o.mode !== "live" || this.closed) return Promise.resolve();
    return this.enqueue(() => this.countsNow(), (e) => this.log("facts.counts.error", { error: callError(e) }));
  }

  // Counts only: the items are dropped as soon as they are counted.
  private async countsNow(): Promise<void> {
    if (this.closed || this.circuitOpenUntil() != null) return;
    const before = JSON.stringify(this.memory());
    const insights = await this.countPages(["insights", "list"], (out) => parseInsightCount(out));
    const facts = await this.countPages(["facts", "list"], (out) => {
      const l = parseFactList(out);
      return { count: l.items.length, cursor: l.cursor };
    });
    const now = this.now();
    if (insights != null) this.ledger.insights = { count: insights, readAt: now };
    if (facts != null) this.ledger.facts = { count: facts, readAt: now };
    if (insights != null || facts != null) this.save();
    this.log("facts.counts", { insights, facts });
    if (JSON.stringify(this.memory()) !== before) this.o.onChange?.();
  }

  private async countPages(base: string[], parse: (out: string) => { count: number; cursor: string | null } | null): Promise<number | null> {
    let total = 0;
    let cursor: string | null = null;
    for (let page = 0; page < COUNT_PAGES; page++) {
      let out: string;
      try {
        out = await this.call([...base, "--limit", String(COUNT_LIMIT), ...(cursor ? ["--cursor", cursor] : []), "--json"]);
      } catch (e) {
        this.log("facts.counts.failed", { what: base[0], error: callError(e) });
        return null;
      }
      const r = parse(out);
      if (!r) {
        this.log("facts.counts.unreadable", { what: base[0], output: outputShape(out) });
        return null;
      }
      total += r.count;
      if (!r.cursor || r.count < COUNT_LIMIT) break;
      cursor = r.cursor;
    }
    return total;
  }

  describe(): string {
    if (this.o.mode !== "live") return this.o.mode;
    const m = this.memory();
    return `live (${m.status}${m.stopped ? ": Bee never listed the goal create, so it is not made again; see docs/live.md" : ""}${this.circuitOpenUntil() != null ? ", circuit open" : ""})`;
  }
}
