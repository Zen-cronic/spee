// Speaking Mirror state. Pure: no React, no I/O, no clock reads (every action carries `now`), so it
// runs the same on the web TV, on Vega and in the unit tests (test/mirror-reducer.test.ts).
//
// Sequenced hub events are applied in `seq` order and duplicates are dropped. An event that
// arrives ahead of a gap waits in `pending` until the gap fills or GAP_WAIT_MS passes (a `tick`
// then applies it and counts the gap). A new `hub.state` (a join or a reconnect) rebases the
// sequence: anything at or below its `lastSeq` is already in the snapshot. A different `bootId`
// means the hub restarted and its seq began again at 1, so the old high-water mark is dropped (an
// older hub without these fields keeps the previous rule: at or below the last applied seq is a
// duplicate).
//
// Room frames (`practice.meters`) carry no seq: they are applied as they arrive and only the last
// PRACTICE_HISTORY frames are kept, in memory.
//
// Screens switch on events: a drill event shows the drill, a live-conversation event shows the
// live window (unless a drill or a practice take is in progress), meters show practice,
// `recap.ready` raises the recap overlay, and `mirror.focus` shows whatever a peer asked for (a
// phone's focus only on its own room's screen).
import type {
  CardView,
  ConversationEnded,
  DeckSummary,
  HubState,
  LiveBaseline,
  LiveMode,
  LiveState,
  LiveWindow,
  MirrorFocus,
  MirrorView,
  Nudge,
  NudgeSkipped,
  PracticeCounts,
  PracticeMeters,
  PracticeSummary,
  Recap,
  SessionSummary,
  SettingTag,
} from '../contract';
import { gradeFailure, type GradeFailure } from './format';

export type ScreenView = MirrorView | 'pair';
export const SCREEN_VIEWS: ScreenView[] = ['week', 'transfer', 'live', 'practice', 'pair'];

export const GAP_WAIT_MS = 1500;
export const MAX_PENDING = 64;
export const PRACTICE_HISTORY = 50; // 5 s at 10 Hz
export const PRACTICE_ACTIVE_MS = 3000;
export const RECAP_VISIBLE_MS = 30_000;
export const KEEP_NUDGES = 5;
// Round over stays on Live this long after the round ended (the moment to film), then Live's
// drill panel goes back to the idle panel with the lines due.
export const ROUND_OVER_MS = 15 * 60_000;

export type DrillStage = 'idle' | 'card' | 'provisional' | 'checking' | 'verified' | 'unverified' | 'graded';

export interface DrillState {
  sessionId: string | null;
  card: CardView | null;
  deck: DeckSummary | null;
  attemptId: string | null;
  stage: DrillStage;
  provisional: { source: string; text: string; pass: boolean; reasons: string[] } | null;
  checking: { reason: string } | null;
  verified: { status: 'verified' | 'unverified'; via: string | null; speakerScore: number | null; latencyMs: number | null; beeText: string | null; replay: boolean; reason: string } | null;
  graded: { pass: boolean; reasons: string[]; failure: GradeFailure | null; agreement: string | null; counted: boolean; boxFrom: number | null; boxTo: number | null; dueAfter: string | null; beeText: string | null } | null;
  summary: SessionSummary | null;
  overAt: number | null; // when this screen got the round's end (its clock): Round over shows until ROUND_OVER_MS after
  overDone: string | null; // a session whose Round over timed out: a summary the hub re-sends for it never brings it back
  overCard: string | null; // the last line opened when the round ended (closed if nobody said it): Round over's "last line"
}

export interface LiveSlice {
  mode: LiveMode | null;
  baseline: LiveBaseline | null; // the wearer's usual rates (GET /api/live), shown dimmed between conversations
  conversationId: string | null;
  startedAt: number | null;
  window: LiveWindow | null;
  ended: ConversationEnded | null;
  nudges: Nudge[]; // newest first
  skips: NudgeSkipped[]; // newest first
}

export interface MeterPoint {
  t: number;
  rmsDbfs: number;
  pitchHz: number | null;
}
export interface PracticeSlice {
  takeId: string | null;
  from: string | null;
  latest: PracticeMeters | null;
  history: MeterPoint[];
  caption: string | null;
  lastFrameAt: number | null; // local clock
  frames: number;
  summary: PracticeSummary | null;
}

