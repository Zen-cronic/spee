// The coach hub: one state shared by every surface (TV mirror, phone, Alexa drill session).
//
// Bee is the input of record. An attempt typed or spoken into the phone/Alexa is a provisional
// preview: it is graded at once (status "pending_bee") so a surface can show feedback, but it does
// not count. The attempt counts when Bee's live stream tags the wearer saying it: Bee's text is
// graded (the final grade) and only that grade moves the card in the Leitner schedule. If the
// preview and Bee disagree, Bee wins. No Bee confirmation within the timeout and the poll
// fallback leaves the attempt "unverified" (not counted).
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { localDate } from "../real/deck.js";
import { readJsonSafe, writeJsonAtomic } from "./atomic.js";
import { BeeVerifier, DEFAULT_TIMINGS, type BeeAttempt, type BeeConversationEvent, type BeeEvent, type BeeLine, type BeeSpan, type PollFn, type Verification, type VerifierTimings, type WearerTagRule } from "./bee.js";
import { cardView, habitOf, mustSayOf, type CardView, type HubCard } from "./cards.js";
import { grade, type GradeResult } from "./grade.js";
import { attemptSpan } from "./fuzzy.js";
import { LIVE_WINDOW_MIN_INTERVAL_MS, ROOM_TOPICS, SEQUENCED_TOPICS, type LiveWindow, type PracticeCounts, type SequencedTopic } from "./contract.js";
import { habitKeysOf, isRegistered } from "./habits.js";
import { applyResult, nextDue, saveHubDeck, summarize, type BoxChange, type DeckSummary, type HubDeck } from "./scheduler.js";
import { fromSource, habitRates, nextSessionDeltas, parseSource, selectSessions, sourceBreakdown, talkSummary, transfer, withoutDrillLines, type DrillEvent, type DrillLines, type DrillSpan, type RangeSpec, type SourceSel, type StatSession, type TransferPrereg } from "./stats.js";
import { failReason } from "./failReason.js";

export type ProvisionalSource = "phone" | "alexa" | "mcp" | "typed";
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
  // spokenFromMs/spokenToMs/conversationId: when Bee's lines were spoken and in which conversation
  // (absent on attempts stored before they were recorded).
  bee: { text: string; gradedText?: string; extraText?: string; utteranceIds: number[]; speakerScore: number | null; via: "stream" | "poll"; latencyMs: number | null; coverage: number | null; replay: boolean; spokenFromMs?: number; spokenToMs?: number; conversationId?: string | null } | null;
  final: { source: "bee"; pass: boolean; grade: GradeResult } | null;
  agreement: "agree" | "bee-overrules" | "bee-only" | null;
  reason: string; // why it is in this status
  box: BoxChange | null;
  synthetic?: boolean;
  openingSeq?: number; // the card opening it was made in (CoachHub.open.seq); absent on stored attempts
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
export const DRILL_IDLE_MS = 10 * 60_000;
const newId = (p: string, now: number) => `${p}_${now.toString(36)}${(ids.n++).toString(36).padStart(3, "0")}`;

const practiceCounts = (as: Attempt[]): PracticeCounts => ({
  attempts: as.length,
  counted: as.filter((a) => a.counted).length,
  passed: as.filter((a) => a.final?.pass).length,
  unverified: as.filter((a) => a.status === "unverified").length,
  beeOverrules: as.filter((a) => a.agreement === "bee-overrules").length,
});

