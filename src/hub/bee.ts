// Bee live feed: parse `bee stream --json` events, and verify drill attempts against them.
//
// Measured 2026-10-16 (FL-8): `new-utterance` arrives 4.3-14.7 s (median 5.4 s) after the speaker
// stops; `tagged-utterance` (person_first_name, speaker_score 0.64-0.86) follows about 0.5 s
// later and identifies the wearer. Delivery is at-most-once: a tag can be missing (the first line of
// a recording was never tagged) and events can be lost, so a fallback poll of the conversation
// backs up the stream.
//
// PRIVACY. Utterance text from the stream lives in an in-memory buffer only. Text is handed to
// the hub (and so can reach disk) only after Bee tags it as the wearer with a sufficient score.
// Untagged or other-speaker text is dropped from memory after BUFFER_TTL_MS and never logged.
import { spawn, type ChildProcess } from "node:child_process";
import { trackChild } from "./processGuards.js";
import { createInterface } from "node:readline";
import { z } from "zod";
import { wordCount } from "../real/text.js";
import { align, normTokens, type Lang } from "./fuzzy.js";

// Event schemas (defensive: extra fields pass through; spoken_at is an ISO string on the stream
// and epoch ms on REST).
const When = z.union([z.string(), z.number()]).nullable().optional();
export const NewUtteranceSchema = z.object({
  type: z.literal("new-utterance"),
  conversation_uuid: z.string().optional(),
  utterance: z.object({
    id: z.number(),
    sample_id: z.string().optional(),
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional(),
    text: z.string(),
    spoken_at: When,
    speaker: z.string().optional(),
  }),
});
export const TaggedUtteranceSchema = z.object({
  type: z.literal("tagged-utterance"),
  utterance_id: z.number(),
  person_id: z.number().nullable().optional(),
  person_first_name: z.string().nullable().optional(),
  speaker_score: z.number().nullable().optional(),
  conversation_uuid: z.string().optional(),
});
export const NewConversationSchema = z.object({
  type: z.literal("new-conversation"),
  conversation: z.object({ id: z.number(), conversation_uuid: z.string().optional(), start_time: When, state: z.string().optional() }).passthrough(),
});
// Observed 2026-10-16 (a text-stripped capture of `bee stream --types all`): when a recording
// stops, `update-conversation` arrives at once with `end_time` set and `state: "PROCESSING"`,
// and `delete-conversation` (same object) follows about 0.4 s later. Both carry the full
// conversation object; only id, uuid, times and state are read.
export const UpdateConversationSchema = z.object({
  type: z.enum(["update-conversation", "delete-conversation"]),
  conversation: z.object({ id: z.number(), conversation_uuid: z.string().optional(), start_time: When, end_time: When, state: z.string().nullable().optional() }).passthrough(),
});
// `todo-deleted` (seen with --types all): {todo:{id, conversationId, text, completed, alarmAt,
// appleId}}. Only the id, completion and alarm are read (the text is never passed on).
export const TodoDeletedSchema = z.object({
  type: z.literal("todo-deleted"),
  todo: z.object({ id: z.union([z.number(), z.string()]), completed: z.boolean().nullable().optional(), alarmAt: z.number().nullable().optional() }).passthrough(),
});
export type NewUtterance = z.infer<typeof NewUtteranceSchema>;
export type TaggedUtterance = z.infer<typeof TaggedUtteranceSchema>;
export type NewConversation = z.infer<typeof NewConversationSchema>;
export type UpdateConversation = z.infer<typeof UpdateConversationSchema>;
export type TodoDeleted = z.infer<typeof TodoDeletedSchema>;
export type BeeEvent = NewUtterance | TaggedUtterance | NewConversation | UpdateConversation | TodoDeleted | { type: "keepalive"; timestamp: number };

// update-conversation ends a live conversation; delete-conversation retracts it; todo-deleted
// reconciles the wrist ledger. All three names were seen on the real stream (--types all,
// 2026-10-16). If the CLI rejects the list (the stream exits at once), spawnBeeStream falls back
// to STREAM_TYPES_MIN, whose names the CLI documents.
export const STREAM_TYPES = "new-utterance,tagged-utterance,new-conversation,update-conversation,delete-conversation,todo-deleted";
export const STREAM_TYPES_MIN = "new-utterance,tagged-utterance,new-conversation,update-conversation";

export const toMs = (t: string | number | null | undefined): number | null => {
  if (t == null) return null;
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
};

