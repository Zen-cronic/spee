// Display helpers for the mirror's screens. Pure; shared by the web TV and the Vega app.
import type { NudgeHops, NudgeRule, NudgeSkipReason, PracticeFlag, TransferVerdict } from '../contract';

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

// The drill session's tally line on the TV ("Session over: …" / "Last session: …").
export function sessionTally(prefix: string, s: { passed: number; failed: number; unverified: number; pending?: number; beeOverrules?: number }): string {
  return `${prefix}: ${s.passed} passed, ${s.failed} failed, ${s.unverified} unverified${s.pending ? `, ${s.pending} still with Bee` : ''}${s.beeOverrules ? `, Bee overruled ${s.beeOverrules}` : ''}.`;
}

// The BEE OVERRULES caption. Bee and the preview disagree in either direction, so the caption
// follows Bee's verdict: the preview said the opposite.
const PREVIEW_BY: Record<string, string> = { phone: 'The phone', alexa: 'Alexa', typed: 'The typed preview' };
export function overruleText(previewSource: string | null | undefined, beePass: boolean, beeText: string | null | undefined): string {
  const who = PREVIEW_BY[previewSource ?? ''] ?? 'The preview';
  const heard = `"${beeText ?? ''}"`;
  return beePass ? `${who} heard a fail. Bee heard ${heard} and passed it: Bee is what counts.` : `${who} heard a pass. Bee heard ${heard} and that is what counts.`;
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
  'hedge-streak': 'Hedge streak',
  'like-streak': '"Like" streak',
  monologue: 'Long monologue',
  'fast-rate': 'Fast rate',
};

export const SKIP_LABEL: Record<NudgeSkipReason, string> = {
  off: 'live coaching is off',
  warmup: 'first minute of the conversation',
  'quiet-hours': 'quiet hours',
  'drill-active': 'a drill is running',
  cooldown: 'cooldown between nudges',
  'rule-cooldown': 'cooldown for this rule',
  'cap-hour': 'hourly cap reached',
  'cap-day': 'daily cap reached',
  'wrist-down': 'wrist channel down',
};

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

/** The habit rows of the week view, in the contract's order: clarity first, then fillers. */
export const WEEK_HABITS: { key: 'hedges' | 'vague' | 'fillers' | 'restarts'; label: string }[] = [
  { key: 'hedges', label: 'Hedges' },
  { key: 'vague', label: 'Vague answers' },
  { key: 'fillers', label: 'Fillers' },
  { key: 'restarts', label: 'Restarts' },
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
