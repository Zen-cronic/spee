// Live ingest: the running hub picks up finished Bee conversations itself, so the stats, the transfer
// and its first signal move once Bee has finished a real conversation, without `npm run real` or a
// hub restart.
//
// Triggers. The stream's `update-conversation` (src/hub/bee.ts) queues the conversation: at once when
// its state is COMPLETED, otherwise (PROCESSING when the recording stops) re-fetched on a backoff until
// Bee completes it. A list poll every 10 min (`bee conversations list`) catches what the stream
// missed: any COMPLETED conversation of the last 24 h that no offline file and no earlier ingest has.
//
// Same rules as the offline pipeline. A conversation is fetched with `bee conversations get` (the
// CliBeeSource path) and goes through `conversationLines` (src/real/corpus.ts): the wearer filter and
// the mislabel detector. One conversation on its own takes only a label the Bee profile (or
// BEE_WEARER_LABELS) names as the wearer (`namedWearerOnly`, as the hub's fallback poll). No model
// call: everything here is deterministic.
//
// PRIVACY. Only the wearer's lines and per-conversation counts are kept, in <stateDir>/live/sessions.json
// (real/live/, gitignored; screened by the leak check). Other speakers' lines never leave
// `conversationLines`' in-memory context, which is dropped here. Logs carry ids, counts and error
// kinds, never text and never a CLI error message (a parse error can quote the CLI's output).
//
// Robustness. One CLI call at a time, each with the CliBeeSource timeout and child tracking. Three
// failed calls in a row open a circuit for 10 min. A failure is logged once per kind, and nothing here
// ever throws into the hub.
import { join } from "node:path";
import type { ConversationDetail, ConversationSummary, Me } from "../bee/schemas.js";
import { conversationLines, speakerCounts, type RealCorpus } from "../real/corpus.js";
import { discoverWearerLabels, namedWearerOnly } from "../real/wearer.js";
import { readJsonSafe, writeJsonAtomic } from "./atomic.js";
import type { BeeConversationEvent } from "./bee.js";
import { LIVE_SESSIONS_FILE, mergeCorpus, type StatSession } from "./stats.js";

export interface IngestSource {
  conversations(sinceMs: number): Promise<ConversationSummary[]>;
  conversation(id: number): Promise<ConversationDetail | null>;
  me?(): Promise<Me>;
}

export interface IngestTimings {
  tickMs: number; // how often due work is checked
  firstPollMs: number; // the first list poll, after start
  pollEveryMs: number; // then every this long
  lookbackMs: number; // the list poll looks at conversations that started this recently
  maxPerPoll: number; // conversations fetched per list poll (the rest wait for the next one)
  recheckMs: number[]; // after a stream end event, re-fetch at these delays (the last repeats) until COMPLETED
  pendingMaxAgeMs: number; // then stop re-fetching; the list poll still covers it
  breakerFailures: number; // consecutive failed CLI calls that open the circuit
  breakerOpenMs: number;
  meRetryMs: number; // retry `bee me` this often while it is unavailable
}
export const INGEST_TIMINGS: IngestTimings = {
  tickMs: 5000,
  firstPollMs: 30_000,
  pollEveryMs: 10 * 60_000,
  lookbackMs: 24 * 3600_000,
  maxPerPoll: 10,
  recheckMs: [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 10 * 60_000],
  pendingMaxAgeMs: 6 * 3600_000,
  breakerFailures: 3,
  breakerOpenMs: 10 * 60_000,
  meRetryMs: 10 * 60_000,
};

export const COMPLETED = "COMPLETED";

type Log = (event: string, data?: Record<string, unknown>) => void;
interface Pending {
  id: number;
  since: number;
  dueAt: number;
  tries: number;
  deleted: boolean; // the stream sent delete-conversation: a failed fetch then means it is gone
}
export type IngestStore = RealCorpus & { note: string };

const NOTE = "conversations the live hub ingested (src/hub/ingest.ts): the wearer's lines and per-conversation counts only; never other speakers' words";
const emptyStore = (): IngestStore => ({ generatedAt: new Date(0).toISOString(), note: NOTE, wearer: { labels: [], method: "none", counts: {} }, sessions: [], lines: [] });
// An error's kind for the log: never its message, which can quote the CLI's output.
const errorKind = (err: unknown) => {
  const e = err as { name?: unknown; code?: unknown; signal?: unknown; killed?: unknown } | null;
  return { error: typeof e?.name === "string" ? e.name : typeof err, code: typeof e?.code === "string" || typeof e?.code === "number" ? e.code : null, timedOut: !!e?.killed || e?.signal === "SIGKILL" };
};