// One line of `bee stream --json` output (a leading non-JSON prefix, such as a receive
// timestamp in a capture log, is ignored). Unknown event types return null.
export function parseStreamLine(line: string): BeeEvent | null {
  const i = line.indexOf("{");
  if (i < 0) return null;
  let o: unknown;
  try {
    o = JSON.parse(line.slice(i));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.type === undefined && typeof r.timestamp === "number") return { type: "keepalive", timestamp: r.timestamp };
  for (const s of [NewUtteranceSchema, TaggedUtteranceSchema, NewConversationSchema, UpdateConversationSchema, TodoDeletedSchema]) {
    const p = s.safeParse(o);
    if (p.success) return p.data;
  }
  return null;
}

// Stream sources

export interface StreamHandle {
  stop(): void;
}

// Spawns `bee stream --types ... --json` and restarts it with backoff when it exits. Logs event
// types and counts only, never text. The CLI owns authentication; this code never reads the token.
export function spawnBeeStream(opts: { bin?: string; onEvent: (e: BeeEvent) => void; log?: (event: string, data?: Record<string, unknown>) => void; spawnFn?: typeof spawn }): StreamHandle {
  const bin = opts.bin ?? process.env.BEE_BIN ?? "bee";
  const log = opts.log ?? (() => {});
  let child: ChildProcess | null = null;
  let stopped = false;
  let backoff = 1000;
  let timer: NodeJS.Timeout | null = null;
  let types = STREAM_TYPES;
  let lines = 0;
  const start = () => {
    if (stopped) return;
    const startedAt = Date.now();
    lines = 0;
    child = trackChild((opts.spawnFn ?? spawn)(bin, ["stream", "--types", types, "--json"], { stdio: ["ignore", "pipe", "pipe"] }));
    log("bee.stream.start", { pid: child.pid, types });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (l) => {
      lines++;
      const e = parseStreamLine(l);
      if (e) opts.onEvent(e);
    });
    let errBytes = 0;
    child.stderr?.on("data", (d: Buffer) => (errBytes += d.length));
    child.on("error", (err) => log("bee.stream.error", { error: err.message }));
    child.on("close", (code) => {
      log("bee.stream.exit", { code, stderrBytes: errBytes });
      if (stopped) return;
      // An immediate failure with no output: the CLI may not accept every type name.
      if (types !== STREAM_TYPES_MIN && code !== 0 && lines === 0 && Date.now() - startedAt < 10_000) {
        types = STREAM_TYPES_MIN;
        log("bee.stream.types.fallback", { types });
      }
      if (Date.now() - startedAt > 60_000) backoff = 1000;
      timer = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const c = child;
      if (c && c.exitCode === null && c.signalCode === null) {
        c.kill();
        const k = setTimeout(() => c.exitCode === null && c.signalCode === null && c.kill("SIGKILL"), 2000);
        k.unref?.();
      }
    },
  };
}

// Replays scripted events (demo mode, tests): each step fires `dtMs * pace` after `play()`.
export interface ReplayStep {
  dtMs: number;
  event: BeeEvent;
}
export function replay(steps: ReplayStep[], onEvent: (e: BeeEvent) => void, pace = 1): StreamHandle {
  const timers = steps.map((s) => setTimeout(() => onEvent(s.event), Math.max(0, s.dtMs * pace)));
  return { stop: () => timers.forEach(clearTimeout) };
}

// Verifier

export interface WearerTagRule {
  isWearer: (tag: TaggedUtterance) => boolean;
  minScore: number;
}

export interface PolledUtterance {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
}
export type PollFn = (q: { conversationIds: number[]; fromMs: number; toMs: number }) => Promise<PolledUtterance[]>; // wearer-labelled lines only

export interface VerifierTimings {
  tagWaitMs: number; // a new-utterance with no tag after this is "untagged"
  pollAtMs: number[]; // fallback polls, ms after the attempt's speech end
  giveUpAfterMs: number; // then the attempt is "unverified"
  slackMs: number; // time-window slack (Bee spoken_at is second-granular; clocks differ)
  bufferTtlMs: number; // untagged/unused stream text is forgotten after this
}
// Stream wait 30 s (measured worst case 14.7 s + 0.5 s tag), then poll at 30 s and 37 s, then give up at 45 s.
export const DEFAULT_TIMINGS: VerifierTimings = { tagWaitMs: 3000, pollAtMs: [30_000, 37_000], giveUpAfterMs: 45_000, slackMs: 8000, bufferTtlMs: 180_000 };
export const scaleTimings = (t: VerifierTimings, pace: number): VerifierTimings => ({
  tagWaitMs: t.tagWaitMs * pace,
  pollAtMs: t.pollAtMs.map((x) => x * pace),
  giveUpAfterMs: t.giveUpAfterMs * pace,
  slackMs: t.slackMs,
  bufferTtlMs: t.bufferTtlMs,
});

