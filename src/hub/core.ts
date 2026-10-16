// The coach hub: one state shared by every surface (TV mirror, phone, Alexa drill session).
//
// Bee is the input of record. An attempt typed or spoken into the phone/Alexa is a provisional
// preview: it is graded at once (status "pending_bee") so a surface can show feedback, but it does
// not count. The attempt counts when Bee's live stream tags the wearer saying it: Bee's text is
// graded (the final grade) and only that grade moves the card in the Leitner schedule. If the
// preview and Bee disagree, Bee wins. No Bee confirmation within the timeout and the poll
// fallback leaves the attempt "unverified" (not counted).
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localDate } from "../real/deck.js";
import { BeeVerifier, DEFAULT_TIMINGS, type BeeAttempt, type BeeEvent, type PollFn, type Verification, type VerifierTimings, type WearerTagRule } from "./bee.js";
import { cardView, habitOf, mustSayOf, type CardView, type HubCard } from "./cards.js";
import { grade, type GradeResult } from "./grade.js";
import { attemptSpan } from "./fuzzy.js";
import { habitKeysOf, isRegistered } from "./habits.js";
import { applyResult, nextDue, saveHubDeck, summarize, type BoxChange, type DeckSummary, type HubDeck } from "./scheduler.js";
import { habitRates, nextSessionDeltas, parseSource, selectSessions, sourceBreakdown, talkSummary, transfer, type DrillEvent, type RangeSpec, type SourceSel, type StatSession, type TransferPrereg } from "./stats.js";

export type ProvisionalSource = "phone" | "alexa" | "typed";
export type AttemptStatus = "pending_bee" | "polling" | "graded" | "unverified";

export interface Attempt {
  id: string;
  cardId: string;
  sessionId: string | null;
  status: AttemptStatus;
  counted: boolean; // true only once Bee's text was graded
  createdAt: number;
  settledAt: number | null;
  provisional: { source: ProvisionalSource; text: string; speechEndAt: number; grade: GradeResult } | null;
  bee: { text: string; gradedText?: string; extraText?: string; utteranceIds: number[]; speakerScore: number | null; via: "stream" | "poll"; latencyMs: number | null; coverage: number | null; replay: boolean } | null;
  final: { source: "bee"; pass: boolean; grade: GradeResult } | null;
  agreement: "agree" | "bee-overrules" | "bee-only" | null;
  reason: string; // why it is in this status
  box: BoxChange | null;
  synthetic?: boolean;
}

export interface DrillSession {
  id: string;
  by: string;
  startedAt: number;
  endedAt: number | null;
  size: number; // cards to drill
  cardIds: string[];
  attemptIds: string[];
}

export interface HubEvent {
  topic: string;
  payload: Record<string, unknown> & { seq: number; at: number };
}

export interface HubOptions {
  mode: "live" | "demo";
  clock?: () => number;
  tz?: string;
  deck: HubDeck;
  deckPath: string | null; // persist here (null: memory only)
  attempts?: Attempt[];
  attemptsPath: string | null;
  sessions: StatSession[];
  prereg: TransferPrereg | null;
  preregPath: string;
  wearer: WearerTagRule;
  timings?: VerifierTimings;
  poll?: PollFn;
  replay?: boolean; // Bee events come from a recorded-shape replay (demo)
  dataLabel?: string; // shown on every stats/transfer payload
}

const ids = { n: 0 };
const newId = (p: string, now: number) => `${p}_${now.toString(36)}${(ids.n++).toString(36).padStart(3, "0")}`;

export class CoachHub extends EventEmitter {
  readonly mode: "live" | "demo";
  readonly clock: () => number;
  readonly tz?: string;
  deck: HubDeck;
  attempts: Attempt[];
  sessions: StatSession[];
  prereg: TransferPrereg | null;
  readonly verifier: BeeVerifier;
  open: { cardId: string; openedAt: number; by: string } | null = null;
  session: DrillSession | null = null;
  lastSession: DrillSession | null = null;
  private seq = 0;
  readonly recent: HubEvent[] = []; // last 50 events (GET /api/events/recent, contract examples)

