// Speaking Mirror state. Pure: no React, no I/O, no clock reads (every action carries `now`), so it
// runs the same on the web TV, on Vega and in the unit tests (test/mirror-reducer.test.ts).
//
// Sequenced hub events are applied in `seq` order and duplicates are dropped. An event that
// arrives ahead of a gap waits in `pending` until the gap fills or GAP_WAIT_MS passes (a `tick`
// then applies it and counts the gap). A new `hub.state` (a join or a reconnect) rebases the
// sequence: anything at or below the last applied seq is still a duplicate.
//
// Room frames (`practice.meters`) carry no seq: they are applied as they arrive and only the last
// PRACTICE_HISTORY frames are kept, in memory.
//
// Screens switch on events: a drill event shows the drill, a live-conversation event shows the
// live window (unless a drill or a practice take is in progress), meters show practice,
// `recap.ready` raises the recap overlay, and `mirror.focus` shows whatever a peer asked for.
import type {
  CardView,
  ConversationEnded,
  DeckSummary,
  HubState,
  LiveMode,
  LiveState,
  LiveWindow,
  MirrorFocus,
  MirrorView,
  Nudge,
  NudgeSkipped,
  PracticeMeters,
  PracticeSummary,
  Recap,
  SessionSummary,
} from '../contract';

export type ScreenView = MirrorView | 'pair';
export const SCREEN_VIEWS: ScreenView[] = ['week', 'transfer', 'live', 'practice', 'pair'];

export const GAP_WAIT_MS = 1500;
export const MAX_PENDING = 64;
export const PRACTICE_HISTORY = 50; // 5 s at 10 Hz
export const PRACTICE_ACTIVE_MS = 3000;
export const RECAP_VISIBLE_MS = 30_000;
export const KEEP_NUDGES = 5;

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
  graded: { pass: boolean; reasons: string[]; agreement: string | null; counted: boolean; boxFrom: number | null; boxTo: number | null; beeText: string | null } | null;
  summary: SessionSummary | null;
}

export interface LiveSlice {
  mode: LiveMode | null;
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
  recap: Recap | null;
  recapVisible: boolean;
  recapShownAt: number | null;
  recapWanted: string | null; // a focus asked for a recap id we do not hold yet
  statsVersion: number; // bumped on stats.updated: refetch stats and transfer
  lastTopic: string | null;
}

export type MirrorAction =
  | { type: 'hubState'; state: HubState; now: number }
  | { type: 'event'; event: SeqEvent; now: number }
  | { type: 'meters'; frames: PracticeMeters[]; now: number }
  | { type: 'tick'; now: number }
  | { type: 'show'; view: ScreenView }
  | { type: 'dismissRecap' }
  | { type: 'liveState'; live: LiveState }
  | { type: 'recap'; recap: Recap; show: boolean; now: number };

const emptyDrill = (): DrillState => ({ sessionId: null, card: null, deck: null, attemptId: null, stage: 'idle', provisional: null, checking: null, verified: null, graded: null, summary: null });
const emptyPractice = (): PracticeSlice => ({ takeId: null, from: null, latest: null, history: [], caption: null, lastFrameAt: null, frames: 0, summary: null });

export function initialMirror(view: ScreenView = 'week'): MirrorState {
  return {
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
    live: { mode: null, conversationId: null, startedAt: null, window: null, ended: null, nudges: [], skips: [] },
    practice: emptyPractice(),
    recap: null,
    recapVisible: false,
    recapShownAt: null,
    recapWanted: null,
    statsVersion: 0,
    lastTopic: null,
  };
}

const isSynthetic = (label: string | null | undefined) => !!label && /synthetic/i.test(label);

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
    case 'liveState':
      return { ...s, live: { ...s.live, mode: a.live.mode, window: s.live.window ?? a.live.conversation, conversationId: s.live.conversationId ?? a.live.conversation?.conversationId ?? null, nudges: s.live.nudges.length ? s.live.nudges : a.live.recentNudges.slice(0, KEEP_NUDGES), skips: s.live.skips.length ? s.live.skips : a.live.recentSkips.slice(0, KEEP_NUDGES) }, dataLabel: s.dataLabel ?? a.live.dataLabel, synthetic: s.synthetic || a.live.synthetic };
    case 'recap':
      if (s.recap && s.recap.id === a.recap.id && !a.show) return s;
      return { ...s, recap: a.recap, recapVisible: a.show || (s.recapVisible && s.recap?.id === a.recap.id), recapShownAt: a.show ? a.now : s.recapShownAt, recapWanted: s.recapWanted === a.recap.id ? null : s.recapWanted };
  }
}