// A wearer-tagged Bee line in the attempt's time window confirms it when it resembles either the
// provisional (phone/Alexa) text or the card's target sentence. Bee's text is then what is graded.
export const VERIFY_SIMILARITY = 0.6; // coverage: weighted share of the provisional text's words found in Bee's text
export const TARGET_MATCH = 0.5; // Bee text vs the card target (weighted recall)

export interface PendingAttempt {
  attemptId: string;
  cardId: string;
  text: string;
  speechStartMs: number;
  speechEndMs: number;
  createdAt: number;
  pollsDone: number;
  polling: boolean;
}

export interface Verification {
  attemptId: string;
  cardId: string;
  status: "verified" | "unverified";
  via: "stream" | "poll" | null;
  speakerScore: number | null;
  beeUtteranceIds: number[];
  beeText: string | null; // wearer-tagged text only
  coverage: number | null; // weighted share of the provisional text's words found in Bee's text
  latencyMs: number | null; // attempt speech end -> verification
  reason: string;
}

// One Bee line as the live engine sees it (hub -> `bee.line`). PRIVACY: `text` is present only for
// a line Bee tagged as the wearer with a sufficient score; for anyone else the line is a word count.
export type LineSpeaker = "wearer" | "other" | "low-score" | "untagged";
export interface BeeLine {
  utteranceId: number;
  conversationUuid: string | null;
  speaker: LineSpeaker;
  text?: string; // wearer lines only
  words: number;
  spokenAt: number; // Bee spoken_at (start of the line), hub-clock ms
  durMs: number | null; // Bee end - start (recording seconds), when both are present
  startS: number | null; // Bee utterance start/end: seconds from the start of the recording
  endS: number | null;
  receivedAt: number; // new-utterance reached the hub
  resolvedAt: number; // the speaker was decided (wearer tag, other tag, or tag timeout)
  score: number | null;
  drill: boolean; // the line confirmed a drill attempt (consumed by the verifier)
}
// A Bee conversation event (hub -> `bee.conversation`).
export interface BeeConversationEvent {
  type: "new-conversation" | "update-conversation" | "delete-conversation";
  id: number;
  uuid: string | null;
  state: string | null;
  startMs: number | null;
  endMs: number | null;
  receivedAt: number;
}

export interface BeeAttempt {
  cardId: string;
  text: string;
  speakerScore: number;
  beeUtteranceIds: number[];
  speechStartMs: number;
  speechEndMs: number;
  match: number;
}

interface Utt {
  id: number;
  uuid?: string;
  text: string;
  startMs: number;
  endMs: number;
  receivedAt: number;
  tag: "pending" | "wearer" | "other" | "low-score" | "timeout";
  score: number | null;
  consumed: boolean;
  startS?: number | null;
  endS?: number | null;
  emitted?: LineSpeaker; // the speaker last reported through onLine
}

export interface OpenCard {
  cardId: string;
  resay: string;
  lang: Lang;
  openedAt: number;
  closedAt: number | null;
}

export class BeeVerifier {
  private utts = new Map<number, Utt>();
  private earlyTags = new Map<number, TaggedUtterance>();
  private convIds = new Map<string, number>();
  private pending = new Map<string, PendingAttempt>();
  private cards: OpenCard[] = [];
  private consumedIds = new Set<number>(); // Bee lines already used to confirm an attempt (stream or poll)
  readonly counters = { events: 0, utterances: 0, duplicates: 0, tags: 0, wearerTags: 0, verified: 0, unverified: 0, beeOnly: 0, polls: 0 };
  lastEventAt: number | null = null;

  constructor(
    private opts: {
      clock: () => number;
      rule: WearerTagRule;
      timings?: VerifierTimings;
      poll?: PollFn;
      onVerification: (v: Verification) => void;
      onBeeAttempt: (a: BeeAttempt) => void;
      onPolling?: (attemptId: string) => void;
      onLine?: (l: BeeLine) => void; // the live engine: every line once its speaker is decided
      onConversation?: (c: BeeConversationEvent) => void;
      onTodoDeleted?: (t: { id: string; completed: boolean | null; alarmAt: number | null; receivedAt: number }) => void;
    },
  ) {}