export class LiveIngest {
  private t: IngestTimings;
  private store: IngestStore;
  private done = new Set<string>(); // conversation ids this ingest already stored
  private pending = new Map<number, Pending>();
  private busy = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private nextPollAt: number;
  private failures = 0;
  private openUntil = -Infinity;
  private me: Me | null;
  private meTriedAt = -Infinity;
  private logged = new Map<string, string>();
  readonly counters = { events: 0, fetched: 0, added: 0, deferred: 0, polls: 0, failures: 0, circuitOpened: 0 };
  lastAddedAt: number | null = null;

  constructor(
    private o: {
      src: IngestSource;
      stateDir: string;
      clock: () => number;
      known: () => Set<string>; // session ids the hub already has (offline files and earlier ingests)
      onSessions: (ss: StatSession[]) => void; // CoachHub.addSessions
      me?: Me | null; // the profile from setup (null: `bee me` failed there)
      log?: Log;
      timings?: Partial<IngestTimings>;
    },
  ) {
    this.t = { ...INGEST_TIMINGS, ...o.timings };
    this.store = readJsonSafe<IngestStore>(this.path, emptyStore);
    this.store.sessions ??= [];
    this.store.lines ??= [];
    for (const s of this.store.sessions) this.done.add(s.id);
    this.me = o.me ?? null;
    if (o.me === null) this.meTriedAt = o.clock();
    this.nextPollAt = o.clock() + this.t.firstPollMs;
  }

  get path() {
    return join(this.o.stateDir, LIVE_SESSIONS_FILE);
  }

  private log(event: string, data?: Record<string, unknown>) {
    this.o.log?.(event, data);
  }
  // Once per kind until it changes or the job succeeds (the hub's housekeeping does the same).
  private logOnce(job: string, event: string, data: Record<string, unknown>) {
    const key = JSON.stringify(data);
    if (this.logged.get(job) === key) return;
    this.logged.set(job, key);
    this.log(event, { job, ...data });
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.t.tickMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return { pending: this.pending.size, ingested: this.done.size, circuitOpen: this.o.clock() < this.openUntil, lastAddedAt: this.lastAddedAt, nextPollAt: this.nextPollAt, counters: { ...this.counters } };
  }

  // The stream's conversation events (CoachHub `bee.conversation`).
  onConversation(c: BeeConversationEvent) {
    if (this.stopped || c.type === "new-conversation") return;
    this.counters.events++;
    const id = String(c.id);
    const p = this.pending.get(c.id);
    if (c.type === "delete-conversation") {
      // Bee sends this right after a recording stops too (docs/live.md), so it does not cancel the
      // fetch: a conversation Bee still returns as COMPLETED is ingested; one it no longer has is dropped.
      if (p) p.deleted = true;
      return;
    }
    if (c.state === "CAPTURING" && c.endMs == null) return;
    if (this.done.has(id) || this.o.known().has(id)) return;
    const now = this.o.clock();
    const due = c.state === COMPLETED ? now : now + this.t.recheckMs[0]!;
    if (p) p.dueAt = Math.min(p.dueAt, due);
    else this.pending.set(c.id, { id: c.id, since: now, dueAt: due, tries: 0, deleted: false });
  }