function onHubState(s: MirrorState, h: HubState): MirrorState {
  const d: DrillState = { ...emptyDrill(), sessionId: h.session?.id ?? null, card: h.openCard, deck: h.deck, stage: h.openCard ? 'card' : 'idle' };
  const la = h.lastAttempt;
  if (la && h.openCard && la.cardId === h.openCard.id) Object.assign(d, drillFromAttempt(la));
  return {
    ...s,
    lastSeq: null,
    floorSeq: Math.max(s.floorSeq, s.lastSeq ?? 0),
    pending: [],
    pendingSince: null,
    hubMode: h.mode,
    dataLabel: h.dataLabel,
    synthetic: isSynthetic(h.dataLabel) || h.mode === 'demo',
    replay: s.replay || !!h.bee?.replay,
    drill: d,
  };
}

function drillFromAttempt(at: any): Partial<DrillState> {
  const out: Partial<DrillState> = { attemptId: at.id };
  if (at.provisional) out.provisional = { source: at.provisional.source, text: at.provisional.text, pass: !!at.provisional.grade?.pass, reasons: at.provisional.grade?.reasons ?? [] };
  if (at.status === 'pending_bee') out.stage = 'provisional';
  if (at.status === 'polling') (out.stage = 'checking'), (out.checking = { reason: at.reason ?? '' });
  if (at.status === 'unverified') out.stage = 'unverified';
  if (at.bee) out.verified = { status: 'verified', via: at.bee.via ?? null, speakerScore: at.bee.speakerScore ?? null, latencyMs: at.bee.latencyMs ?? null, beeText: at.bee.gradedText ?? at.bee.text ?? null, replay: !!at.bee.replay, reason: at.reason ?? '' };
  if (at.status === 'graded' && at.final) {
    out.stage = 'graded';
    out.graded = { pass: !!at.final.pass, reasons: at.final.grade?.reasons ?? [], agreement: at.agreement ?? null, counted: !!at.counted, boxFrom: at.box?.from ?? null, boxTo: at.box?.to ?? null, beeText: at.bee?.gradedText ?? at.bee?.text ?? null };
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
      if (s.drill.attemptId && p.attemptId !== s.drill.attemptId) return s;
      return { ...s, drill: { ...s.drill, attemptId: p.attemptId, stage: 'checking', checking: { reason: p.reason ?? '' } } };
    case 'attempt.verified': {
      const same = !s.drill.attemptId || p.attemptId === s.drill.attemptId;
      const base = same ? s.drill : { ...s.drill, attemptId: p.attemptId, provisional: null, checking: null, graded: null };
      return { ...s, drill: { ...base, attemptId: p.attemptId, stage: p.status === 'verified' ? 'verified' : 'unverified', verified: { status: p.status, via: p.via ?? null, speakerScore: p.speakerScore ?? null, latencyMs: p.latencyMs ?? null, beeText: p.beeText ?? null, replay: !!p.replay, reason: p.reason ?? '' } }, ...switched(s, 'drill', p.status === 'verified' ? 'verified by Bee' : 'Bee could not verify', 'Bee') };
    }
    case 'attempt.graded': {
      const at = p.attempt ?? {};
      const same = at.id === s.drill.attemptId;
      const base = same ? s.drill : { ...s.drill, provisional: null, checking: null };
      return { ...s, drill: { ...base, ...drillFromAttempt(at), card: p.card ?? s.drill.card, deck: p.deck ?? s.drill.deck, stage: 'graded' }, ...switched(s, 'drill', 'graded from Bee', 'Bee') };
    }
    case 'stats.updated':
      return { ...s, statsVersion: s.statsVersion + 1, dataLabel: p.dataLabel ?? s.dataLabel, synthetic: s.synthetic || isSynthetic(p.dataLabel), drill: { ...s.drill, deck: p.deck ?? s.drill.deck } };
    case 'session.ended':
      return { ...s, drill: { ...s.drill, summary: p.summary ?? null, stage: s.drill.stage === 'graded' || s.drill.stage === 'unverified' ? s.drill.stage : 'idle' } };
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
    case 'conversation.ended':
      return { ...s, live: { ...s.live, ended: stripSeq(p) as unknown as ConversationEnded } };
    case 'recap.ready':
      return p.recap ? { ...s, recap: p.recap as Recap, recapVisible: true, recapShownAt: now, recapWanted: null } : s;
    case 'live.mode':
      return p.mode ? { ...s, live: { ...s.live, mode: p.mode as LiveMode } } : s;
    case 'practice.summary': {
      const sum = p.summary as PracticeSummary | undefined;
      if (!sum) return s;
      const pr = s.practice.takeId === sum.takeId ? s.practice : { ...emptyPractice(), takeId: sum.takeId, from: sum.from };
      return { ...s, practice: { ...pr, summary: sum }, view: 'practice', viewReason: 'take finished', viewBy: 'phone' };
    }
    case 'mirror.focus': {
      const f = p as unknown as MirrorFocus;
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