  private get t() {
    return this.opts.timings ?? DEFAULT_TIMINGS;
  }

  openCard(c: Omit<OpenCard, "closedAt">) {
    const now = this.opts.clock();
    for (const x of this.cards) if (x.closedAt == null) x.closedAt = now;
    this.cards.push({ ...c, closedAt: null });
    this.cards = this.cards.filter((x) => x.closedAt == null || now - x.closedAt < this.t.giveUpAfterMs * 2);
  }

  closeCards() {
    const now = this.opts.clock();
    for (const x of this.cards) if (x.closedAt == null) x.closedAt = now;
  }

  expect(a: Omit<PendingAttempt, "createdAt" | "pollsDone" | "polling">) {
    this.pending.set(a.attemptId, { ...a, createdAt: this.opts.clock(), pollsDone: 0, polling: false });
    // Bee may already hold a matching wearer line (e.g. a typed attempt sent late).
    for (const u of this.utts.values()) if (u.tag === "wearer" && !u.consumed) this.tryMatch(u);
  }

  pendingCount() {
    return this.pending.size;
  }

  ingest(e: BeeEvent) {
    const now = this.opts.clock();
    this.counters.events++;
    this.lastEventAt = now;
    if (e.type === "keepalive") return;
    if (e.type === "todo-deleted") {
      this.opts.onTodoDeleted?.({ id: String(e.todo.id), completed: e.todo.completed ?? null, alarmAt: e.todo.alarmAt ?? null, receivedAt: now });
      return;
    }
    if (e.type === "new-conversation" || e.type === "update-conversation" || e.type === "delete-conversation") {
      const c = e.conversation;
      if (c.conversation_uuid) this.convIds.set(c.conversation_uuid, c.id);
      const end = "end_time" in c ? toMs(c.end_time as string | number | null | undefined) : null;
      this.opts.onConversation?.({ type: e.type, id: c.id, uuid: c.conversation_uuid ?? null, state: c.state ?? null, startMs: toMs(c.start_time), endMs: end, receivedAt: now });
      return;
    }
    if (e.type === "new-utterance") {
      const u = e.utterance;
      if (this.utts.has(u.id)) {
        this.counters.duplicates++;
        return;
      }
      this.counters.utterances++;
      const spoken = toMs(u.spoken_at) ?? now - 5000;
      const dur = u.start != null && u.end != null ? Math.max(0, (u.end - u.start) * 1000) : 0;
      const utt: Utt = { id: u.id, uuid: e.conversation_uuid, text: u.text, startMs: spoken, endMs: spoken + dur, receivedAt: now, tag: "pending", score: null, consumed: false, startS: u.start ?? null, endS: u.end ?? null };
      this.utts.set(u.id, utt);
      const early = this.earlyTags.get(u.id);
      if (early) {
        this.earlyTags.delete(u.id);
        this.applyTag(utt, early);
      }
      return;
    }
    if (e.type === "tagged-utterance") {
      this.counters.tags++;
      const utt = this.utts.get(e.utterance_id);
      if (!utt) {
        this.earlyTags.set(e.utterance_id, e); // tag before its utterance (out of order)
        return;
      }
      if (utt.tag === "wearer") {
        this.counters.duplicates++;
        return;
      }
      this.applyTag(utt, e);
    }
  }

  private applyTag(utt: Utt, tag: TaggedUtterance) {
    const score = tag.speaker_score ?? null;
    utt.score = score;
    if (!this.opts.rule.isWearer(tag)) utt.tag = "other";
    else if (score != null && score < this.opts.rule.minScore) utt.tag = "low-score";
    else {
      utt.tag = "wearer";
      this.counters.wearerTags++;
      this.tryMatch(utt);
    }
    this.emitLine(utt);
  }

  // Report a line to the live engine once its speaker is known (again if a late tag changes it).
  // Only a wearer line carries text.
  private emitLine(u: Utt) {
    if (!this.opts.onLine) return;
    if (u.tag === "pending") return;
    const speaker: LineSpeaker = u.tag === "timeout" ? "untagged" : u.tag;
    if (u.emitted === speaker) return;
    u.emitted = speaker;
    const durMs = u.startS != null && u.endS != null ? Math.max(0, (u.endS - u.startS) * 1000) : null;
    this.opts.onLine({
      utteranceId: u.id,
      conversationUuid: u.uuid ?? null,
      speaker,
      ...(speaker === "wearer" ? { text: u.text } : {}),
      words: wordCount(u.text),
      spokenAt: u.startMs,
      durMs,
      startS: u.startS ?? null,
      endS: u.endS ?? null,
      receivedAt: u.receivedAt,
      resolvedAt: this.opts.clock(),
      score: u.score,
      drill: speaker === "wearer" && u.consumed,
    });
  }

