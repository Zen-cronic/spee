// Display helpers for the mirror's screens. Pure; shared by the web TV and the Vega app.
import type { BeeMemory, ConversationEnded, ConversationSetting, FirstSignal, GradeCheck, GradeResult, InstrumentResponse, LiveBaseline, LiveMode, Nudge, NudgeHops, NudgeRule, NudgeSkipped, NudgeSkipReason, PracticeFlag, RuleState, SessionSummary, SettingTag, TransferClaim, TransferHabit, TransferResponse, TransferVerdict, Recap } from '../contract';
import { BEE_MEMORY_NOTE as HUB_BEE_MEMORY_NOTE, CONVERSATION_SETTINGS, SETTING_NAME } from '../contract';

export const fmt1 = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '–' : (Math.round(n * 10) / 10).toFixed(1));
export const fmt2 = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '–' : (Math.round(n * 100) / 100).toFixed(2));
export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '–' : String(Math.round(n)));
export const fmtPct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
export const fmtWords = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "2026-10-22" -> "Thu Oct 22". A calendar date, so it is read in UTC (no time zone shift).
export function fmtDay(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) return '–';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// The practice tally line on the TV ("Last time: 2 passed, 1 not yet."). Zero parts are left out.
export function sessionTally(prefix: string, s: { passed: number; failed: number; unverified: number; pending?: number; beeOverrules?: number }): string {
  const parts = [`${s.passed} passed`, s.failed ? `${s.failed} not yet` : null, s.unverified ? `${s.unverified} Bee didn’t catch` : null, s.pending ? `${s.pending} still with Bee` : null, s.beeOverrules ? `${s.beeOverrules} decided by Bee` : null];
  return `${prefix}: ${parts.filter(Boolean).join(', ')}.`;
}

// The BEE OVERRULES caption. Bee and the preview disagree in either direction, so the caption
// follows Bee's verdict: the preview said the opposite.
const PREVIEW_BY: Record<string, string> = { phone: 'The phone', alexa: 'Alexa', mcp: 'The assistant', typed: 'The typed preview' };
export function overruleText(previewSource: string | null | undefined, beePass: boolean, beeText: string | null | undefined): string {
  const who = PREVIEW_BY[previewSource ?? ''] ?? 'The preview';
  const heard = `"${(beeText ?? '').trim().replace(/[.!?]+$/, '')}"`;
  return beePass ? `${who} heard a miss, but Bee heard ${heard} and passed it. Bee has the final say.` : `${who} heard a pass, but Bee heard ${heard}. Bee has the final say.`;
}

/** 0 -> "0 s", 40 -> "40 ms", 17390 -> "17.4 s", 48000 -> "48 s", 74000 -> "1 min 14 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  if (ms === 0) return '0 s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // round first, then split: 59960 is "1 min", 119600 is "2 min" (never "60 s" or "1 min 60 s")
  if (Math.round(ms / 100) < 600) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** "2026-10-12T13:00:00.000Z" -> "Oct 12" (no time zone math: the date part only). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export const RULE_LABEL: Record<NudgeRule, string> = {
  'hedge-streak': 'Unsure words',
  'like-streak': 'Filler “like”',
  monologue: 'Long turn',
  'fast-rate': 'Talking fast',
};

/** Why the coach held a nudge back, in plain words (the coach decides; Bee only hears). */
export const SKIP_LABEL: Record<NudgeSkipReason, string> = {
  off: 'live coaching is off',
  warmup: 'first minute of the conversation',
  'quiet-hours': 'quiet hours',
  'drill-active': 'a practice line is open',
  cooldown: 'cooldown between nudges',
  'rule-cooldown': 'same nudge sent recently',
  'cap-hour': 'hourly limit reached',
  'cap-day': 'daily limit reached',
  'wrist-down': 'wrist link down',
};