export interface SeqEvent {
  topic: string;
  payload: Record<string, any> & { seq: number; at?: number };
}

export interface MirrorState {
  bootId: string | null; // the hub process the sequence belongs to (hub.state)
  room: string | null; // this screen's bridge room (welcome.code): practice summaries of other rooms are ignored
  restarts: number; // hub restarts seen (a new bootId)
  lastSeq: number | null;
  floorSeq: number; // highest seq applied before the last rebase
  pending: SeqEvent[]; // ahead of a gap, ascending seq
  pendingSince: number | null;
  applied: number;
  duplicates: number;
  gaps: number;
  hubMode: 'live' | 'demo' | null;
  dataLabel: string | null;
  synthetic: boolean;
  replay: boolean; // a Bee replay event was seen (demo)
  view: ScreenView;
  viewBy: string | null;
  viewReason: string | null;
  drill: DrillState;
  live: LiveSlice;
  practice: PracticeSlice;
  recap: Recap | null; // the recap the overlay shows (the newest, or one a focus asked for)
  latestRecap: Recap | null; // the recap of the most recent conversation (by its end), for Live's "Last conversation"
  recapVisible: boolean;
  recapShownAt: number | null;
  recapWanted: string | null; // a focus asked for a recap id we do not hold yet
  statsVersion: number; // bumped on stats.updated: refetch stats and transfer
  practiceToday: PracticeCounts | null; // today's drill tally: the hub.state snapshot, then stats.updated (sent again when the hub's day turns)
  lastTopic: string | null;
}

export type MirrorAction =
  | { type: 'hubState'; state: HubState; now: number }
  | { type: 'event'; event: SeqEvent; now: number }
  | { type: 'meters'; frames: PracticeMeters[]; now: number }
  | { type: 'tick'; now: number }
  | { type: 'show'; view: ScreenView }
  | { type: 'room'; code: string | null }
  | { type: 'recapFetched'; ok: boolean }
  | { type: 'dismissRecap' }
  | { type: 'liveState'; live: LiveState }
  | { type: 'recap'; recap: Recap; show: boolean; now: number }
  // the wearer changed a conversation's setting (the chip on the recap or Live): every held recap of it shows it
  | { type: 'recapSetting'; conversationId: string; setting: SettingTag | null; now: number }
  | { type: 'recapWording'; recap: Recap };

/** One step of the Live tracker: you said it, checked by Bee, graded. */
export type StepState = 'todo' | 'now' | 'done' | 'bad' | 'pass';

/**
 * The tracker's three steps for a drill. "You said it" is done once any attempt exists: a phone or
 * Alexa preview, or a line Bee heard on its own (a Bee-only attempt has no preview).
 */
export function drillSteps(d: Pick<DrillState, 'stage' | 'provisional' | 'verified' | 'graded'>): { heard: StepState; checked: StepState; graded: StepState } {
  const st = d.stage;
  const v = d.verified;
  const g = d.graded;
  const attempted = !!(d.provisional || v || g) || (st !== 'card' && st !== 'idle');
  return {
    heard: attempted ? 'done' : st === 'card' ? 'now' : 'todo',
    checked: st === 'unverified' ? 'bad' : v?.status === 'verified' || g ? 'done' : st === 'provisional' || st === 'checking' ? 'now' : 'todo',
    graded: g ? (g.pass ? 'pass' : 'bad') : st === 'verified' ? 'now' : 'todo',
  };
}

/**
 * What Live's drill panel shows: no line yet, a line to say, Bee checking, the result, or the
 * round over (the session ended: its tally, with the last line's result kept beside it, and a
 * verdict Bee settles after the end still lands there). Round over lasts ROUND_OVER_MS (the tick
 * clears it), then the panel is idle again with the lines due.
 */
export type DrillPhase = 'idle' | 'line' | 'checking' | 'result' | 'over';
export function drillPhase(d: Pick<DrillState, 'card' | 'stage' | 'summary'>): DrillPhase {
  if (d.summary) return 'over';
  if (!d.card) return 'idle';
  if (d.stage === 'graded' || d.stage === 'unverified') return 'result';
  if (d.stage === 'provisional' || d.stage === 'checking' || d.stage === 'verified') return 'checking';
  return 'line';
}