  // Due re-fetches, then the list poll when it is time. Never throws; one run at a time.
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const now = this.o.clock();
      const due = [...this.pending.values()].filter((p) => p.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
      for (const p of due) {
        if (this.stopped || this.circuitOpen()) break;
        await this.fetch(p.id, "stream");
      }
      if (!this.stopped && !this.circuitOpen() && this.o.clock() >= this.nextPollAt) {
        this.nextPollAt = this.o.clock() + this.t.pollEveryMs;
        await this.poll();
      }
      this.logged.delete("tick");
    } catch (err) {
      this.logOnce("tick", "bee.ingest.error", errorKind(err));
    } finally {
      this.busy = false;
    }
  }

  private circuitOpen() {
    return this.o.clock() < this.openUntil;
  }

  // One Bee CLI call through the breaker. Rethrows so the caller can reschedule.
  private async call<T>(op: string, f: () => Promise<T>): Promise<T> {
    try {
      const v = await f();
      this.failures = 0;
      this.logged.delete(op);
      return v;
    } catch (err) {
      this.counters.failures++;
      this.failures++;
      this.logOnce(op, "bee.ingest.error", errorKind(err));
      if (this.failures >= this.t.breakerFailures) {
        this.failures = 0;
        this.openUntil = this.o.clock() + this.t.breakerOpenMs;
        this.counters.circuitOpened++;
        this.log("bee.ingest.circuit-open", { forMs: this.t.breakerOpenMs });
      }
      throw err;
    }
  }

  private async poll() {
    this.counters.polls++;
    let list: ConversationSummary[];
    try {
      list = await this.call("list", () => this.o.src.conversations(this.o.clock() - this.t.lookbackMs));
    } catch {
      return;
    }
    const known = this.o.known();
    const fresh = list
      .filter((s) => s.state === COMPLETED && !known.has(String(s.id)) && !this.done.has(String(s.id)))
      .sort((a, b) => a.start_time - b.start_time)
      .slice(0, this.t.maxPerPoll);
    if (fresh.length) this.log("bee.ingest.poll", { listed: list.length, fresh: fresh.length });
    for (const s of fresh) {
      if (this.stopped || this.circuitOpen()) break;
      await this.fetch(s.id, "poll");
    }
  }

  private reschedule(p: Pending | undefined) {
    if (!p) return;
    const now = this.o.clock();
    p.tries++;
    if (now - p.since >= this.t.pendingMaxAgeMs) {
      this.pending.delete(p.id);
      this.log("bee.ingest.gave-up", { id: p.id, tries: p.tries, note: "the list poll still picks it up once Bee completes it" });
      return;
    }
    p.dueAt = now + this.t.recheckMs[Math.min(p.tries, this.t.recheckMs.length - 1)]!;
  }

  private async fetch(id: number, via: "stream" | "poll") {
    const p = this.pending.get(id);
    let c: ConversationDetail | null;
    try {
      c = await this.call("get", () => this.o.src.conversation(id));
    } catch {
      if (p?.deleted) this.pending.delete(id); // Bee deleted it: nothing to ingest
      else this.reschedule(p);
      return;
    }
    this.counters.fetched++;
    if (!c) {
      this.pending.delete(id);
      return;
    }
    if (c.state !== COMPLETED) return this.reschedule(p);
    if ((await this.ingest(c, via)) === "deferred") return this.reschedule(p);
    this.pending.delete(id);
  }

  // The Bee profile names the wearer. Retried while unavailable, at most every meRetryMs.
  private async profile(): Promise<Me | null> {
    if (this.me || !this.o.src.me || this.o.clock() - this.meTriedAt < this.t.meRetryMs) return this.me;
    this.meTriedAt = this.o.clock();
    try {
      this.me = await this.call("me", () => this.o.src.me!());
    } catch {
      this.me = null;
    }
    return this.me;
  }

  private async ingest(c: ConversationDetail, via: "stream" | "poll"): Promise<"added" | "deferred"> {
    const id = String(c.id);
    if (this.done.has(id) || this.o.known().has(id)) return "added";
    const found = discoverWearerLabels(speakerCounts([c]), await this.profile());
    if (found.method !== "env" && !this.me) {
      // No profile and no BEE_WEARER_LABELS: nothing can be attributed to the wearer yet.
      this.counters.deferred++;
      this.logOnce("wearer", "bee.ingest.deferred", { reason: "no-profile", note: "bee me failed and BEE_WEARER_LABELS is unset" });
      return "deferred";
    }
    this.logged.delete("wearer");
    // Other speakers' lines stay in the context returned here, which is dropped unread.
    const { sessions, lines } = conversationLines([c], namedWearerOnly(found));
    const stat = sessions[0]!;
    this.store.sessions = [...this.store.sessions.filter((s) => s.id !== id), stat].sort((a, b) => a.startMs - b.startMs);
    this.store.lines = [...this.store.lines.filter((l) => l.session !== id), ...lines];
    this.store.generatedAt = new Date(this.o.clock()).toISOString();
    this.done.add(id);
    try {
      writeJsonAtomic(this.path, this.store);
      this.logged.delete("persist");
    } catch (err) {
      // In memory it still counts; the next restart loses only what could not be written.
      this.logOnce("persist", "bee.ingest.persist-error", errorKind(err));
    }
    const byId = new Map<string, StatSession>();
    mergeCorpus(byId, { ...this.store, sessions: [stat], lines });
    this.counters.added++;
    this.lastAddedAt = this.o.clock();
    this.log("bee.ingest.added", { id: c.id, via, totalLines: stat.totalLines, wearerLines: stat.wearerLines, uncertainLines: stat.uncertainLines, skipped: !!stat.skipped });
    this.o.onSessions([...byId.values()]);
    return "added";
  }
}