  // A line counts for a card only if Bee delivered it after the card opened and it was spoken no
  // earlier than the opening (minus the clock slack).
  private afterOpen(u: Utt, c: OpenCard) {
    return u.receivedAt >= c.openedAt && u.startMs >= c.openedAt - this.t.slackMs;
  }

  private overlaps(u: { startMs: number; endMs: number }, a: { speechStartMs: number; speechEndMs: number }) {
    const s = this.t.slackMs;
    return u.startMs - s <= a.speechEndMs && u.endMs + s >= a.speechStartMs;
  }

  // Match a wearer-tagged utterance to a pending attempt (single line, or joined with its
  // in-window neighbours when Bee split the attempt), else treat it as a Bee-only attempt on the
  // card that was open when it was spoken.
  private tryMatch(u: Utt) {
    if (u.consumed) return;
    let best: { a: PendingAttempt; group: Utt[]; sim: number; score: number } | null = null;
    for (const a of this.pending.values()) {
      if (!this.overlaps(u, a)) continue;
      const card = this.cards.find((c) => c.cardId === a.cardId);
      if (card && !this.afterOpen(u, card)) continue; // only lines spoken and received after the card opened
      const lang = card?.lang ?? "en";
      const group = [...this.utts.values()].filter((x) => x.tag === "wearer" && !x.consumed && this.overlaps(x, a)).sort((x, y) => x.startMs - y.startMs);
      for (const g of [[u], group]) {
        const text = g.map((x) => x.text).join(" ");
        const sim = align(normTokens(a.text, lang), normTokens(text, lang)).score; // coverage of the preview's words
        const tm = card ? align(normTokens(card.resay, lang), normTokens(text, lang)).score : 0;
        const score = Math.max(sim / VERIFY_SIMILARITY, tm / TARGET_MATCH);
        if (score >= 1 && (!best || score > best.score)) best = { a, group: g, sim, score };
      }
    }
    if (best) return this.finish(best.a, best.group, "stream", best.sim);
    // Bee lags 5-15 s, so the line may belong to a card that has just closed: score every card in
    // the window against its target sentence and take the best.
    let card: OpenCard | null = null;
    let match = 0;
    for (const c of this.cards) {
      if (!this.afterOpen(u, c) || (c.closedAt != null && u.startMs > c.closedAt + this.t.slackMs)) continue;
      if ([...this.pending.values()].some((a) => a.cardId === c.cardId && this.overlaps(u, a))) continue; // its preview is still pending
      const m = align(normTokens(c.resay, c.lang), normTokens(u.text, c.lang)).score;
      if (m > match || (m === match && card && c.openedAt > card.openedAt)) (card = c), (match = m);
    }
    if (!card || match < TARGET_MATCH) return; // the wearer was saying something else
    u.consumed = true;
    this.consumedIds.add(u.id);
    this.counters.beeOnly++;
    this.opts.onBeeAttempt({ cardId: card.cardId, text: u.text, speakerScore: u.score ?? 0, beeUtteranceIds: [u.id], speechStartMs: u.startMs, speechEndMs: u.endMs, match });
  }

  private finish(a: PendingAttempt, group: Utt[], via: "stream" | "poll", sim: number, scores?: (number | null)[]) {
    for (const g of group) (g.consumed = true), this.consumedIds.add(g.id);
    this.pending.delete(a.attemptId);
    this.counters.verified++;
    const ss = (scores ?? group.map((g) => g.score)).filter((x): x is number => x != null);
    this.opts.onVerification({
      attemptId: a.attemptId,
      cardId: a.cardId,
      status: "verified",
      via,
      speakerScore: ss.length ? Math.round(Math.min(...ss) * 1000) / 1000 : null,
      beeUtteranceIds: group.map((g) => g.id),
      beeText: group.map((g) => g.text).join(" "),
      coverage: sim,
      latencyMs: Math.round(this.opts.clock() - a.speechEndMs),
      reason: via === "stream" ? "Bee tagged the wearer saying it" : "Bee's transcript (poll) labels the wearer saying it",
    });
  }