const emptyDrill = (): DrillState => ({ sessionId: null, card: null, deck: null, attemptId: null, stage: 'idle', provisional: null, checking: null, verified: null, graded: null, summary: null, overAt: null, overDone: null, overCard: null });
const emptyPractice = (): PracticeSlice => ({ takeId: null, from: null, latest: null, history: [], caption: null, lastFrameAt: null, frames: 0, summary: null });

export function initialMirror(view: ScreenView = 'week'): MirrorState {
  return {
    bootId: null,
    room: null,
    restarts: 0,
    lastSeq: null,
    floorSeq: 0,
    pending: [],
    pendingSince: null,
    applied: 0,
    duplicates: 0,
    gaps: 0,
    hubMode: null,
    dataLabel: null,
    synthetic: false,
    replay: false,
    view,
    viewBy: null,
    viewReason: null,
    drill: emptyDrill(),
    live: { mode: null, baseline: null, conversationId: null, startedAt: null, window: null, ended: null, nudges: [], skips: [] },
    practice: emptyPractice(),
    recap: null,
    latestRecap: null,
    recapVisible: false,
    recapShownAt: null,
    recapWanted: null,
    statsVersion: 0,
    practiceToday: null,
    lastTopic: null,
  };
}

const isSynthetic = (label: string | null | undefined) => !!label && /synthetic/i.test(label);

// What Back does: close the recap, else go home to the week, else (already home) leave the app. The
// platform handles 'exit' (Fire TV and Vega guideline: Back on the root screen exits).
export function backAction(s: Pick<MirrorState, 'recapVisible' | 'view'>): 'dismissRecap' | 'home' | 'exit' {
  if (s.recapVisible) return 'dismissRecap';
  return s.view === 'week' ? 'exit' : 'home';
}

export const drillInProgress = (d: DrillState) => d.stage === 'card' || d.stage === 'provisional' || d.stage === 'checking' || d.stage === 'verified';
export const practiceActive = (p: PracticeSlice, now: number) => p.lastFrameAt !== null && now - p.lastFrameAt < PRACTICE_ACTIVE_MS;

export function mirrorReducer(s: MirrorState, a: MirrorAction): MirrorState {
  switch (a.type) {
    case 'hubState':
      return onHubState(s, a.state);
    case 'event':
      return onSeqEvent(s, a.event, a.now);
    case 'meters':
      return onMeters(s, a.frames, a.now);
    case 'tick':
      return onTick(s, a.now);
    case 'show':
      return a.view === s.view && !s.recapVisible ? s : { ...s, view: a.view, viewBy: 'remote', viewReason: null, recapVisible: false };
    case 'dismissRecap':
      return s.recapVisible ? { ...s, recapVisible: false } : s;
    case 'room':
      return a.code === s.room ? s : { ...s, room: a.code };
    case 'recapFetched':
      // a finished fetch (found or not) clears the request, so the next "show my recap" fetches again
      return s.recapWanted === null ? s : { ...s, recapWanted: null };
    case 'liveState':
      // The socket's live.mode wins over a refetch built before it (an older changedAt): a slow
      // GET /api/live must not turn live coaching back on after it expired.
      return { ...s, live: { ...s.live, mode: newerMode(s.live.mode, a.live.mode), baseline: a.live.baseline ?? s.live.baseline, window: s.live.window ?? a.live.conversation, conversationId: s.live.conversationId ?? a.live.conversation?.conversationId ?? null, nudges: s.live.nudges.length ? s.live.nudges : a.live.recentNudges.slice(0, KEEP_NUDGES), skips: s.live.skips.length ? s.live.skips : a.live.recentSkips.slice(0, KEEP_NUDGES) }, dataLabel: s.dataLabel ?? a.live.dataLabel, synthetic: s.synthetic || a.live.synthetic };
    case 'recapSetting': {
      const set = (r: Recap | null) => (r && r.conversationId === a.conversationId ? { ...r, setting: a.setting } : r);
      if (s.recap?.conversationId !== a.conversationId && s.latestRecap?.conversationId !== a.conversationId) return s;
      // changing it keeps the recap up: its 30 s start again
      return { ...s, recap: set(s.recap), latestRecap: set(s.latestRecap), recapShownAt: s.recapVisible && s.recap?.conversationId === a.conversationId ? a.now : s.recapShownAt };
    }
    case 'recapWording': {
      // The hub's served recap after a setting change: its headline and narration say where the usual
      // came from ("1.4 from work talk"). Taken only while the chip still shows that same setting, so
      // an answer to an older press never replaces newer words.
      const word = (r: Recap | null) => (r && r.id === a.recap.id && r.setting?.setting === a.recap.setting?.setting ? { ...r, headline: a.recap.headline, narration: a.recap.narration } : r);
      const recap = word(s.recap);
      const latestRecap = word(s.latestRecap);
      return recap === s.recap && latestRecap === s.latestRecap ? s : { ...s, recap, latestRecap };
    }
    case 'recap':
      if (s.recap && s.recap.id === a.recap.id && !a.show) return s;
      return { ...s, recap: a.recap, latestRecap: newerRecap(s.latestRecap, a.recap), recapVisible: a.show || (s.recapVisible && s.recap?.id === a.recap.id), recapShownAt: a.show ? a.now : s.recapShownAt, recapWanted: s.recapWanted === a.recap.id || s.recapWanted === 'latest' ? null : s.recapWanted };
  }
}