  constructor(private opts: HubOptions) {
    super();
    this.mode = opts.mode;
    this.clock = opts.clock ?? Date.now;
    this.tz = opts.tz;
    this.deck = opts.deck;
    this.attempts = opts.attempts ?? [];
    this.sessions = opts.sessions;
    this.prereg = opts.prereg;
    this.verifier = new BeeVerifier({
      clock: this.clock,
      rule: opts.wearer,
      timings: opts.timings,
      poll: opts.poll,
      onVerification: (v) => this.onVerification(v),
      onBeeAttempt: (a) => this.onBeeAttempt(a),
      onPolling: (id) => this.onPolling(id),
    });
  }

  get dataLabel() {
    return this.opts.dataLabel ?? (this.mode === "demo" ? "SYNTHETIC DEMO DATA (invented; not anyone's real results)" : "real data (gitignored)");
  }

  today() {
    return localDate(this.clock(), this.tz);
  }

  // Events

  publish(topic: string, data: Record<string, unknown>): HubEvent {
    const ev: HubEvent = { topic, payload: { seq: ++this.seq, at: this.clock(), ...data } };
    this.recent.push(ev);
    if (this.recent.length > 50) this.recent.shift();
    this.emit("event", ev);
    return ev;
  }

  ingestBee(e: BeeEvent) {
    this.verifier.ingest(e);
  }

  // Deck and cards

  card(id: string): HubCard | undefined {
    return this.deck.cards.find((c) => c.id === id);
  }

  view(c: HubCard): CardView {
    return cardView(c, this.today());
  }

  deckSummary(): DeckSummary {
    return summarize(this.deck, this.today());
  }

  nextCard(): HubCard | null {
    return nextDue(this.deck, this.today(), this.open?.cardId);
  }

  openCard(opts: { cardId?: string; by?: string } = {}): CardView | null {
    const c = opts.cardId ? this.card(opts.cardId) : this.nextCard();
    if (!c) return null;
    this.open = { cardId: c.id, openedAt: this.clock(), by: opts.by ?? "http" };
    if (this.session && !this.session.cardIds.includes(c.id)) this.session.cardIds.push(c.id);
    this.verifier.openCard({ cardId: c.id, resay: c.resay, lang: c.lang, openedAt: this.open.openedAt });
    const v = this.view(c);
    this.publish("card.open", { card: v, by: this.open.by, sessionId: this.session?.id ?? null, deck: this.deckSummary() });
    return v;
  }

  private gradeFor(c: HubCard, text: string) {
    return grade({ id: c.id, lang: c.lang, resay: c.resay, habit: habitOf(c), mustSay: mustSayOf(c) }, text);
  }

  // A provisional attempt (phone mic, Alexa, typed): graded for instant feedback, then held
  // until Bee confirms it.
  submit(opts: { text: string; source: ProvisionalSource; cardId?: string; speechEndAt?: number; durationMs?: number }): Attempt | { error: string } {
    const cardId = opts.cardId ?? this.open?.cardId;
    if (!cardId) return { error: "no_open_card" };
    const c = this.card(cardId);
    if (!c) return { error: "unknown_card" };
    if (this.open?.cardId !== cardId) this.openCard({ cardId, by: opts.source });
    const now = this.clock();
    const end = opts.speechEndAt ?? now;
    const words = opts.text.split(/\s+/).filter(Boolean).length;
    const dur = opts.durationMs ?? Math.max(1500, (words / 2.5) * 1000);
    const a: Attempt = {
      id: newId("att", now),
      cardId,
      sessionId: this.session?.id ?? null,
      status: "pending_bee",
      counted: false,
      createdAt: now,
      settledAt: null,
      provisional: { source: opts.source, text: opts.text, speechEndAt: end, grade: this.gradeFor(c, opts.text) },
      bee: null,
      final: null,
      agreement: null,
      reason: "listening via Bee: waiting for the wearer-tagged line (typically 5-15 s)",
      box: null,
    };
    this.attempts.push(a);
    if (this.session) this.session.attemptIds.push(a.id);
    this.verifier.expect({ attemptId: a.id, cardId, text: opts.text, speechStartMs: end - dur, speechEndMs: end });
    this.persistAttempts();
    this.publish("attempt.provisional", { attempt: a, card: this.view(c) });
    return a;
  }