export class CoachHub extends EventEmitter {
  readonly mode: "live" | "demo";
  readonly clock: () => number;
  readonly tz?: string;
  deck: HubDeck;
  attempts: Attempt[];
  sessions: StatSession[];
  prereg: TransferPrereg | null;
  readonly verifier: BeeVerifier;
  // `seq` tells openings apart (an attempt records the one it was made in); `openedAt` is also where
  // the voice flow's verdict view starts, so a card a session adopts starts again at "Say this".
  open: { cardId: string; openedAt: number; by: string; seq: number } | null = null;
  private openings = 0;
  // The lone card (no session) Bee just passed, closed by that pass: hub.state keeps showing its
  // verdict until another card opens, DRILL_IDLE_MS passes, or the local day turns.
  passedClose: { cardId: string; attemptId: string; at: number } | null = null;
  session: DrillSession | null = null;
  lastSession: DrillSession | null = null;
  private seq = 0;
  readonly recent: HubEvent[] = []; // last 50 events (GET /api/events/recent, contract examples)
  // This hub process: a new id on every start, so a screen can tell a restart (seq back at 1)
  // from a reconnect (hub.state carries it, with lastSeq).
  readonly bootId = `boot_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  private lastActivity = 0; // the drill's last sign of life: a card, an attempt, a verdict

  constructor(private opts: HubOptions) {
    super();
    this.mode = opts.mode;
    this.clock = opts.clock ?? Date.now;
    this.tz = opts.tz;
    this.deck = opts.deck;
    this.attempts = opts.attempts ?? [];
    // An attempt still waiting for Bee when the last hub stopped has no verifier waiting for it now:
    // close it as unverified (not counted) so "how did I do?" answers instead of saying "ask again" forever.
    for (const a of this.attempts) {
      if (a.status !== "pending_bee" && a.status !== "polling") continue;
      a.status = "unverified";
      a.counted = false;
      a.settledAt = this.clock();
      a.reason = "the hub restarted before Bee confirmed this attempt, so it doesn't count";
    }
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
      // Internal (unsequenced) events for the live engine (src/hub/live). Never published to a
      // surface: a non-wearer line carries a word count only, never text.
      onLine: (l) => this.emit("bee.line", l),
      onConversation: (c) => this.emit("bee.conversation", c),
      onTodoDeleted: (t) => this.emit("bee.todo-deleted", t),
    });
  }

  // Internal Bee events for the live engine: `bee.line` (BeeLine), `bee.conversation`
  // (BeeConversationEvent) and `bee.todo-deleted` ({id, completed, alarmAt}; never the to-do
  // text). Returns an unsubscribe function.
  onBee(handlers: { line?: (l: BeeLine) => void; conversation?: (c: BeeConversationEvent) => void; todoDeleted?: (t: { id: string; completed: boolean | null; alarmAt: number | null; receivedAt: number }) => void }): () => void {
    const pairs: [string, ((...args: any[]) => void) | undefined][] = [
      ["bee.line", handlers.line],
      ["bee.conversation", handlers.conversation],
      ["bee.todo-deleted", handlers.todoDeleted],
    ];
    for (const [ev, h] of pairs) if (h) this.on(ev, h);
    return () => {
      for (const [ev, h] of pairs) if (h) this.off(ev, h);
    };
  }

  get lastSeq() {
    return this.seq;
  }

  private touch() {
    this.lastActivity = this.clock();
  }

  // A drill nobody is driving is closed after DRILL_IDLE_MS: the session ends (session.ended) or a
  // lone open card closes, so an Alexa session that timed out does not keep live nudges muted
  // (drill-active) or keep matching everyday speech as attempts. Never while Bee is still checking an
  // attempt. Called from the hub server's tick. Returns true when it closed one. A lone card has no
  // contract topic for closing, so it emits the internal "state.changed" and the server re-sends
  // hub.state to every peer: the TV and phone drop the card instead of showing one that answers
  // "open a card first".
  expireIdle(idleMs = DRILL_IDLE_MS): boolean {
    this.expirePassed(idleMs);
    if (!this.session && !this.open) return false;
    if (this.verifier.pendingCount() > 0) return (this.touch(), false);
    if (this.clock() - this.lastActivity < idleMs) return false;
    if (this.session) this.endSession();
    else {
      const cardId = this.open!.cardId;
      this.open = null;
      this.verifier.closeCards();
      this.emit("state.changed", { reason: "card-expired", cardId });
    }
    return true;
  }

  // The lone card's pass is old news after DRILL_IDLE_MS, or on another day: "how did I do?" no longer
  // answers with it, and the screens are re-sent hub.state without it.
  private expirePassed(idleMs = DRILL_IDLE_MS): boolean {
    const p = this.passedClose;
    if (!p) return false;
    if (this.clock() - p.at < idleMs && localDate(p.at, this.tz) === this.today()) return false;
    this.passedClose = null;
    this.emit("state.changed", { reason: "pass-expired", cardId: p.cardId });
    return true;
  }

  // A drill is in progress: a session is running, a card was opened recently, or an attempt is
  // waiting for Bee. Live nudges are suppressed meanwhile (reason "drill-active"). A pure read: the
  // server tick does the idle expiry, so asking never ends a session.
  drillActive(recentMs = 5 * 60_000): boolean {
    if (this.session) return true;
    if (this.verifier.pendingCount() > 0) return true;
    return !!this.open && this.clock() - this.open.openedAt < recentMs;
  }

  get dataLabel() {
    return this.opts.dataLabel ?? (this.mode === "demo" ? "SYNTHETIC DEMO DATA (invented; not anyone's real results)" : "real data (gitignored)");
  }

  today() {
    return localDate(this.clock(), this.tz);
  }

  // Events

  // A sequenced event: every bridge peer, SSE and /api/events/recent. Only the contract's
  // SEQUENCED_TOPICS; room-scoped topics (practice.meters) go through ctx.broadcastToScreens.
  publish(topic: SequencedTopic, data: Record<string, unknown>): HubEvent {
    if ((ROOM_TOPICS as readonly string[]).includes(topic)) throw new Error(`${topic} is room-scoped: send it with broadcastToScreens, never publish`);
    if (!(SEQUENCED_TOPICS as readonly string[]).includes(topic)) throw new Error(`${topic} is not a contract topic (src/hub/contract.ts SEQUENCED_TOPICS)`);
    const ev: HubEvent = { topic, payload: { seq: ++this.seq, at: this.clock(), ...data } };
    this.recent.push(ev);
    if (this.recent.length > 50) this.recent.shift();
    this.emit("event", ev);
    return ev;
  }

  // live.window, throttled to at most one per LIVE_WINDOW_MIN_INTERVAL_MS per conversation. A
  // window that arrives too soon is held (the newest replaces an older held one) and published
  // when the interval ends, so the last state is never lost. Returns "sent" or "held".
  private liveWindows = new Map<string, { lastAt: number; held: LiveWindow | null; timer: NodeJS.Timeout | null }>();
  publishLiveWindow(window: LiveWindow, minIntervalMs = LIVE_WINDOW_MIN_INTERVAL_MS): "sent" | "held" {
    const s = this.liveWindows.get(window.conversationId) ?? { lastAt: -Infinity, held: null, timer: null };
    this.liveWindows.set(window.conversationId, s);
    const wait = s.lastAt + minIntervalMs - this.clock();
    if (wait <= 0 && !s.timer) {
      s.lastAt = this.clock();
      this.publish("live.window", { window });
      return "sent";
    }
    s.held = window;
    if (!s.timer) {
      // Real timers run on a monotonic clock and can fire a millisecond before the wall clock
      // says the interval is over: re-arm for the remainder, so the gap is never under it.
      const fire = () => {
        const left = s.lastAt + minIntervalMs - this.clock();
        if (left > 0) {
          s.timer = setTimeout(fire, left);
          s.timer.unref?.();
          return;
        }
        s.timer = null;
        const w = s.held;
        s.held = null;
        if (!w) return;
        s.lastAt = this.clock();
        this.publish("live.window", { window: w });
      };
      s.timer = setTimeout(fire, Math.max(0, wait));
      s.timer.unref?.();
    }
    return "held";
  }
  // Drop a held window (call it when the conversation ends, before conversation.ended).
  cancelLiveWindow(conversationId: string) {
    const s = this.liveWindows.get(conversationId);
    if (s?.timer) clearTimeout(s.timer);
    this.liveWindows.delete(conversationId);
  }
  // Clear every timer this hub owns (server close).
  dispose() {
    for (const id of [...this.liveWindows.keys()]) this.cancelLiveWindow(id);
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
    this.open = { cardId: c.id, openedAt: this.clock(), by: opts.by ?? "http", seq: ++this.openings };
    this.passedClose = null;
    this.touch();
    if (this.session && !this.session.cardIds.includes(c.id)) this.session.cardIds.push(c.id);
    this.verifier.openCard({ cardId: c.id, resay: c.resay, lang: c.lang, openedAt: this.open.openedAt, seq: this.open.seq });
    const v = this.view(c);
    this.publish("card.open", { card: v, by: this.open.by, sessionId: this.session?.id ?? null, deck: this.deckSummary() });
    return v;
  }

  private gradeFor(c: HubCard, text: string, habitText?: string) {
    return grade({ id: c.id, lang: c.lang, resay: c.resay, habit: habitOf(c), mustSay: mustSayOf(c) }, text, habitText);
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
      openingSeq: this.open?.seq,
    };
    this.attempts.push(a);
    this.dataVersion++;
    if (this.session) this.session.attemptIds.push(a.id);
    this.touch();
    this.persistAttempts();
    // Published before Bee is asked: expect() can match a buffered line and grade at once, and the
    // screens must see provisional before verified and graded.
    this.publish("attempt.provisional", { attempt: a, card: this.view(c) });
    this.verifier.expect({ attemptId: a.id, cardId, text: opts.text, speechStartMs: end - dur, speechEndMs: end });
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
    this.touch();
    // Grade only the attempt's own sentence(s); merged extra sentences are kept for display.
    const span = attemptSpan(c.resay, beeText, c.lang);
    if (a.bee) (a.bee.gradedText = span.graded), (a.bee.extraText = span.extra);
    const g = this.gradeFor(c, span.graded, span.habitText);
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
      a.bee = { text: v.beeText, utteranceIds: v.beeUtteranceIds, speakerScore: v.speakerScore, via: v.via!, latencyMs: v.latencyMs, coverage: v.coverage, replay: !!this.opts.replay, ...spanFields(v.beeSpan) };
      this.dataVersion++;
      a.reason = v.reason;
      this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "verified", via: v.via, speakerScore: v.speakerScore, latencyMs: v.latencyMs, beeText: v.beeText, replay: !!this.opts.replay, reason: v.reason });
      this.settle(a, c, v.beeText);
      this.publish("attempt.graded", { attempt: a, card: this.view(c), deck: this.deckSummary() });
      this.afterVerdict(a);
    } else {
      a.status = "unverified";
      a.settledAt = this.clock();
      a.reason = `not counted: ${v.reason}`;
      this.persistAttempts();
      this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "unverified", via: null, speakerScore: null, latencyMs: null, beeText: null, replay: !!this.opts.replay, reason: v.reason });
    }
    this.resendSummary(a);
    this.publishStats();
  }

  // Bee settled an attempt of a session that already ended (its summary counted it as pending):
  // send session.ended again with the updated summary, so every screen shows the same tally the hub
  // would give now (Bee's overrules included). Not once another drill has started: a re-sent
  // session.ended would close that drill's card on the screens.
  private resendSummary(a: Attempt) {
    const s = this.lastSession;
    if (!s || s.id !== a.sessionId || s.endedAt === null || this.session || this.open) return;
    this.publish("session.ended", { summary: this.sessionSummary(s) });
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
      bee: { text: b.text, utteranceIds: b.beeUtteranceIds, speakerScore: b.speakerScore, via: "stream", latencyMs: Math.round(now - b.speechEndMs), coverage: null, replay: !!this.opts.replay, ...spanFields(b.beeSpan ?? { fromMs: b.speechStartMs, toMs: b.speechEndMs, conversationId: null }) },
      final: null,
      agreement: null,
      reason: "Bee tagged the wearer saying the open card (no phone/Alexa preview)",
      box: null,
      openingSeq: b.openingSeq,
    };
    this.attempts.push(a);
    this.dataVersion++;
    if (this.session) this.session.attemptIds.push(a.id);
    this.publish("attempt.verified", { attemptId: a.id, cardId: a.cardId, status: "verified", via: "stream", speakerScore: b.speakerScore, latencyMs: a.bee!.latencyMs, beeText: b.text, replay: !!this.opts.replay, reason: a.reason });
    this.settle(a, c, b.text);
    this.publish("attempt.graded", { attempt: a, card: this.view(c), deck: this.deckSummary() });
    this.afterVerdict(a);
    this.publishStats();
  }

  // A counted PASS ends that card's attempts: Bee stops grading the wearer's later lines against it
  // (they are everyday speech, not retries). A lone card (no session) is closed, and every screen is
  // re-sent hub.state, which still carries the passing attempt; in a session the card stays on screen
  // until "next" (the voice flows advance on the verdict). After a FAIL nothing closes: say it again.
  private afterVerdict(a: Attempt) {
    if (!a.counted || !a.final?.pass) return;
    this.verifier.markPassed(a.cardId, a.openingSeq);
    // only the opening the attempt was made in: a late verdict from an earlier one leaves a new card
    // alone, even one opened in the same millisecond
    if (this.session || !this.inOpening(a)) return;
    this.open = null;
    this.verifier.closeCards();
    this.passedClose = { cardId: a.cardId, attemptId: a.id, at: this.clock() };
    this.emit("state.changed", { reason: "card-passed", cardId: a.cardId });
  }

  // The attempt was made in the card opening that is open now.
  private inOpening(a: Attempt): boolean {
    return !!this.open && a.cardId === this.open.cardId && a.openingSeq != null && a.openingSeq === this.open.seq;
  }

  // Drill sessions (driven by the Alexa MCP tools; mirrored on the TV)

  // A card already open outside a session (the TV, the phone or the API opened it) becomes the
  // session's first card instead of being replaced: the wearer may be saying it right now, and Bee
  // keeps matching lines against that opening. An attempt on it still with Bee joins the session, so
  // its verdict counts there. The voice flow's view starts again at the session (openedAt), so
  // start_drill says "Say this", not an earlier attempt's verdict. card.open is sent again so the
  // screens show it under the session.
  startSession(opts: { by?: string; size?: number } = {}): { session: DrillSession; card: CardView | null } {
    const adopt = !this.session && this.open && this.card(this.open.cardId) ? this.card(this.open.cardId)! : null;
    this.passedClose = null;
    if (this.session) this.endSession();
    const now = this.clock();
    this.session = { id: newId("ses", now), by: opts.by ?? "http", startedAt: now, endedAt: null, size: Math.max(1, Math.min(10, opts.size ?? 3)), cardIds: [], attemptIds: [] };
    this.touch();
    this.publish("session.started", { session: this.session });
    let card: CardView | null;
    if (adopt) {
      this.session.cardIds.push(adopt.id);
      for (const a of this.attempts)
        if (a.sessionId === null && this.inOpening(a) && (a.status === "pending_bee" || a.status === "polling")) {
          a.sessionId = this.session.id;
          this.session.attemptIds.push(a.id);
        }
      this.open!.openedAt = now;
      card = this.view(adopt);
      this.publish("card.open", { card, by: this.session.by, sessionId: this.session.id, deck: this.deckSummary() });
    } else card = this.openCard({ by: this.session.by });
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
    // An attempt shows when it was made in this opening and made (or settled) since the view began.
    const from = this.open?.openedAt ?? Infinity;
    const shown = (a: Attempt) => this.inOpening(a) && (a.createdAt >= from || (a.settledAt != null && a.settledAt >= from));
    const last = this.open ? [...this.attempts].reverse().find(shown) : undefined;
    const openCard = this.open ? this.card(this.open.cardId) : undefined;
    let state: "idle" | "card_open" | AttemptStatus = this.open ? "card_open" : "idle";
    if (last) state = last.status;
    const narration: Record<string, string> = {
      idle: "You're not practising right now. Say quiz me to get your first line.",
      card_open: openCard ? `Say this: "${openCard.resay}"` : "",
      pending_bee: "Got it. I'm checking with Bee, which can take up to about twenty seconds to hear it. Ask me how you did in a moment.",
      polling: "Bee's live feed was quiet, so I'm checking your conversation directly.",
      graded: last?.final ? (last.final.pass ? "Nice, Bee heard it. That's a pass." : `Not yet: ${failReason(last.final.grade)}. Say it again.`) : "",
      unverified: "Bee didn't catch that one, so it doesn't count. Say it again.",
    };
    const lastShown = last ?? null;
    // The lone card Bee just passed is closed; its verdict stays the last attempt until a card opens
    // (or the pass expires: expirePassed).
    this.expirePassed();
    const passed = !this.open && !this.session && this.passedClose ? (this.attempts.find((a) => a.id === this.passedClose!.attemptId) ?? null) : null;
    if (passed) narration.idle = "Nice, Bee heard it. That's a pass. Say quiz me for your next line.";
    else if (state === "graded" && this.session && last?.final?.pass) narration.graded += " Say next for the next line.";
    return {
      state,
      narration: narration[state] ?? "",
      verdictReady: state === "graded" || state === "unverified",
      retryAfterMs: lastShown ? this.retryAfterMs(lastShown) : null,
      session: this.session,
      openCard: openCard ? this.view(openCard) : null,
      lastAttempt: lastShown ?? passed,
      deck: this.deckSummary(),
      practiceToday: this.practiceToday(),
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
      graded: a.final?.pass ? "Nice, Bee heard it. That's a pass." : `Not yet: ${a.final ? failReason(a.final.grade) : "try again"}. Say it again.`,
      unverified: "Bee didn't catch that one, so it doesn't count. Say it again.",
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
    const ss = selectSessions(this.everydaySessions(), range, now, this.tz, source, range.kind === "session" ? undefined : this.sessionsFor(source));
    const today = this.today();
    // Drill counts belong to a period (today, the week, all time). A conversation or meeting range has
    // no drill period, so its practice block is null rather than every drill ever.
    const inRange = (t: number) => {
      const d = localDate(t, this.tz);
      if (range.kind === "today") return d === today;
      if (range.kind === "week") return d >= selectFrom(today);
      return true;
    };
    const as = range.kind === "session" ? null : this.attempts.filter((a) => inRange(a.createdAt));
    return {
      dataLabel: this.dataLabel,
      synthetic: this.mode === "demo",
      range: range.kind === "session" ? (range.label ?? `session:${range.id}`) : range.kind,
      source,
      sources: sourceBreakdown(ss, this.tz),
      sessions: ss.map((s) => ({ id: s.id, kind: s.kind, date: localDate(s.startMs, this.tz), words: habitRates([s]).words, synthetic: !!s.synthetic })),
      habits: habitRates(ss),
      talk: talkSummary(ss),
      practice: as && practiceCounts(as),
      drilledVsNextSession: nextSessionDeltas(this.sessionsFor(source), this.drillEvents(), this.tz, source, true).map((d) => ({
        ...d,
        preregistered: !!this.prereg && isRegistered(d.habit, new Set([...this.prereg.drilled, ...this.prereg.control].map((h) => h.habit))),
        note: "one session either side of the first drill: a glance, not a test (see /api/transfer)",
      })),
    };
  }

  // Sessions the live ingest (ingest.ts) picked up while the hub runs. A session id the hub already
  // has (an offline file, or an earlier ingest) is left as it is. When anything was added, the stats
  // and the transfer are recomputed for everyone: stats.updated makes the screens refetch both, and
  // "how am I doing?" reads them on every ask. Returns how many sessions were added.
  addSessions(ss: StatSession[]): number {
    const have = new Set(this.sessions.map((s) => s.id));
    const added = ss.filter((s) => !have.has(s.id) && !!have.add(s.id));
    if (!added.length) return 0;
    this.sessions = [...this.sessions, ...added].sort((a, b) => a.startMs - b.startMs);
    this.dataVersion++;
    this.publishStats();
    return added.length;
  }

  transfer(source: SourceSel = "bee") {
    if (!this.prereg) return null;
    return { dataLabel: this.dataLabel, ...transfer({ sessions: this.sessionsFor(source), selected: true, prereg: this.prereg, preregPath: this.opts.preregPath, drills: this.drillEvents(), nowMs: this.clock(), tz: this.tz, source }) };
  }

  // The sessions with every drill line left out (stats.ts withoutDrillLines, by id, time and text):
  // what "non-drill" means everywhere. /api/stats habits (and so the live baseline), the settings
  // view, the next-session glance and the transfer all count these.
  everydaySessions(): StatSession[] {
    return this.views().everyday;
  }

  // The everyday sessions a source counts (stats.ts fromSource: with "all", a meeting both heard
  // counted once). Every stats view, the transfer and the settings view read these.
  sessionsFor(source: SourceSel): StatSession[] {
    const v = this.views();
    return (v.bySource[source] ??= fromSource(v.everyday, source));
  }

  // The drill lines, the everyday sessions and each source's selection, computed once per version of
  // the data. Every screen refetches several views on each stats.updated; they share one computation.
  // The version is a counter, checked in O(1): bumped where the hub changes what a drill span is made
  // from (an attempt added, Bee's text set on one) and on addSessions. A session list or attempt list
  // replaced from outside, or an attempt pushed onto it, is seen by identity and length. Sessions are
  // replaced, never edited in place; call dataChanged() after editing a session or an attempt directly.
  private dataVersion = 0;
  dataChanged(): void {
    this.dataVersion++;
  }
  private viewCache: { sessions: StatSession[]; attempts: Attempt[]; count: number; version: number; drill: DrillLines; everyday: StatSession[]; bySource: Partial<Record<SourceSel, StatSession[]>> } | null = null;
  private views() {
    const c = this.viewCache;
    if (c && c.sessions === this.sessions && c.attempts === this.attempts && c.count === this.attempts.length && c.version === this.dataVersion) return c;
    const drill = this.computeDrillLines();
    return (this.viewCache = { sessions: this.sessions, attempts: this.attempts, count: this.attempts.length, version: this.dataVersion, drill, everyday: withoutDrillLines(this.sessions, drill), bySource: {} });
  }

  drillLines(): DrillLines {
    return this.views().drill;
  }

  // The Bee lines that were drill attempts, which are not everyday speech: by utterance id, and by
  // time and text for the final transcript's own ids (stats.ts DrillLines). An attempt stored without
  // its spoken window gets one from what it has: its speech end, back 30 s. An attempt Bee has not
  // confirmed (unverified, or still pending or polling) was still said: Bee's final transcript may
  // hold it later, so its provisional text and speech end make a span too (any conversation; the
  // text match guards against everyday lines).
  private computeDrillLines(): DrillLines {
    const keys = new Set<string>();
    const spans: DrillSpan[] = [];
    for (const a of this.attempts) {
      const b = a.bee;
      if (!b) {
        const p = a.provisional;
        if (p?.text && Number.isFinite(p.speechEndAt)) spans.push({ session: null, fromMs: p.speechEndAt - 30_000, toMs: p.speechEndAt, text: p.text });
        continue;
      }
      for (const id of b.utteranceIds ?? []) keys.add(`u:${id}`);
      const end = b.spokenToMs ?? a.provisional?.speechEndAt ?? a.createdAt - (b.latencyMs ?? 0);
      spans.push({ session: b.conversationId ?? null, fromMs: b.spokenFromMs ?? end - 30_000, toMs: end, text: b.text });
    }
    return { keys, spans };
  }

  // Today's drill tally (the hub's local day), without computing the rest of the stats. Every
  // sessionState() asks for it, so today's attempts are kept as they are found: each stored attempt's
  // date is read once a day, and a call with no new attempt reads none.
  private todays: { day: string; from: Attempt[]; scanned: number; picked: Attempt[] } | null = null;
  practiceToday(): PracticeCounts {
    const today = this.today();
    let c = this.todays;
    if (!c || c.day !== today || c.from !== this.attempts || c.scanned > this.attempts.length) c = this.todays = { day: today, from: this.attempts, scanned: 0, picked: [] };
    for (; c.scanned < this.attempts.length; c.scanned++) {
      const a = this.attempts[c.scanned]!;
      if (localDate(a.createdAt, this.tz) === today) c.picked.push(a);
    }
    return practiceCounts(c.picked);
  }

  // The day the screens' tally was last published for. When the local day turns, publish again, so
  // a TV left on overnight does not show yesterday's drills as today's. Checked at most once a second.
  private statsDay: string | null = null;
  private dayCheckedAt = -Infinity;
  rollDay(): boolean {
    const now = this.clock();
    if (now - this.dayCheckedAt < 1000) return false;
    this.dayCheckedAt = now;
    const today = this.today();
    if (this.statsDay === null) this.statsDay = today;
    if (today === this.statsDay) return false;
    // The day is marked before the stats are computed: if that throws, it is tried again tomorrow
    // (or with the next settled attempt), not on every tick for the rest of the day.
    this.statsDay = today;
    this.expirePassed();
    this.publishStats();
    return true;
  }

  // The server's once-a-tick housekeeping. Each job runs on its own, so one that throws never
  // skips the others (purge first: a hung poll must not keep other speakers' text in memory), and
  // a job that keeps failing with the same error is logged once, not on every tick.
  private tickErrors = new Map<string, string>();
  housekeep(log: (event: string, data?: Record<string, unknown>) => void): void {
    const jobs: [string, () => unknown][] = [
      ["purge", () => this.verifier.purge()],
      ["expire-idle", () => this.expireIdle()],
      ["roll-day", () => this.rollDay()],
    ];
    for (const [job, run] of jobs) {
      try {
        run();
        this.tickErrors.delete(job);
      } catch (err) {
        const error = String((err as Error)?.message ?? err);
        if (this.tickErrors.get(job) !== error) log("hub.tick-error", { job, error });
        this.tickErrors.set(job, error);
      }
    }
  }

  publishStats() {
    const week = this.stats({ kind: "week" });
    const t = this.transfer();
    const today = this.practiceToday();
    this.statsDay = this.today();
    this.publish("stats.updated", {
      dataLabel: this.dataLabel,
      practiceToday: today,
      weekPer100: { words: week.habits.words, hedges: week.habits.hedges.per100, vague: week.habits.vague.per100, fillers: week.habits.fillers.per100, restarts: week.habits.restarts.per100 },
      transferHeadline: t?.headline ?? null,
      deck: this.deckSummary(),
    });
  }

  // Persistence

  // A failed write (full or read-only disk) is reported once per kind and the hub carries on in
  // memory: a drill must still settle and reach the screens.
  private persistFailed = new Set<string>();
  private persistSafe(kind: string, f: () => void) {
    try {
      f();
      this.persistFailed.delete(kind);
    } catch (err) {
      if (!this.persistFailed.has(kind)) console.error(JSON.stringify({ t: new Date().toISOString(), event: "hub.persist-error", kind, error: String((err as Error)?.message ?? err) }));
      this.persistFailed.add(kind);
    }
  }
  persistDeck() {
    const p = this.opts.deckPath;
    if (p) this.persistSafe("deck", () => saveHubDeck(p, this.deck));
  }
  persistAttempts() {
    const p = this.opts.attemptsPath;
    if (p) this.persistSafe("attempts", () => writeJsonAtomic(p, { attempts: this.attempts }));
  }
}

const spanFields = (s: BeeSpan | null | undefined) => (s ? { spokenFromMs: s.fromMs, spokenToMs: s.toMs, conversationId: s.conversationId == null ? null : String(s.conversationId) } : {});

const selectFrom = (today: string) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
};

export function loadAttempts(path: string): Attempt[] {
  return readJsonSafe<{ attempts?: Attempt[] }>(path, () => ({ attempts: [] })).attempts ?? [];
}

export { parseSource };