// The recap of the later conversation (by when it ended); a tie keeps the one already held.
export const newerRecap = (have: Recap | null, got: Recap): Recap => (!have || got.endedAt > have.endedAt || got.id === have.id ? got : have);
// The live mode with the later change; a refetch with the same change refreshes the counts.
export const newerMode = (have: LiveMode | null, got: LiveMode): LiveMode => (!have || (got.changedAt ?? 0) >= (have.changedAt ?? 0) ? got : have);

function onHubState(s: MirrorState, h: HubState): MirrorState {
  const d: DrillState = { ...emptyDrill(), sessionId: h.session?.id ?? null, card: h.openCard, deck: h.deck, stage: h.openCard ? 'card' : 'idle' };
  const la = h.lastAttempt;
  if (la && h.openCard && la.cardId === h.openCard.id) Object.assign(d, drillFromAttempt(la));
  // A lone card Bee passed is closed (the hub re-sends hub.state): the snapshot carries that pass, so
  // the screen showing the card keeps its verdict instead of dropping to "No drill running".
  else if (la && !h.openCard && !h.session && la.status === 'graded' && la.final?.pass && s.drill.card?.id === la.cardId) Object.assign(d, { card: s.drill.card }, drillFromAttempt(la));
  const restarted = !!h.bootId && !!s.bootId && h.bootId !== s.bootId;
  const floorSeq = typeof h.lastSeq === 'number' && Number.isFinite(h.lastSeq) ? h.lastSeq : restarted ? 0 : Math.max(s.floorSeq, s.lastSeq ?? 0);
  return {
    ...s,
    bootId: h.bootId ?? s.bootId,
    restarts: s.restarts + (restarted ? 1 : 0),
    lastSeq: null,
    floorSeq,
    pending: [],
    pendingSince: null,
    // the old hub's conversation is gone with it
    live: restarted ? { ...s.live, conversationId: null, startedAt: null, window: null, ended: null } : s.live,
    hubMode: h.mode,
    dataLabel: h.dataLabel,
    synthetic: isSynthetic(h.dataLabel) || h.mode === 'demo',
    replay: s.replay || !!h.bee?.replay,
    // In the same snapshot as lastSeq, so a later stats.updated (seq above it) always wins.
    practiceToday: h.practiceToday ?? s.practiceToday,
    drill: d,
  };
}

// A verdict for a card other than the one on screen: an attempt Bee was still checking when the
// next card opened. The open card stays; the hub re-sends the session summary when it settles one.
// After the round, the line on screen is the last one opened (overCard), also when it was closed
// unsaid: a verdict Bee settles later for an earlier line never reads as the last line.
const otherCard = (s: MirrorState, cardId: unknown) => typeof cardId === 'string' && (s.drill.card ? cardId !== s.drill.card.id : !!s.drill.summary && cardId !== s.drill.overCard);