  private onPolling(attemptId: string) {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a || a.status !== "pending_bee") return;
    a.status = "polling";
    a.reason = "no tagged line on the live stream within 30 s: checking the conversation with the Bee CLI";
    this.publish("attempt.status", { attemptId, cardId: a.cardId, status: a.status, reason: a.reason });
  }

  private settle(a: Attempt, c: HubCard, beeText: string) {
    // Grade only the attempt's own sentence(s); merged extra sentences are kept for display.
    const span = attemptSpan(c.resay, beeText, c.lang);
    if (a.bee) (a.bee.gradedText = span.graded), (a.bee.extraText = span.extra);
    const g = this.gradeFor(c, span.graded);
    a.final = { source: "bee", pass: g.pass, grade: g };
    a.status = "graded";
    a.counted = true;
    a.settledAt = this.clock();
    a.agreement = a.provisional ? (a.provisional.grade.pass === g.pass ? "agree" : "bee-overrules") : "bee-only";
    a.box = applyResult(this.deck, c.id, g.pass, this.clock(), this.tz);
    this.persistDeck();
    this.persistAttempts();
  }

  private onVerification(v: Verification) {
    const a = this.attempts.find((x) => x.id === v.attemptId);
    const c = a && this.card(a.cardId);
    if (!a || !c) return;
    if (v.status === "verified" && v.beeText) {
      a.bee = { text: v.beeText, utteranceIds: v.beeUtteranceIds, speakerScore: v.speakerScore, via: v.via!, latencyMs: v.latencyMs, coverage: v.coverage, replay: !!this.opts.replay };
      a.reason = v.reason;
      this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "verified", via: v.via, speakerScore: v.speakerScore, latencyMs: v.latencyMs, beeText: v.beeText, replay: !!this.opts.replay, reason: v.reason });
      this.settle(a, c, v.beeText);
      this.publish("attempt.graded", { attempt: a, card: this.view(c), deck: this.deckSummary() });
    } else {
      a.status = "unverified";
      a.settledAt = this.clock();
      a.reason = `not counted: ${v.reason}`;
      this.persistAttempts();
      this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "unverified", via: null, speakerScore: null, latencyMs: null, beeText: null, replay: !!this.opts.replay, reason: v.reason });
    }
    this.publishStats();
  }

  private onBeeAttempt(b: BeeAttempt) {
    const c = this.card(b.cardId);
    if (!c) return;
    const now = this.clock();
    const a: Attempt = {
      id: newId("att", now),
      cardId: c.id,
      sessionId: this.session?.id ?? null,
      status: "pending_bee",
      counted: false,
      createdAt: now,
      settledAt: null,
      provisional: null,
      bee: { text: b.text, utteranceIds: b.beeUtteranceIds, speakerScore: b.speakerScore, via: "stream", latencyMs: Math.round(now - b.speechEndMs), coverage: null, replay: !!this.opts.replay },
      final: null,
      agreement: null,
      reason: "Bee tagged the wearer saying the open card (no phone/Alexa preview)",
      box: null,
    };
    this.attempts.push(a);
    if (this.session) this.session.attemptIds.push(a.id);
    this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "verified", via: "stream", speakerScore: b.speakerScore, latencyMs: a.bee!.latencyMs, beeText: b.text, replay: !!this.opts.replay, reason: a.reason });
    this.settle(a, c, b.text);
    this.publish("attempt.graded", { attempt: a, card: this.view(c), deck: this.deckSummary() });
    this.publishStats();
  }

  // Drill sessions (driven by the Alexa MCP tools; mirrored on the TV)

  startSession(opts: { by?: string; size?: number } = {}): { session: DrillSession; card: CardView | null } {
    if (this.session) this.endSession();
    const now = this.clock();
    this.session = { id: newId("ses", now), by: opts.by ?? "http", startedAt: now, endedAt: null, size: Math.max(1, Math.min(10, opts.size ?? 3)), cardIds: [], attemptIds: [] };
    this.publish("session.started", { session: this.session });
    const card = this.openCard({ by: this.session.by });
    if (!card) this.endSession();
    return { session: this.session ?? this.lastSession!, card };
  }

  // Next card in the session, or the session summary when it is done.
  nextInSession(): { card: CardView | null; done: boolean; summary?: ReturnType<CoachHub["sessionSummary"]> | null } {
    const s = this.session;
    if (!s) return { card: null, done: true };
    const settledCards = new Set(this.attempts.filter((a) => s.attemptIds.includes(a.id) && a.counted).map((a) => a.cardId));
    if (settledCards.size >= s.size) return { card: null, done: true, summary: this.endSession() };
    const card = this.openCard({ by: s.by });
    if (!card) return { card: null, done: true, summary: this.endSession() };
    return { card, done: false };
  }

  endSession() {
    const s = this.session;
    if (!s) return this.lastSession ? this.sessionSummary(this.lastSession) : null;
    s.endedAt = this.clock();
    this.lastSession = s;
    this.session = null;
    this.open = null;
    this.verifier.closeCards();
    const summary = this.sessionSummary(s);
    this.publish("session.ended", { summary });
    return summary;
  }

  sessionSummary(s: DrillSession) {
    const as = this.attempts.filter((a) => s.attemptIds.includes(a.id));
    const counted = as.filter((a) => a.counted);
    return {
      sessionId: s.id,
      by: s.by,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      cards: s.cardIds.length,
      attempts: as.length,
      counted: counted.length,
      passed: counted.filter((a) => a.final?.pass).length,
      failed: counted.filter((a) => a.final && !a.final.pass).length,
      unverified: as.filter((a) => a.status === "unverified").length,
      pending: as.filter((a) => a.status === "pending_bee" || a.status === "polling").length,
      beeOverrules: counted.filter((a) => a.agreement === "bee-overrules").length,
      perCard: s.cardIds.map((id) => {
        const ca = counted.filter((a) => a.cardId === id);
        const c = this.card(id);
        return { cardId: id, habit: c ? habitOf(c).label : id, attempts: ca.length, passed: ca.filter((a) => a.final?.pass).length, box: c?.box ?? null, due: c?.due ?? null };
      }),
    };
  }

  // What a voice UI should narrate now.
  sessionState() {
    const last = [...this.attempts].reverse().find((a) => !this.open || a.cardId === this.open.cardId);
    const openCard = this.open ? this.card(this.open.cardId) : undefined;
    let state: "idle" | "card_open" | AttemptStatus = this.open ? "card_open" : "idle";
    if (this.open && last && last.createdAt >= this.open.openedAt) state = last.status;
    const narration: Record<string, string> = {
      idle: "No drill is running. Start a session to get your first card.",
      card_open: openCard ? `Say this: "${openCard.resay}"` : "",
      pending_bee: "Got it. I'm checking with Bee, which takes 5 to 20 seconds. Ask me how you did in a moment.",
      polling: "Bee's live feed was quiet, so I'm checking your conversation directly.",
      graded: last?.final ? (last.final.pass ? "Bee heard it. That's a pass." : `Bee heard it. Not yet: ${last.final.grade.checks.find((c) => !c.ok)?.detail ?? "try again"}.`) : "",
      unverified: "Bee didn't confirm that one, so it doesn't count. Try it again.",
    };
    const lastShown = last && this.open && last.createdAt >= this.open.openedAt ? last : null;
    return {
      state,
      narration: narration[state] ?? "",
      verdictReady: state === "graded" || state === "unverified",
      retryAfterMs: lastShown ? this.retryAfterMs(lastShown) : null,
      session: this.session,
      openCard: openCard ? this.view(openCard) : null,
      lastAttempt: lastShown,
      deck: this.deckSummary(),
      bee: { replay: !!this.opts.replay, pendingVerifications: this.verifier.pendingCount(), lastEventAt: this.verifier.lastEventAt, counters: this.verifier.counters },
    };
  }

  // When to ask again for a pending attempt: Bee's line usually lands 5-20 s after speech end
  // (a merged utterance took 15-19 s on a real device), then the poll at 30 s, the verdict by 45 s.
  retryAfterMs(a: Attempt): number | null {
    if (a.status === "graded" || a.status === "unverified") return null;
    const end = a.provisional?.speechEndAt ?? a.createdAt;
    const t = this.verifierTimings();
    const elapsed = this.clock() - end;
    const next = [t.pollAtMs[0]! / 2, ...t.pollAtMs, t.giveUpAfterMs].find((x) => x > elapsed) ?? t.giveUpAfterMs;
    return Math.max(500, Math.round(next - elapsed));
  }

  verifierTimings() {
    return this.opts.timings ?? DEFAULT_TIMINGS;
  }

  // The verdict for one attempt (Alexa's second turn: "how did I do?").
  verdict(id: string) {
    const a = this.attempts.find((x) => x.id === id);
    if (!a) return null;
    const narr: Record<AttemptStatus, string> = {
      pending_bee: "Bee hasn't sent that line yet. Ask me again in a few seconds.",
      polling: "Bee's live feed was quiet, so I'm checking your conversation directly. Ask again in a few seconds.",
      graded: a.final?.pass ? "Bee heard it. That's a pass." : `Bee heard it. Not yet: ${a.final?.grade.checks.find((c) => !c.ok)?.detail ?? "try again"}.`,
      unverified: "Bee didn't confirm that one, so it doesn't count. Try it again.",
    };
    return { attempt: a, status: a.status, verdictReady: a.status === "graded" || a.status === "unverified", retryAfterMs: this.retryAfterMs(a), narration: narr[a.status] };
  }

  // Stats, transfer

  drillEvents(): DrillEvent[] {
    return this.attempts
      .filter((a) => a.counted)
      .map((a) => {
        const c = this.card(a.cardId);
        return { at: a.createdAt, habitKeys: c ? habitKeysOf(habitOf(c)) : [] };
      });
  }

  stats(range: RangeSpec, source: SourceSel = "bee") {
    const now = this.clock();
    const ss = selectSessions(this.sessions, range, now, this.tz, source);
    const today = this.today();
    const inRange = (t: number) => {
      const d = localDate(t, this.tz);
      if (range.kind === "today") return d === today;
      if (range.kind === "week") return d >= selectFrom(today);
      return true;
    };
    const as = this.attempts.filter((a) => inRange(a.createdAt));
    return {
      dataLabel: this.dataLabel,
      synthetic: this.mode === "demo",
      range: range.kind === "session" ? `session:${range.id}` : range.kind,
      source,
      sources: sourceBreakdown(ss),
      sessions: ss.map((s) => ({ id: s.id, kind: s.kind, date: localDate(s.startMs, this.tz), words: habitRates([s]).words, synthetic: !!s.synthetic })),
      habits: habitRates(ss),
      talk: talkSummary(ss),
      practice: {
        attempts: as.length,
        counted: as.filter((a) => a.counted).length,
        passed: as.filter((a) => a.final?.pass).length,
        unverified: as.filter((a) => a.status === "unverified").length,
        beeOverrules: as.filter((a) => a.agreement === "bee-overrules").length,
      },
      drilledVsNextSession: nextSessionDeltas(this.sessions, this.drillEvents(), this.tz, source).map((d) => ({
        ...d,
        preregistered: !!this.prereg && isRegistered(d.habit, new Set([...this.prereg.drilled, ...this.prereg.control].map((h) => h.habit))),
        note: "one session either side of the first drill: a glance, not a test (see /api/transfer)",
      })),
    };
  }

  transfer(source: SourceSel = "bee") {
    if (!this.prereg) return null;
    return { dataLabel: this.dataLabel, ...transfer({ sessions: this.sessions, prereg: this.prereg, preregPath: this.opts.preregPath, drills: this.drillEvents(), nowMs: this.clock(), tz: this.tz, source }) };
  }

  publishStats() {
    const week = this.stats({ kind: "week" });
    const t = this.transfer();
    const today = this.stats({ kind: "today" }).practice;
    this.publish("stats.updated", {
      dataLabel: this.dataLabel,
      practiceToday: today,
      weekPer100: { words: week.habits.words, hedges: week.habits.hedges.per100, vague: week.habits.vague.per100, fillers: week.habits.fillers.per100, restarts: week.habits.restarts.per100 },
      transferHeadline: t?.headline ?? null,
      deck: this.deckSummary(),
    });
  }

  // Persistence

  persistDeck() {
    if (this.opts.deckPath) saveHubDeck(this.opts.deckPath, this.deck);
  }
  persistAttempts() {
    if (!this.opts.attemptsPath) return;
    mkdirSync(dirname(this.opts.attemptsPath), { recursive: true });
    writeFileSync(this.opts.attemptsPath, JSON.stringify({ attempts: this.attempts }, null, 1) + "\n");
  }
}

const selectFrom = (today: string) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
};

export function loadAttempts(path: string): Attempt[] {
  return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { attempts: Attempt[] }).attempts ?? []) : [];
}

export { parseSource };