/** A wait in whole minutes from a minute up ("2 min"), else seconds ("40 s"). */
export function fmtWait(ms: number): string {
  if (!(ms > 0)) return '0 s';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * A held-back nudge as Live shows it: "Stayed quiet: cooldown between nudges · again in 2 min".
 * The coach stayed quiet, so the line never credits Bee with the decision.
 */
export function skipLine(s: Pick<NudgeSkipped, 'reason' | 'retryAfterMs'>): string {
  const again = s.retryAfterMs !== null && s.retryAfterMs > 0 ? ` · again in ${fmtWait(s.retryAfterMs)}` : '';
  return `Stayed quiet: ${SKIP_LABEL[s.reason] ?? 'held back'}${again}`;
}

/**
 * A nudge's three hops from the end of your line, as the hub measured them: Bee tagging the line,
 * then the wrist alarm the hub set (its alarm time; the hub cannot see the Watch, so never a buzz).
 * `ms` is from the end of your line; null for an alarm that was not set.
 */
export interface HopStop {
  key: 'spoken' | 'bee' | 'alarm';
  label: string;
  ms: number | null;
}
export function nudgeHops(n: Pick<Nudge, 'latencyMs' | 'wrist' | 'hops'>): HopStop[] {
  const set = n.wrist.status !== 'failed' && n.hops.alarmAt !== null && n.latencyMs.total !== null;
  return [
    { key: 'spoken', label: 'You said it', ms: 0 },
    { key: 'bee', label: `Bee ${fmtMs(n.latencyMs.bee)}`, ms: n.latencyMs.bee },
    { key: 'alarm', label: set ? `wrist alarm ${fmtMs(n.latencyMs.total)}` : 'wrist alarm not set', ms: set ? n.latencyMs.total : null },
  ];
}
/** The nudge card's line: "You said it → Bee 5.9 s → wrist alarm 17.4 s". */
export function nudgeHopsLine(n: Pick<Nudge, 'latencyMs' | 'wrist' | 'hops'>): string {
  return nudgeHops(n)
    .map((h) => h.label)
    .join(' → ');
}
/** The wrist text without its "[coach] " tag, as the Watch shows it. */
export const nudgeText = (n: Pick<Nudge, 'text'>): string => curly(n.text.replace(/^\[[^\]]*\]\s*/, ''));

/**
 * When Live nudges, from the hub's own policy and thresholds: "One wrist nudge when unsure words
 * reach 4 in 2 min, then quiet for 3 min." Null without the thresholds.
 */
export function nudgeRuleLine(rules: Pick<RuleState, 'rule' | 'threshold'>[] | undefined, mode: Pick<LiveMode, 'cooldownMs' | 'rules'> | null, windowMs: number | null | undefined): string | null {
  const on = (r: NudgeRule) => mode?.rules?.[r] !== false;
  const hedge = rules?.find((r) => r.rule === 'hedge-streak');
  const like = rules?.find((r) => r.rule === 'like-streak');
  const parts = [hedge && on('hedge-streak') ? `unsure words reach ${hedge.threshold}` : null, like && on('like-streak') ? `“like” reaches ${like.threshold}` : null].filter(Boolean);
  if (!parts.length || !mode) return null;
  const win = windowMs ? ` in ${fmtWait(windowMs)}` : '';
  return `One wrist nudge when ${parts.join(' or ')}${win}, then quiet for ${fmtWait(mode.cooldownMs)}.`;
}