function drillFromAttempt(at: any): Partial<DrillState> {
  const out: Partial<DrillState> = { attemptId: at.id };
  if (at.provisional) out.provisional = { source: at.provisional.source, text: at.provisional.text, pass: !!at.provisional.grade?.pass, reasons: at.provisional.grade?.reasons ?? [] };
  if (at.status === 'pending_bee') out.stage = 'provisional';
  if (at.status === 'polling') (out.stage = 'checking'), (out.checking = { reason: at.reason ?? '' });
  if (at.status === 'unverified') out.stage = 'unverified';
  if (at.bee) out.verified = { status: 'verified', via: at.bee.via ?? null, speakerScore: at.bee.speakerScore ?? null, latencyMs: at.bee.latencyMs ?? null, beeText: at.bee.gradedText ?? at.bee.text ?? null, replay: !!at.bee.replay, reason: at.reason ?? '' };
  if (at.status === 'graded' && at.final) {
    out.stage = 'graded';
    out.graded = { pass: !!at.final.pass, reasons: at.final.grade?.reasons ?? [], failure: at.final.pass ? null : gradeFailure(at.final.grade), agreement: at.agreement ?? null, counted: !!at.counted, boxFrom: at.box?.from ?? null, boxTo: at.box?.to ?? null, dueAfter: at.box?.dueAfter ?? null, beeText: at.bee?.gradedText ?? at.bee?.text ?? null };
  }
  return out;
}

function onSeqEvent(s: MirrorState, ev: SeqEvent, now: number): MirrorState {
  const seq = ev.payload?.seq;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return s;
  if ((s.lastSeq !== null && seq <= s.lastSeq) || (s.lastSeq === null && seq <= s.floorSeq) || s.pending.some((p) => p.payload.seq === seq)) return { ...s, duplicates: s.duplicates + 1 };
  if (s.lastSeq === null || seq === s.lastSeq + 1) return drain(apply(s, ev, now), now);
  const pending = [...s.pending, ev].sort((x, y) => x.payload.seq - y.payload.seq);
  const next = { ...s, pending, pendingSince: s.pendingSince ?? now };
  return pending.length > MAX_PENDING ? flushGap(next, now) : next;
}

function drain(s: MirrorState, now: number): MirrorState {
  let cur = s;
  while (cur.pending.length && cur.lastSeq !== null && cur.pending[0]!.payload.seq === cur.lastSeq + 1) {
    const [head, ...rest] = cur.pending;
    cur = apply({ ...cur, pending: rest }, head!, now);
  }
  if (!cur.pending.length && cur.pendingSince !== null) cur = { ...cur, pendingSince: null };
  return cur;
}

// Give up on a gap: apply what is waiting, in order, and count the gap.
function flushGap(s: MirrorState, now: number): MirrorState {
  let cur: MirrorState = { ...s, pending: [], pendingSince: null, gaps: s.gaps + 1 };
  for (const ev of s.pending) cur = apply(cur, ev, now);
  return cur;
}

function onTick(s: MirrorState, now: number): MirrorState {
  let cur = s;
  if (cur.pending.length && cur.pendingSince !== null && now - cur.pendingSince >= GAP_WAIT_MS) cur = flushGap(cur, now);
  if (cur.recapVisible && cur.recapShownAt !== null && now - cur.recapShownAt >= RECAP_VISIBLE_MS) cur = { ...cur, recapVisible: false };
  // an old Round over yields to the idle panel, with the lines due (the deck stays)
  const d = cur.drill;
  if (d.summary && d.overAt !== null && now - d.overAt >= ROUND_OVER_MS) cur = { ...cur, drill: { ...emptyDrill(), sessionId: d.sessionId, deck: d.deck, overDone: d.summary.sessionId } };
  return cur;
}

// The view a live-conversation event switches to: not while a drill or a take is in progress.
function liveView(s: MirrorState, now: number): ScreenView {
  if (drillInProgress(s.drill) && s.view === 'drill') return 'drill';
  if (practiceActive(s.practice, now) && s.view === 'practice') return 'practice';
  return 'live';
}