  private whyNot(a: PendingAttempt): string {
    const inWin = [...this.utts.values()].filter((u) => this.overlaps(u, a) && !u.consumed);
    if (!inWin.length) return "no Bee utterance in the time window (stream and poll)";
    if (inWin.some((u) => u.tag === "wearer")) return "Bee heard the wearer, but the words matched neither the attempt nor the card";
    if (inWin.some((u) => u.tag === "low-score")) return `Bee's speaker score was below ${this.opts.rule.minScore}`;
    if (inWin.some((u) => u.tag === "other")) return "Bee tagged another speaker";
    return "Bee heard it but never tagged the wearer (tag timeout)";
  }

  // Timeouts and fallback polls. The server calls this every few hundred ms; tests call it directly.
  async tick(): Promise<void> {
    const now = this.opts.clock();
    for (const u of this.utts.values()) {
      if (u.tag === "pending" && now - u.receivedAt >= this.t.tagWaitMs) {
        u.tag = "timeout";
        this.emitLine(u);
      }
      if (now - u.receivedAt >= this.t.bufferTtlMs) this.utts.delete(u.id);
    }
    for (const [id] of this.earlyTags) if (!this.utts.has(id) && this.earlyTags.size > 200) this.earlyTags.delete(id);
    if (this.consumedIds.size > 5000) for (const id of [...this.consumedIds].slice(0, 2500)) this.consumedIds.delete(id);
    for (const a of [...this.pending.values()]) {
      const since = now - a.speechEndMs;
      if (since >= this.t.giveUpAfterMs && !a.polling) {
        this.pending.delete(a.attemptId);
        this.counters.unverified++;
        this.opts.onVerification({ attemptId: a.attemptId, cardId: a.cardId, status: "unverified", via: null, speakerScore: null, beeUtteranceIds: [], beeText: null, coverage: null, latencyMs: null, reason: this.whyNot(a) });
        continue;
      }
      const due = this.t.pollAtMs[a.pollsDone];
      if (this.opts.poll && due != null && since >= due && !a.polling) {
        a.polling = true;
        if (a.pollsDone === 0) this.opts.onPolling?.(a.attemptId);
        a.pollsDone++;
        this.counters.polls++;
        try {
          await this.pollFor(a);
        } catch {
          // a failed poll is retried at the next poll time; the give-up timer still applies
        } finally {
          a.polling = false;
        }
      }
    }
  }

  private async pollFor(a: PendingAttempt) {
    const ids = [...new Set([...this.utts.values()].filter((u) => this.overlaps(u, a) && u.uuid).map((u) => this.convIds.get(u.uuid!)).filter((x): x is number => x != null))];
    if (!ids.length) ids.push(...this.convIds.values());
    const lines = await this.opts.poll!({ conversationIds: ids, fromMs: a.speechStartMs - this.t.slackMs, toMs: a.speechEndMs + this.t.slackMs });
    if (!this.pending.has(a.attemptId)) return;
    const lang = this.cards.find((c) => c.cardId === a.cardId)?.lang ?? "en";
    const opened = this.cards.find((c) => c.cardId === a.cardId)?.openedAt ?? -Infinity;
    const win = lines.filter((l) => this.overlaps(l, a) && !this.consumedIds.has(l.id) && l.startMs >= opened - this.t.slackMs).sort((x, y) => x.startMs - y.startMs);
    const card = this.cards.find((c) => c.cardId === a.cardId);
    let best: { g: PolledUtterance[]; sim: number; score: number } | null = null;
    for (const g of [...win.map((l) => [l]), win]) {
      if (!g.length) continue;
      const text = g.map((x) => x.text).join(" ");
      const sim = align(normTokens(a.text, lang), normTokens(text, lang)).score; // coverage of the preview's words
      const tm = card ? align(normTokens(card.resay, lang), normTokens(text, lang)).score : 0;
      const score = Math.max(sim / VERIFY_SIMILARITY, tm / TARGET_MATCH);
      if (score >= 1 && (!best || score > best.score)) best = { g, sim, score };
    }
    if (!best) return;
    const group: Utt[] = best.g.map((l) => this.utts.get(l.id) ?? { id: l.id, text: l.text, startMs: l.startMs, endMs: l.endMs, receivedAt: this.opts.clock(), tag: "wearer", score: null, consumed: false });
    this.finish(a, group, "poll", best.sim, group.map((g) => g.score));
  }
}
