import {drillPhase, initialMirror, mirrorReducer, type MirrorAction, type MirrorState} from '../src/mirror/reducer';
import {beeMemoryLine, fmtMs, habitPill, habitRole, niceMax, nudgeHopsLine, skipLine, topBreakdown, verdictTone} from '../src/mirror/format';
import {PRODUCT_NAME, WORDMARK} from '../src/brand';
import {MIRROR_CONFIG} from '../src/platform/config';
import {CONTRACT_VERSION, ROOM_TOPICS} from '../src/contract';

const ev = (seq: number, topic: string, payload: Record<string, unknown> = {}) => ({topic, payload: {seq, at: seq, ...payload}});
const run = (s: MirrorState, ...a: MirrorAction[]) => a.reduce(mirrorReducer, s);

describe('the shared mirror reducer on Vega (synced from tv/web)', () => {
  it('applies sequenced events in order and drops duplicates', () => {
    let s = run(initialMirror(), {type: 'event', event: ev(3, 'mirror.focus', {view: 'transfer'}), now: 0}, {type: 'event', event: ev(5, 'mirror.focus', {view: 'live'}), now: 1});
    expect(s.view).toBe('transfer');
    expect(s.pending).toHaveLength(1);
    s = run(s, {type: 'event', event: ev(4, 'mirror.focus', {view: 'practice'}), now: 2}, {type: 'event', event: ev(4, 'mirror.focus', {view: 'week'}), now: 3});
    expect(s.lastSeq).toBe(5);
    expect(s.view).toBe('live');
    expect(s.duplicates).toBe(1);
  });
  it('switches to practice on meters and keeps them out of the sequence', () => {
    const s = run(initialMirror(), {type: 'meters', frames: [{takeId: 't1', frame: 0, t: 100, at: 1, rmsDbfs: -20, band: 'ok', voiced: true, pitchHz: 180, pitchRangeSt: 4, monotone: false, wpm: 150, pause: {active: false, currentMs: 0, count: 0}, caption: 'hello'}], now: 0});
    expect(s.view).toBe('practice');
    expect(s.lastSeq).toBeNull();
    expect(s.practice.caption).toBe('hello');
  });
});

describe('Vega platform config and display helpers', () => {
  it('throttles meters to 5 Hz and talks to the hub over the reverse port forward', () => {
    expect(MIRROR_CONFIG.metersHz).toBe(5);
    expect(MIRROR_CONFIG.wsUrl).toMatch(/^ws:\/\/[\w.]+:\d+\/ws$/);
    expect(MIRROR_CONFIG.platform).toBe('vega');
  });
  it('formats durations, axes and breakdowns', () => {
    expect(fmtMs(0)).toBe('0 s');
    expect(fmtMs(40)).toBe('40 ms');
    expect(fmtMs(17390)).toBe('17.4 s');
    expect(fmtMs(74000)).toBe('1 min 14 s');
    expect(niceMax(2.6)).toBe(3);
    expect(topBreakdown({'i guess': 15, 'i think': 5})).toBe('"i guess" 15  ·  "i think" 5');
    expect(verdictTone('dropped')).toBe('good');
    expect(verdictTone('rose')).toBe('bad');
  });
  it('carries the product name and contract v2', () => {
    expect(PRODUCT_NAME).toBe('Speaking Mirror');
    expect(WORDMARK).toBe('SPEAKING MIRROR');
    expect(CONTRACT_VERSION).toBe(2);
    expect(ROOM_TOPICS).toEqual(['practice.meters']);
  });
});

describe('the wrist moment and the round on Vega (synced from tv/web)', () => {
  it('ends a round after an overrule: Round over, not the result again', () => {
    const card = {id: 'k1', resay: 'x'};
    const summary = {sessionId: 's1', cards: 1, passed: 0, failed: 1, unverified: 0, pending: 0, beeOverrules: 1, perCard: []};
    const graded = {attempt: {id: 'a1', cardId: 'k1', status: 'graded', agreement: 'bee-overrules', final: {pass: false, grade: {reasons: []}}}, card};
    let s = run(initialMirror(), {type: 'event', event: ev(1, 'card.open', {card}), now: 0}, {type: 'event', event: ev(2, 'attempt.graded', graded), now: 1});
    expect(drillPhase(s.drill)).toBe('result');
    s = run(s, {type: 'event', event: ev(3, 'session.ended', {summary}), now: 2});
    expect(drillPhase(s.drill)).toBe('over');
  });
  it('words the nudge hops, the quiet line, Bee memory and the early cards the same as the web TV', () => {
    const nudge = {hops: {spokenAt: 0, beeAt: 5900, detectedAt: 5950, todoAt: 7400, alarmAt: 17400}, latencyMs: {bee: 5900, detect: 50, todo: 1450, total: 17400}, wrist: {channel: 'bee-todo' as const, status: 'scheduled' as const, todoId: null, leadMs: 10000, error: null}};
    expect(nudgeHopsLine(nudge)).toBe('You said it → Bee 5.9 s → wrist alarm 17.4 s');
    expect(skipLine({reason: 'cooldown', retryAfterMs: 120000})).toBe('Stayed quiet: cooldown between nudges · again in 2 min');
    expect(beeMemoryLine({enabled: false, status: 'off', goal: null, insights: null, facts: null, note: ''})).toBeNull();
    const failed = {enabled: true, status: 'failed' as const, goal: null, insights: null, facts: null, note: ''};
    expect(beeMemoryLine(failed)?.text).toBe('Your speaking goal didn’t save to Bee this time; the hub tries again.');
    expect(beeMemoryLine({...failed, stopped: true})?.text).toBe('Your speaking goal didn’t save to Bee; the coach stopped trying, so it never makes a second copy.');
    const waiting = {role: 'drilled' as const, verdict: 'not drilled yet' as const, before: {per100: 2, words: 900} as any, after: {per100: 0, words: 0} as any};
    expect(habitRole(waiting)).toBe('To practise');
    expect(habitPill({...waiting, role: 'control'})).toBe('Starts at your first practice');
  });
});