function apply(s0: MirrorState, ev: SeqEvent, now: number): MirrorState {
  const p = ev.payload;
  const s: MirrorState = { ...s0, lastSeq: p.seq, applied: s0.applied + 1, lastTopic: ev.topic };
  if (p.replay === true || p.attempt?.bee?.replay === true || p.window?.replay === true) s.replay = true;
  switch (ev.topic) {
    case 'session.started':
      return { ...s, drill: { ...emptyDrill(), deck: s.drill.deck, sessionId: p.session?.id ?? null }, view: 'drill', viewBy: p.session?.by ?? null, viewReason: 'drill started' };
    case 'card.open':
      return { ...s, drill: { ...emptyDrill(), sessionId: p.sessionId ?? s.drill.sessionId, card: p.card ?? null, deck: p.deck ?? s.drill.deck, stage: 'card' }, view: 'drill', viewBy: p.by ?? null, viewReason: 'card opened' };
    case 'attempt.provisional': {
      const at = p.attempt ?? {};
      return { ...s, drill: { ...s.drill, card: p.card ?? s.drill.card, attemptId: at.id ?? null, stage: 'provisional', provisional: at.provisional ? { source: at.provisional.source, text: at.provisional.text, pass: !!at.provisional.grade?.pass, reasons: at.provisional.grade?.reasons ?? [] } : null, checking: null, verified: null, graded: null }, view: 'drill', viewReason: 'attempt received', viewBy: at.provisional?.source ?? null };
    }
    case 'attempt.status':
      if (otherCard(s, p.cardId)) return s;
      if (s.drill.attemptId && p.attemptId !== s.drill.attemptId) return s;
      return { ...s, drill: { ...s.drill, attemptId: p.attemptId, stage: 'checking', checking: { reason: p.reason ?? '' } } };
    case 'attempt.verified': {
      if (otherCard(s, p.cardId)) return s;
      const same = !s.drill.attemptId || p.attemptId === s.drill.attemptId;
      const base = same ? s.drill : { ...s.drill, attemptId: p.attemptId, provisional: null, checking: null, graded: null };
      return { ...s, drill: { ...base, attemptId: p.attemptId, stage: p.status === 'verified' ? 'verified' : 'unverified', verified: { status: p.status, via: p.via ?? null, speakerScore: p.speakerScore ?? null, latencyMs: p.latencyMs ?? null, beeText: p.beeText ?? null, replay: !!p.replay, reason: p.reason ?? '' } }, ...switched(s, 'drill', p.status === 'verified' ? 'verified by Bee' : 'Bee could not verify', 'Bee') };
    }
    case 'attempt.graded': {
      const at = p.attempt ?? {};
      if (otherCard(s, at.cardId ?? p.card?.id)) return { ...s, drill: { ...s.drill, deck: p.deck ?? s.drill.deck } };
      const same = at.id === s.drill.attemptId;
      const base = same ? s.drill : { ...s.drill, provisional: null, checking: null };
      return { ...s, drill: { ...base, ...drillFromAttempt(at), card: p.card ?? s.drill.card, deck: p.deck ?? s.drill.deck, stage: 'graded' }, ...switched(s, 'drill', 'graded from Bee', 'Bee') };
    }
    case 'stats.updated':
      return { ...s, statsVersion: s.statsVersion + 1, practiceToday: p.practiceToday ?? s.practiceToday, dataLabel: p.dataLabel ?? s.dataLabel, synthetic: s.synthetic || isSynthetic(p.dataLabel), drill: { ...s.drill, deck: p.deck ?? s.drill.deck } };
    case 'session.ended': {
      // The hub re-sends the summary of a session it already ended when Bee settles one of its
      // attempts late: replace the summary only.
      const sum = p.summary as SessionSummary | null | undefined;
      if (sum && s.drill.summary && sum.sessionId === s.drill.summary.sessionId) return { ...s, drill: { ...s.drill, summary: sum } };
      if (sum && sum.sessionId === s.drill.overDone) return s; // its Round over already timed out
      // The hub closed the card. A verdict, or an attempt Bee is still checking (its verdict can land
      // after the session ends), stays on screen with the summary under it; a card nobody attempted
      // is closed, so the summary shows instead.
      const keep = s.drill.stage !== 'card' && s.drill.stage !== 'idle';
      return { ...s, drill: { ...s.drill, card: keep ? s.drill.card : null, summary: p.summary ?? null, stage: keep ? s.drill.stage : 'idle', overAt: p.summary ? now : null, overCard: s.drill.card?.id ?? null } };
    }
    case 'conversation.started':
      return { ...s, live: { ...s.live, conversationId: p.conversationId, startedAt: p.startedAt ?? null, window: null, ended: null, nudges: [], skips: [] }, ...switched(s, liveView(s, now), 'conversation started', 'Bee') };
    case 'live.window': {
      const w = p.window as LiveWindow | undefined;
      if (!w) return s;
      return { ...s, live: { ...s.live, conversationId: w.conversationId, startedAt: s.live.startedAt ?? w.startedAt, window: w }, ...switched(s, liveView(s, now), 'conversation update', 'Bee') };
    }
    case 'nudge.sent':
      return p.nudge ? { ...s, live: { ...s.live, nudges: [p.nudge as Nudge, ...s.live.nudges].slice(0, KEEP_NUDGES) }, ...switched(s, liveView(s, now), 'nudge sent to the wrist', 'Bee') } : s;
    case 'nudge.skipped':
      return p.skip ? { ...s, live: { ...s.live, skips: [p.skip as NudgeSkipped, ...s.live.skips].slice(0, KEEP_NUDGES) } } : s;
    case 'conversation.ended': {
      // the window is over: drop it so the ended state ("Recap on its way") shows, not stale numbers
      const same = !s.live.window || !p.conversationId || s.live.window.conversationId === p.conversationId;
      return { ...s, live: { ...s.live, ended: stripSeq(p) as unknown as ConversationEnded, window: same ? null : s.live.window } };
    }
    case 'recap.ready':
      return p.recap ? { ...s, recap: p.recap as Recap, latestRecap: newerRecap(s.latestRecap, p.recap as Recap), recapVisible: true, recapShownAt: now, recapWanted: null } : s;
    case 'live.mode':
      return p.mode ? { ...s, live: { ...s.live, mode: p.mode as LiveMode } } : s;
    case 'practice.summary': {
      const sum = p.summary as PracticeSummary | undefined;
      if (!sum) return s;
      if (s.room && sum.room && sum.room !== '*' && sum.room.toUpperCase() !== s.room.toUpperCase()) return s; // another room's take
      const pr = s.practice.takeId === sum.takeId ? s.practice : { ...emptyPractice(), takeId: sum.takeId, from: sum.from };
      return { ...s, practice: { ...pr, summary: sum }, view: 'practice', viewReason: 'take finished', viewBy: 'phone' };
    }
    case 'mirror.focus': {
      const f = p as unknown as MirrorFocus;
      if (s.room && f.room && f.room.toUpperCase() !== s.room.toUpperCase()) return s; // another room's phone
      if (f.view === 'recap') {
        const have = !!s.recap && (!f.recapId || s.recap.id === f.recapId);
        return { ...s, recapVisible: have, recapShownAt: have ? now : s.recapShownAt, recapWanted: have ? null : (f.recapId ?? 'latest'), viewBy: f.by ?? null, viewReason: f.reason ?? null };
      }
      if (!(['week', 'transfer', 'drill', 'live', 'practice'] as string[]).includes(f.view)) return s;
      const practice = f.takeId && f.takeId !== s.practice.takeId ? { ...emptyPractice(), takeId: f.takeId } : s.practice;
      return { ...s, view: f.view, viewBy: f.by ?? null, viewReason: f.reason ?? null, recapVisible: false, practice };
    }
    default:
      return s;
  }
}