/** The recap's nudge line: "1 wrist nudge, then stayed quiet once"; null when neither happened. */
export function recapNudgeLine(n: { sent: number; skipped: number } | null | undefined): string | null {
  if (!n || (!n.sent && !n.skipped)) return null;
  const times = (k: number) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`);
  if (!n.sent) return `Stayed quiet ${times(n.skipped)}: no wrist nudge`;
  const sent = `${n.sent} wrist nudge${n.sent === 1 ? '' : 's'}`;
  return n.skipped ? `${sent}, then stayed quiet ${times(n.skipped)}` : sent;
}

/** What a number on Live covers: "this week" for the usual rates, or "so far" when the week is too quiet. */
export function usualWindow(b: Pick<LiveBaseline, 'source'> & { range?: LiveBaseline['range'] }): string {
  return baselineWordsLabel(b) === 'your words this week' ? 'this week' : 'so far';
}

export type Tone = 'good' | 'bad' | 'neutral' | 'wait' | 'bee';

export function verdictTone(v: TransferVerdict | string): Tone {
  if (v === 'dropped' || v === 'better') return 'good';
  if (v === 'rose' || v === 'worse' || v === 'invalid') return 'bad';
  if (v === 'too little data' || v === 'not drilled yet' || v === 'no-baseline') return 'wait';
  return 'neutral';
}

export const FLAG_LABEL: Record<PracticeFlag, string> = {
  quiet: 'Too quiet',
  loud: 'Too loud',
  monotone: 'Flat melody',
  fast: 'Fast',
  slow: 'Slow',
  'few-pauses': 'Few pauses',
};

export const HOP_LABEL: Record<keyof NudgeHops, string> = {
  spokenAt: 'You said it',
  beeAt: 'Bee tagged',
  detectedAt: 'Rule fired',
  todoAt: 'To-do set',
  alarmAt: 'Watch buzz',
};

/**
 * What a person reads for each habit key the hub sends (stats, transfer, recap, first signal). The
 * keys stay the hub's; only these words are shown. Kept equal to src/hub/habitNames.ts
 * (test/habit-names.test.ts), so the TV can name a habit from its key alone.
 */
export const HABIT_NAME: Record<string, string> = {
  hedges: 'unsure words',
  'filler:like': 'filler "like"',
  fillers: 'filler words',
  vague: 'vague answers',
  restart: 'starting over',
  restarts: 'starting over',
};

/** A habit's display title from its key ('hedges' -> 'Unsure words'); the hub's label when the key is unknown. */
export function habitTitle(key: string | null | undefined, label?: string | null): string {
  const k = key ?? '';
  const name = HABIT_NAME[k] ?? (k.startsWith('hedge:') ? HABIT_NAME.hedges : k.startsWith('filler:') ? `filler "${k.slice(7)}"` : null);
  if (!name) return shortHabit(label ?? k);
  return curly(name[0]!.toUpperCase() + name.slice(1));
}

/** The habit rows of the week view, in the contract's order: clarity first, then fillers. */
export const WEEK_HABITS: { key: 'hedges' | 'vague' | 'fillers' | 'restarts'; label: string }[] = [
  { key: 'hedges', label: habitTitle('hedges') },
  { key: 'vague', label: habitTitle('vague') },
  { key: 'fillers', label: habitTitle('fillers') },
  { key: 'restarts', label: habitTitle('restarts') },
];

/** Top entries of a breakdown map: {"i guess": 15, "i think": 5} -> '"i guess" 15 · "i think" 5'. */
export function topBreakdown(b: Record<string, number> | undefined, n = 3): string {
  if (!b) return '';
  return Object.entries(b)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, v]) => `"${k}" ${v}`)
    .join('  ·  ');
}

/** A value's position on a 0..max axis as a 0..1 fraction (clamped). */
export const frac = (v: number, max: number): number => (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0);

/** A round axis maximum just above v: 2.6 -> 3, 0.9 -> 1, 4.4 -> 5. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const steps = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100];
  return steps.find((s) => s >= v * 1.05) ?? Math.ceil(v);
}

/** dBFS on the volume meter: -60..0 mapped to 0..1. */
export const dbFrac = (db: number): number => Math.max(0, Math.min(1, (db + 60) / 60));

/** Before -> after as a whole-number percent change (2.47 -> 0.64 is -74); null without a before rate. */
export function pctChange(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined || after === null || after === undefined || !(before > 0) || !Number.isFinite(after)) return null;
  return Math.round((after / before - 1) * 100);
}

/** Straight double quotes to typographic ones, for display: 'Bee heard "um"' -> 'Bee heard “um”'. */
export function curly(text: string): string {
  return text.replace(/"([^"]*)"/g, '“$1”');
}

/** A habit's short display name from a hub label: 'unsure words (I guess...)' -> 'Unsure words', 'filler "like"' -> 'Filler “like”'. */
export function shortHabit(label: string): string {
  const s = label.replace(/\s*\(.*$/, '').replace(/ as a filler$/, '').trim();
  const i = s.search(/[a-z]/i);
  return curly(i < 0 ? s : s.slice(0, i) + s[i]!.toUpperCase() + s.slice(i + 1));
}

/** The most frequent word of a breakdown map, quoted: {"i guess": 15, "i think": 5} -> '“I guess”'. */
export function topWord(b: Record<string, number> | undefined): string | null {
  if (!b) return null;
  const top = Object.entries(b).sort((x, y) => y[1] - x[1])[0];
  return top ? `“${top[0].replace(/\bi\b/g, 'I')}”` : null;
}

/**
 * The grader's first failed rule in plain words, from the grade's own fields: a habit card that
 * failed on "i think" says 'You still said “i think”', whatever words its label quotes. Null on a pass.
 */
export function plainReason(f: GradeFailure | null): string | null {
  if (!f) return null;
  const q = f.words.map((w) => `“${w}”`);
  switch (f.rule) {
    case 'nonempty':
      return 'Bee heard nothing';
    case 'habit':
      return q.length ? `You still said ${q.slice(0, 2).join(' and ')}` : 'The old habit was still there';
    case 'fillers':
      return q.length ? `Bee heard ${q.slice(0, 2).join(' and ')}` : 'Bee heard a filler word';
    case 'content':
      return f.words.length ? `A few words were missing: ${f.words.slice(0, 3).join(', ')}` : 'It didn’t match the sentence';
    case 'required':
      return q.length ? `You didn’t say ${q.join(' or ')}` : 'A key word was missing';
    default:
      return null;
  }
}

/**
 * Live's footer between conversations. Right after a conversation ends, and until its own recap
 * arrives, it says how many words that was and whether a recap is coming; it never shows an older
 * conversation's headline as the last one. Otherwise, the latest recap's headline.
 */
export function lastConversation(ended: Pick<ConversationEnded, 'conversationId' | 'endedAt' | 'wearerWords' | 'recap'> | null, last: Pick<Recap, 'conversationId' | 'endedAt' | 'headline'> | null): { headline: string | null; hint: string | null } {
  const endedNewer = !!ended && (!last || (last.conversationId !== ended.conversationId && ended.endedAt >= last.endedAt));
  if (ended && endedNewer) return { headline: null, hint: `${ended.wearerWords} of your words. ${ended.recap === 'pending' ? 'Your recap is on its way.' : 'Too short for a recap.'}` };
  return { headline: last?.headline ?? null, hint: null };
}

/** What the usual word count covers: this week, or every conversation when the week is too quiet. */
export function baselineWordsLabel(b: Pick<LiveBaseline, 'source'> & { range?: LiveBaseline['range'] }): string {
  const week = b.range ? b.range === 'week' : /^bee week\b/.test(b.source);
  return week ? 'your words this week' : 'your words so far';
}

/** A verdict in plain words, as Progress shows it: a percent only for a decided change. */
export function verdictWords(h: Pick<TransferHabit, 'verdict' | 'before' | 'after'>): string {
  const pct = pctChange(h.before.per100, h.after.per100);
  if (h.verdict === 'dropped') return pct === null ? 'Dropped' : `Down ${Math.abs(pct)}%`;
  if (h.verdict === 'rose') return pct === null ? 'Rose' : `Up ${Math.abs(pct)}%`;
  if (h.verdict === 'too little data') return 'Needs more speech';
  if (h.verdict === 'not drilled yet') return 'Not practised yet';
  if (h.verdict === 'invalid') return 'Not counted';
  return 'No change';
}

/**
 * A transfer period's rate as Progress shows it, or null for a dash. A period is shown only when it
 * has the hub's minimum words (`minWordsPerPeriod`): an empty period, a habit not practised yet, or
 * a handful of words never reads as a real "0.0". The pill beside it says why (verdictWords).
 */
export function periodRate(p: Pick<TransferHabit['after'], 'words' | 'per100'> | null | undefined, minWords: number, started = true): string | null {
  if (!started || !p || !(p.words > 0) || p.words < minWords) return null;
  return fmt1(p.per100);
}
/** The before and now numbers of one habit card ("—" without enough speech, or before its first practice). */
export function transferRates(h: Pick<TransferHabit, 'verdict' | 'before' | 'after'>, minWords: number): { before: string | null; after: string | null } {
  const started = h.verdict !== 'not drilled yet';
  return { before: periodRate(h.before, minWords), after: periodRate(h.after, minWords, started) };
}

/** What the two numbers of a Progress card cover (said under them, so no number is without its window). */
export const BEFORE_WINDOW = 'before your first practice';
export const AFTER_WINDOW = 'since then';

/**
 * A Progress card's role line. Before the first practice a practised habit is still "To practise",
 * never "Practised" beside a "Not practised yet" pill (the phone's Progress tab uses the same rule).
 */
export function habitRole(h: Pick<TransferHabit, 'role' | 'verdict'>): 'Practised' | 'To practise' | 'Not practised' {
  if (h.role !== 'drilled') return 'Not practised';
  return h.verdict === 'not drilled yet' ? 'To practise' : 'Practised';
}
/**
 * A Progress card's pill: the verdict in words. Before the first practice a practised habit has
 * none ("To practise" already says it), and the one you don't practise starts at your first practice.
 */
export function habitPill(h: Pick<TransferHabit, 'role' | 'verdict' | 'before' | 'after'>): string | null {
  if (h.verdict === 'not drilled yet') return h.role !== 'drilled' ? 'Starts at your first practice' : null;
  return verdictWords(h);
}

const NUMBER_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const numberWord = (n: number) => NUMBER_WORD[n] ?? String(n);
/** Fewer conversations than this in a phase is not enough to read (WWC: 3 or more points per phase). */
export const MIN_POINTS = 3;
/**
 * The plan row of Progress's Details: what the check is (a two-tier pilot: each practised habit
 * is a tier, the one you don't practise is the comparison), the rule for a change, and the points
 * per phase (one point per Bee conversation, before your first practice → since). It never claims
 * proof: the caveat says it is a pilot, not proof of cause.
 */
export function planLine(t: Pick<TransferResponse, 'prereg' | 'minWordsPerPeriod'> & { habits: Pick<TransferHabit, 'habit' | 'label' | 'role' | 'verdict' | 'before' | 'after'>[] }): { text: string; points: string; caveat: string } {
  const drilled = t.habits.filter((h) => h.role === 'drilled');
  const control = t.habits.filter((h) => h.role !== 'drilled');
  const tiers = drilled.length;
  const text = `A pilot in ${numberWord(tiers)} tier${tiers === 1 ? '' : 's'}, set ${fmtDate(t.prereg.registeredAt)} before your first practice: ${numberWord(tiers)} habit${tiers === 1 ? '' : 's'} you practise against ${numberWord(control.length)} you don’t. A change counts only with ${fmtWords(t.minWordsPerPeriod)}+ words each side and a clear gap.`;
  const n = (k: number) => (k < MIN_POINTS ? `${k} (too few)` : String(k));
  const phase = (h: (typeof t.habits)[number]) => `${habitTitle(h.habit, h.label)} ${n(h.before.sessions)} → ${h.verdict === 'not drilled yet' ? 'not started' : n(h.after.sessions)}`;
  const points = `Conversations counted, before → since: ${[...drilled, ...control].map(phase).join(' · ')}`;
  return { text, points, caveat: `one point per conversation, at least ${MIN_POINTS} a phase to read · a pilot, not proof of cause` };
}

/**
 * Bee memory, as the hub reports it (GET /api/coach/facts): the coach's one goal fact in Bee and
 * Bee's fact and insight counts. Null when the hub has it off (or does not report it), so the row
 * hides. Counts only: no fact text but the coach's own goal.
 */
export type BeeMemoryIn = Pick<BeeMemory, 'enabled' | 'status' | 'goal' | 'insights' | 'facts' | 'note'>;
/** The note the row always carries (the hub's BEE_MEMORY_NOTE, with a typographic apostrophe). */
export const BEE_MEMORY_NOTE = HUB_BEE_MEMORY_NOTE.replace(/'/g, '’');
const dayOf = (ms: number | null | undefined) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : fmtDate(new Date(ms).toISOString()));
export function beeMemoryLine(m: BeeMemoryIn | null | undefined): { text: string; counts: string | null; caveat: string } | null {
  if (!m || !m.enabled || m.status === 'off') return null;
  const updated = dayOf(m.goal?.updatedAt);
  const saved = m.goal?.confirmed ? 'saved in Bee as a confirmed fact' : 'saved in Bee, not confirmed yet';
  const text =
    m.status === 'pending'
      ? 'Saving your speaking goal to Bee…'
      : m.status === 'failed'
        ? 'Your speaking goal didn’t save to Bee this time; the hub tries again.'
        : m.status === 'demo'
          ? m.goal
            ? 'Demo: the coach would save your speaking goal in Bee as a fact. Nothing is written.'
            : 'Demo: after a line Bee passes, the coach would save your speaking goal in Bee.'
          : m.goal
            ? `Your speaking goal is ${saved}${updated ? `, updated ${updated}` : ''}.`
            : 'No speaking goal in Bee yet: it is saved after your first line Bee passes.';
  const read = dayOf(m.facts?.readAt ?? m.insights?.readAt);
  const counts = m.facts || m.insights ? `Bee holds ${[m.facts ? `${m.facts.count} fact${m.facts.count === 1 ? '' : 's'}` : null, m.insights ? `${m.insights.count} insight${m.insights.count === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')}${read ? `, read ${read}` : ''}` : null;
  return { text, counts, caveat: m.note?.trim() ? m.note.trim().replace(/'/g, '’') : BEE_MEMORY_NOTE };
}

/** The Round over headline: "1 of 2 lines passed." (a line is a card opened this round). */
export function roundHeadline(s: Pick<SessionSummary, 'cards' | 'passed'>): string {
  const cards = Math.max(s.cards, s.passed);
  if (!cards) return 'No lines this round.';
  return `${s.passed} of ${cards} line${cards === 1 ? '' : 's'} passed.`;
}
/** The Round over tally in words: "1 passed, 1 not yet" (zero parts left out; Bee's calls are tagged on the last line). */
export function roundTally(s: Pick<SessionSummary, 'passed' | 'failed' | 'unverified' | 'pending'>): string {
  return sessionTally('Round', { passed: s.passed, failed: s.failed, unverified: s.unverified, pending: s.pending }).replace(/^Round: /, '').replace(/\.$/, '');
}

/** The first few words of what Bee heard, quoted: "“Um, the migration is not…”". */
export function shortQuote(text: string | null | undefined, words = 4): string {
  const w = (text ?? '').trim().replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
  return `“${w.slice(0, words).join(' ')}${w.length > words ? '…' : ''}”`;
}

/**
 * The Round over line about the last line: its result in one sentence, Bee's call with the start
 * of what Bee heard, or that Bee is still checking it (its verdict lands here after the round).
 */
export function roundLastLine(d: { graded: { pass: boolean; agreement: string | null; beeText: string | null; failure: GradeFailure | null } | null; stage: string; previewSource: string | null }): string | null {
  const g = d.graded;
  if (g) {
    const who = PREVIEW_BY[d.previewSource ?? ''] ?? 'The preview';
    // shown under a "Bee's call" tag, so the sentence starts with who previewed it
    if (g.agreement === 'bee-overrules') return g.pass ? `${who} heard a miss on your last line; Bee heard ${shortQuote(g.beeText)} and passed it.` : `${who} heard a pass on your last line; Bee heard ${shortQuote(g.beeText)}.`;
    return g.pass ? 'Last line: passed. Bee heard it.' : `Last line: not yet. ${plainReason(g.failure) ?? 'So close'}.`;
  }
  if (d.stage === 'provisional' || d.stage === 'checking' || d.stage === 'verified') return 'Bee is still checking your last line. Its result lands here.';
  if (d.stage === 'unverified') return 'Bee didn’t catch your last line, so it doesn’t count yet.';
  return null;
}

/**
 * Home's change for one drilled habit: a signed percent only when the hub decided it dropped or
 * rose ("−74%", "+12%"); otherwise the same words as Progress. Never "−0%".
 */
export function changeLabel(h: Pick<TransferHabit, 'verdict' | 'before' | 'after'>): { text: string; pct: boolean } {
  const pct = pctChange(h.before.per100, h.after.per100);
  if ((h.verdict === 'dropped' || h.verdict === 'rose') && pct !== null) return { text: pct === 0 ? '0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, pct: true };
  return { text: verdictWords(h), pct: false };
}

const WORKING: TransferClaim[] = ['all-dropped-control-flat', 'dropped-control-flat'];
/** True only when the hub's claim is that a practised habit dropped and the one not practised stayed flat. */
export const transferWorking = (claim: TransferClaim | null | undefined): boolean => !!claim && WORKING.includes(claim);

/**
 * Progress's title, worded from the hub's claim, as two short lines (each fits one line on the TV,
 * so the big type never wraps a lone word). The habits named as dropped are the hub's own "dropped"
 * verdicts; the hub's full headline is the fallback for a claim this screen does not know.
 */
type TitleHabit = Pick<TransferHabit, 'role' | 'verdict' | 'label'> & { habit?: string };
const nameOf = (h: TitleHabit) => habitTitle(h.habit, h.label);
const lower = (s: string) => s.replace(/[A-Za-z]/, (c) => c.toLowerCase());
export function transferTitle(t: Pick<TransferResponse, 'claim' | 'headline'> & { habits?: TitleHabit[] }): { lead: string; rest: string | null } {
  const names = (t.habits ?? []).filter((h) => h.role === 'drilled' && h.verdict === 'dropped').map(nameOf);
  const dropped = names.length ? `${[names[0], ...names.slice(1).map(lower)].join(' and ')} dropped.` : 'A habit you practised dropped.';
  switch (t.claim) {
    case 'all-dropped-control-flat':
      return { lead: names.length ? dropped : 'The habits you practised dropped.', rest: 'The one you didn’t practise didn’t.' };
    case 'dropped-control-flat':
      return { lead: dropped, rest: 'The one you didn’t practise stayed flat.' };
    case 'dropped-control-dropped':
      return { lead: dropped, rest: 'So did the one you didn’t practise: not proof.' };
    case 'dropped-control-unclear': {
      // the hub's reason, from the control's own verdict: none registered, practised, went up, or too little speech
      const control = (t.habits ?? []).filter((h) => h.role === 'control');
      const rest = t.habits && !control.length ? 'There’s no unpractised one to compare.' : control.some((h) => h.verdict === 'invalid') ? 'The unpractised one was practised too.' : control.some((h) => h.verdict === 'rose') ? 'The unpractised one went up.' : 'The unpractised one needs more speech.';
      return { lead: dropped, rest };
    }
    case 'partly-started': {
      // nothing dropped yet: some practised habits are measured from their first practice, others not practised yet
      const drilled = (t.habits ?? []).filter((h) => h.role === 'drilled');
      const started = drilled.filter((h) => h.verdict !== 'not drilled yet').map(nameOf);
      const waiting = drilled.filter((h) => h.verdict === 'not drilled yet').map(nameOf);
      if (!started.length || !waiting.length) return { lead: curly(t.headline), rest: null };
      return { lead: `Measuring ${started.map(lower).join(' and ')} now.`, rest: `${[waiting[0], ...waiting.slice(1).map(lower)].join(' and ')}: not practised yet.` };
    }
    case 'not-drilled-yet':
      return { lead: 'Nothing practised yet.', rest: 'Progress counts from your first practice line.' };
    case 'no-drop-yet':
      return { lead: 'Nothing has dropped yet.', rest: 'Keep practising: it takes a few conversations.' };
    default:
      return { lead: curly(t.headline), rest: null };
  }
}

/** Home's word for the control: Flat, Down or Up for a decided result, else the same words as Progress. */
export function controlWord(h: Pick<TransferHabit, 'verdict' | 'before' | 'after'>): { text: string; word: boolean } {
  if (h.verdict === 'no change') return { text: 'Flat', word: false };
  if (h.verdict === 'dropped') return { text: 'Down', word: false };
  if (h.verdict === 'rose') return { text: 'Up', word: false };
  return { text: verdictWords(h), word: true };
}

/** The first failed check of a grade, with the words behind it (from what was graded, never from a label). */
export interface GradeFailure {
  rule: GradeCheck['rule'];
  words: string[];
}
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
export function gradeFailure(g: Partial<GradeResult> | null | undefined): GradeFailure | null {
  const fail = g?.checks?.find((c) => !c.ok);
  if (!fail) return null;
  const words =
    fail.rule === 'habit'
      ? uniq(g?.habit?.found ?? [])
      : fail.rule === 'fillers'
        ? uniq(g?.fillers ?? [])
        : fail.rule === 'content'
          ? uniq(g?.missing ?? [])
          : fail.rule === 'required'
            ? uniq((g?.required ?? []).filter((r) => !r.ok).map((r) => r.word))
            : [];
  return { rule: fail.rule, words };
}

/** Said after every first-signal number: one conversation is a glance, never the result. */
export const FIRST_SIGNAL_CAVEAT = 'one conversation, not proof';

type SignalIn = Pick<FirstSignal, 'label' | 'status' | 'before' | 'after' | 'minWords'> & { habit?: string };

/**
 * Progress's first-signal line, at most one so the cards above keep their room. Every measured
 * habit is on it with its two rates ("Your next conversation: Unsure words 2.6 → 0.8 · Filler
 * “like” 3.2 → 0.8", the unit is the cards' own); with none measured, the first habit too short to
 * compare, else one with nothing before it, else "Your next conversation shows here". Null before
 * any practice.
 */
export function firstSignalLine(fs: SignalIn[] | undefined): { text: string; measured: boolean } | null {
  if (!fs?.length) return null;
  const measured = fs.filter((f) => f.status === 'measured');
  if (measured.length) return { text: `Your next conversation: ${measured.map((f) => `${habitTitle(f.habit, f.label)} ${fmt1(f.before?.per100)} → ${fmt1(f.after?.per100)}`).join(' · ')}`, measured: true };
  const other = fs.find((f) => f.status === 'too-few-words') ?? fs.find((f) => f.status === 'no-earlier-conversation');
  return other ? firstSignalText(other) : { text: 'Your next conversation after practising shows here', measured: false };
}

/**
 * One practised habit's first signal on Progress, from the hub's status (never re-derived): the two
 * rates only when the hub measured them, else what is missing in words.
 */
export function firstSignalText(f: SignalIn): { text: string; measured: boolean } {
  const name = habitTitle(f.habit, f.label);
  switch (f.status) {
    case 'measured':
      return { text: `${name} ${fmt1(f.before?.per100)} → ${fmt1(f.after?.per100)} per 100 words in your next conversation`, measured: true };
    case 'too-few-words': {
      const next = (f.after?.words ?? 0) < f.minWords;
      return { text: `${name}: ${next ? 'your next conversation' : 'the conversation before you practised'} was too short to compare (${fmtInt(next ? f.after?.words : f.before?.words)} words)`, measured: false };
    }
    case 'no-earlier-conversation':
      return { text: `${name}: no conversation before you practised to compare`, measured: false };
    default:
      return { text: `${name}: your next conversation after practising shows here`, measured: false };
  }
}

/**
 * Progress's secondary line: the same before/after with meeting captions included
 * (`/api/transfer?source=all`), never the pre-registered result. Null without a caption session.
 * Only the habits captions are shown to transcribe like Bee are listed: the practised ones (unsure
 * words, filler "like") and the one you didn't practise; filler words and "um"/"uh" are left out,
 * because captions miss some of them. `agree` says captions and Bee gave similar numbers only when the
 * hub's instrument check finds it on the practised habits (enough of each, overlapping intervals);
 * with too little data it says so; when they differ, or with no meeting both heard, it is null.
 */
export interface CaptionsLine {
  label: string;
  habits: { habit: string; title: string; before: string; after: string; role: TransferHabit['role']; unchecked: boolean }[];
  agree: string | null;
}
const CAPTION_STABLE = ['hedges', 'filler:like'];
const dashed = (r: { before: string | null; after: string | null }) => ({ before: r.before ?? '—', after: r.after ?? '—' });
export function captionsLine(all: TransferResponse | null | undefined, inst: InstrumentResponse | null | undefined): CaptionsLine | null {
  const m = all?.source === 'all' ? all.sources?.meeting : undefined;
  if (!all || !m || !(m.sessions > 0)) return null;
  const since = m.from ? ` since ${fmtDate(m.from)}` : '';
  // The first row leads with "Including meeting captions"; this second row says which and how secondary.
  const label = `${m.sessions} captioned meeting${m.sessions === 1 ? '' : 's'}${since} · not the pre-registered check`;
  const agreeOn = (k: string) => inst?.habits?.find((h) => h.habit === k)?.agree === true;
  const habits = all.habits
    .filter((h) => (h.role === 'drilled' ? CAPTION_STABLE.includes(h.habit) : true))
    .map((h) => ({ habit: h.habit, title: habitTitle(h.habit, h.label), ...dashed(transferRates(h, all.minWordsPerPeriod)), role: h.role, unchecked: h.role !== 'drilled' && !agreeOn(h.habit) }));
  const n = inst?.pairs ?? 0;
  const meetings = `${n} meeting${n === 1 ? '' : 's'} both heard`;
  const agree =
    inst?.claim === 'practised-agree'
      ? curly(`On ${meetings}, captions and Bee gave similar numbers for unsure words and filler "like"`)
      : inst?.claim === 'too-little-data' && n > 0
        ? `Captions and Bee: too little data to compare yet (${meetings})`
        : null;
  return { label, habits, agree };
}

/** A conversation's setting in plain words ("Meeting", "Work talk", "Casual"), or null when it has none. */
export function settingName(tag: Pick<SettingTag, 'setting'> | null | undefined): string | null {
  return tag ? (SETTING_NAME[tag.setting] ?? null) : null;
}
/** The setting the remote moves to next: Meeting, then Work talk, then Casual, then Meeting again. */
export function nextSetting(s: ConversationSetting): ConversationSetting {
  const i = CONVERSATION_SETTINGS.indexOf(s);
  return CONVERSATION_SETTINGS[(i + 1) % CONVERSATION_SETTINGS.length]!;
}
/** The hub's per-setting line split for the strip: the tag and the rest ("Unsure words: work talk 2.1 → 1.4 · ..."). */
export function bySettingLine(line: string | null | undefined): string | null {
  if (!line) return null;
  return line.replace(/^By setting\s*·\s*/, '');
}
