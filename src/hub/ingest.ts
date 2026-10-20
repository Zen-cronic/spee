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
// Robustness. One CLI call at a time, each with the CliBeeSource timeout and child tracking. Failed
// calls for three different conversations (or the list) in a row open a circuit for 10 min; one
// conversation that keeps failing counts once. Each conversation remembers its own failures and
// waits a growing backoff before it is tried again, and the list poll takes the newest first, so a
// few that always fail never starve a newer one. A conversation fetched before Bee has labelled its
// final transcript (realtime only, or no wearer line yet) is not stored: it is fetched again on a
// later event or poll, a bounded number of times. A failure is logged once per kind, and nothing here
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
  retryBaseMs: number; // a conversation that failed (or was not ready) waits this long, doubling per try
  retryMaxMs: number;
  notReadyTries: number; // fetches of a not-yet-labelled conversation before it is stored as it is
  deletedFailures: number; // failed fetches after delete-conversation before the entry is dropped
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
  retryBaseMs: 10 * 60_000,
  retryMaxMs: 6 * 3600_000,
  notReadyTries: 5,
  deletedFailures: 3,
};

export const COMPLETED = "COMPLETED";

type Log = (event: string, data?: Record<string, unknown>) => void;
interface Pending {
  id: number;
  since: number;
  dueAt: number;
  tries: number;
  deleted: boolean; // the stream sent delete-conversation: Bee may have dropped it
  failures: number; // failed fetches in a row
}
// One conversation's history of failed or not-ready fetches.
interface Retry {
  failures: number;
  notReady: number;
  retryAt: number;
}
export type IngestStore = RealCorpus & { note: string };