// An automatic switch: a new view gets the event's reason; staying put keeps the current line.
function switched(s: MirrorState, view: ScreenView, reason: string, by: string | null): Pick<MirrorState, 'view' | 'viewReason' | 'viewBy'> {
  return view === s.view ? { view, viewReason: s.viewReason, viewBy: s.viewBy } : { view, viewReason: reason, viewBy: by };
}

function stripSeq(p: Record<string, unknown>) {
  const { seq: _seq, at: _at, ...rest } = p;
  return rest;
}

function onMeters(s: MirrorState, frames: PracticeMeters[], now: number): MirrorState {
  if (!frames.length) return s;
  let pr = s.practice;
  for (const f of frames) {
    if (!f || typeof f.takeId !== 'string') continue;
    if (pr.takeId !== f.takeId || (pr.summary && pr.summary.takeId === f.takeId && pr.latest && f.frame < pr.latest.frame)) pr = { ...emptyPractice(), takeId: f.takeId };
    const history = [...pr.history, { t: f.t, rmsDbfs: f.rmsDbfs, pitchHz: f.pitchHz }];
    pr = {
      ...pr,
      from: f.from ?? pr.from,
      latest: f,
      history: history.length > PRACTICE_HISTORY ? history.slice(-PRACTICE_HISTORY) : history,
      caption: f.caption ?? pr.caption,
      lastFrameAt: now,
      frames: pr.frames + 1,
    };
  }
  if (pr === s.practice) return s;
  if (s.view === 'practice' && !s.recapVisible) return { ...s, practice: pr };
  return { ...s, practice: pr, view: 'practice', viewReason: 'practice take', viewBy: 'phone', recapVisible: false };
}