const NOTE = "conversations the live hub ingested (src/hub/ingest.ts): the wearer's lines and per-conversation counts only; never other speakers' words";
const emptyStore = (): IngestStore => ({ generatedAt: new Date(0).toISOString(), note: NOTE, wearer: { labels: [], method: "none", counts: {} }, sessions: [], lines: [] });
// Bee says the conversation does not exist (the message is read here, never logged).
const notFound = (err: unknown) => /\b404\b|not found|no such conversation/i.test(String((err as Error)?.message ?? ""));
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
  private failing = new Set<string>(); // distinct calls that failed in a row (the breaker)
  private retries = new Map<string, Retry>();
  private openUntil = -Infinity;
  private me: Me | null;
  private meTriedAt = -Infinity;
  private logged = new Map<string, string>();
  readonly counters = { events: 0, fetched: 0, added: 0, deferred: 0, notReady: 0, polls: 0, failures: 0, circuitOpened: 0 };
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
    // A later COMPLETED event fetches a conversation that was not ready at once; one that failed
    // waits for its backoff.
    const r = this.retries.get(id);
    const due = Math.max(c.state === COMPLETED ? now : now + this.t.recheckMs[0]!, r && r.failures ? r.retryAt : now);
    if (p) p.dueAt = Math.min(p.dueAt, due);
    else this.pending.set(c.id, { id: c.id, since: now, dueAt: due, tries: 0, deleted: false, failures: 0 });
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

  // One Bee CLI call through the breaker. `key` names what was asked for: repeated failures of the
  // same key count once. Rethrows so the caller can reschedule.
  private async call<T>(op: string, f: () => Promise<T>, key = op): Promise<T> {
    try {
      const v = await f();
      this.failing.clear();
      this.logged.delete(op);
      return v;
    } catch (err) {
      this.counters.failures++;
      this.failing.add(key);
      this.logOnce(op, "bee.ingest.error", errorKind(err));
      if (this.failing.size >= this.t.breakerFailures) {
        this.failing.clear();
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
    const now = this.o.clock();
    // Newest first, and not one that is waiting out its backoff.
    const fresh = list
      .filter((s) => s.state === COMPLETED && !known.has(String(s.id)) && !this.done.has(String(s.id)) && (this.retries.get(String(s.id))?.retryAt ?? -Infinity) <= now)
      .sort((a, b) => b.start_time - a.start_time)
      .slice(0, this.t.maxPerPoll);
    if (fresh.length) this.log("bee.ingest.poll", { listed: list.length, fresh: fresh.length });
    for (const s of fresh) {
      if (this.stopped || this.circuitOpen()) break;
      await this.fetch(s.id, "poll");
    }
  }

  // A failed or not-ready fetch: the conversation waits retryBaseMs, doubling per try (at most
  // retryMaxMs), before the list poll or the stream tries it again.
  private backoff(id: number, kind: "failures" | "notReady"): Retry {
    const key = String(id);
    const r = this.retries.get(key) ?? { failures: 0, notReady: 0, retryAt: -Infinity };
    r[kind]++;
    const n = r.failures + r.notReady;
    r.retryAt = this.o.clock() + Math.min(this.t.retryMaxMs, this.t.retryBaseMs * 2 ** (n - 1));
    this.retries.set(key, r);
    return r;
  }

  private reschedule(p: Pending | undefined, atLeast = -Infinity) {
    if (!p) return;
    const now = this.o.clock();
    p.tries++;
    if (now - p.since >= this.t.pendingMaxAgeMs) {
      this.pending.delete(p.id);
      this.log("bee.ingest.gave-up", { id: p.id, tries: p.tries, note: "the list poll still picks it up once Bee completes it" });
      return;
    }
    p.dueAt = Math.max(atLeast, now + this.t.recheckMs[Math.min(p.tries, this.t.recheckMs.length - 1)]!);
  }

  private async fetch(id: number, via: "stream" | "poll") {
    const p = this.pending.get(id);
    // Already in (the list poll, an offline file): no CLI call, and the stream's entry goes.
    if (this.done.has(String(id)) || this.o.known().has(String(id))) {
      this.pending.delete(id);
      return;
    }
    let c: ConversationDetail | null;
    try {
      c = await this.call("get", () => this.o.src.conversation(id), `get:${id}`);
    } catch (err) {
      // Bee sends delete-conversation after every stop, so a failure after it is only "gone" when Bee
      // says so, or after a few failures in a row; anything else (a timeout, a network error) backs off.
      const r = this.backoff(id, "failures");
      if (p) p.failures++;
      if (p?.deleted && (notFound(err) || p.failures >= this.t.deletedFailures)) {
        this.pending.delete(id);
        this.log("bee.ingest.dropped", { id, failures: p.failures, note: "deleted by Bee" });
      } else this.reschedule(p, r.retryAt);
      return;
    }
    this.counters.fetched++;
    if (!c) {
      this.pending.delete(id);
      return;
    }
    if (p) p.failures = 0;
    const r = this.retries.get(String(id));
    if (r) r.failures = 0;
    if (c.state !== COMPLETED) return this.reschedule(p);
    const res = await this.ingest(c, via);
    if (res === "deferred") return this.reschedule(p);
    // Not labelled yet: a later COMPLETED event or poll fetches it again, after its backoff.
    if (res === "not-ready") return void this.pending.delete(id);
    this.pending.delete(id);
    this.retries.delete(String(id));
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

  private async ingest(c: ConversationDetail, via: "stream" | "poll"): Promise<"added" | "deferred" | "not-ready"> {
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
    // Bee can report COMPLETED before the final, labelled transcript is there: a realtime-only
    // transcript or no wearer line is not stored yet, up to notReadyTries fetches; then it is stored
    // as it is (`npm run real` still re-reads it).
    if ((stat.skipped || stat.wearerLines === 0) && (this.retries.get(id)?.notReady ?? 0) + 1 < this.t.notReadyTries) {
      const r = this.backoff(c.id, "notReady");
      this.counters.notReady++;
      this.log("bee.ingest.not-ready", { id: c.id, via, tries: r.notReady, realtimeOnly: !!stat.skipped, wearerLines: stat.wearerLines });
      return "not-ready";
    }
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
