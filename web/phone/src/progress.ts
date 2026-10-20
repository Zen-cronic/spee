// The phone's Progress tab, as plain data: today's practice, this week's habit rates, the
// pre-registered before and after per habit, the first signal, the last recaps and the details.
// Pure (no DOM, no fetch), so test/phone-progress.test.ts runs it on the hub's own payloads.
//
// Every word comes from the TV's helpers (tv/web/src/mirror/format.ts), so the phone and the TV say
// the same thing: the headline from the hub's claim, the "–" for a period with too little speech,
// the verdict words, and the first signal's caveat. Nothing here re-derives a verdict.
import type { DeckSummary, PracticeCounts, Recap, RecapList, StatsResponse, TransferHabit, TransferResponse } from "../../../src/hub/contract.js";
import { curly, FIRST_SIGNAL_CAVEAT, firstSignalText, fmt1, fmtDate, fmtDay, fmtWords, habitTitle, settingName, topWord, transferRates, transferTitle, verdictWords, WEEK_HABITS } from "../../../tv/web/src/mirror/format.js";

/** A missing number: the TV card's dash, never "0.0". */
export const DASH = "–";
/** Said once where "per 100 words" first appears (src/hub/habitNames.ts PER_100_GLOSS). */
export const PER_100 = "out of every 100 words you said";
export const RECAPS_SHOWN = 3;

// Today

export interface TodayModel {
  due: number | null; // null until the hub's first snapshot
  done: number;
  bar: { shown: number; filled: number } | null; // the TV's TodayBar: at most 10 segments
  line: string | null;
  practiseNow: boolean; // the lime button to the Practice line tab
}
const MAX_SEGMENTS = 10;
/** Today's practice from the hub's own numbers (deck.dueNow, practiceToday.passed); nothing is added. */
export function todayModel(deck: Pick<DeckSummary, "dueNow"> | null | undefined, today: Pick<PracticeCounts, "passed"> | null | undefined): TodayModel {
  const due = deck ? deck.dueNow : null;
  const done = today?.passed ?? 0;
  if (due === null) return { due, done, bar: null, line: null, practiseNow: false };
  const total = done + due;
  const shown = Math.min(total, MAX_SEGMENTS);
  const bar = total ? { shown, filled: Math.round((done / total) * shown) } : null;
  const line = !total ? null : due === 0 ? `${done} passed today` : done ? `${done} passed today · ${due} to go` : "None done yet today";
  return { due, done, bar, line, practiseNow: due > 0 };
}

// This week

export interface WeekRow {
  key: string;
  title: string;
  rate: string;
  sub: string | null;
}
export interface WeekModel {
  rows: WeekRow[];
  words: number;
  note: string; // how much speech the rates are from
}
/** This week's rates in the TV's order (clarity first, then fillers); a dash for a week with no words. */
export function weekModel(stats: Pick<StatsResponse, "habits">): WeekModel {
  const h = stats.habits;
  const words = h.words ?? 0;
  const rows = WEEK_HABITS.map((w) => {
    const r = h[w.key];
    const top = "breakdown" in r ? topWord((r as { breakdown?: Record<string, number> }).breakdown) : null;
    return { key: w.key, title: w.label, rate: words > 0 ? fmt1(r.per100) : DASH, sub: top && words > 0 ? `mostly ${top}` : w.key === "restarts" ? "the one you didn’t practise" : null };
  });
  return { rows, words, note: words > 0 ? `From ${fmtWords(words)} of your words this week, heard by Bee` : "No conversations from Bee this week yet" };
}

// Since you started practising

export type PillTone = "good" | "bad" | "wait";
export interface HabitCard {
  habit: string;
  title: string;
  role: "Practised" | "To practise" | "Not practised";
  before: string | null; // null: a dash
  after: string | null;
  pill: string | null; // null on a "To practise" card: its label already says it
  tone: PillTone;
}
export interface TransferModel {
  lead: string;
  rest: string | null;
  cards: HabitCard[];
  signals: { text: string; caveat: string | null }[];
}
/** The pre-registered before and after: the hub's claim as the headline, one card per habit. */
export function transferModel(t: TransferResponse): TransferModel {
  const title = transferTitle(t);
  const ordered = [...t.habits.filter((x) => x.role === "drilled"), ...t.habits.filter((x) => x.role !== "drilled")];
  return {
    lead: title.lead,
    // partly started: the second half only repeats the cards' "Not practised yet" pills (as on the TV)
    rest: t.claim === "partly-started" ? null : title.rest,
    cards: ordered.map((h) => habitCard(h, t.minWordsPerPeriod)),
    signals: (t.firstSignal ?? []).map((f) => {
      const s = firstSignalText(f);
      return { text: s.text, caveat: s.measured ? FIRST_SIGNAL_CAVEAT : null };
    }),
  };
}
export function habitCard(h: TransferHabit, minWords: number): HabitCard {
  const r = transferRates(h, minWords);
  const waiting = h.verdict === "not drilled yet";
  return {
    habit: h.habit,
    title: habitTitle(h.habit, h.label),
    // Before the first practice a practised habit is still "To practise", and that label is its only
    // word (no "Not practised yet" pill beside it); the one you don't practise waits for that first
    // practice too.
    role: h.role !== "drilled" ? "Not practised" : waiting ? "To practise" : "Practised",
    before: r.before,
    after: r.after,
    pill: waiting ? (h.role !== "drilled" ? "Starts at your first practice" : null) : verdictWords(h),
    // lime only for the hub's "dropped", coral only for "rose"; every undecided verdict is quiet
    tone: h.verdict === "dropped" ? "good" : h.verdict === "rose" ? "bad" : "wait",
  };
}

// Details

export interface DetailsModel {
  plan: string;
  habits: { title: string; before: string; after: string; need: string | null }[];
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
function period(p: TransferHabit["before"], started = true): string {
  if (!started) return "starts at your first practice";
  if (!(p.words > 0)) return "no conversations yet";
  const span = p.from && p.to ? (p.from === p.to ? `, ${fmtDate(p.from)}` : `, ${fmtDate(p.from)} to ${fmtDate(p.to)}`) : "";
  return `${fmtWords(p.words)} words in ${plural(p.sessions, "conversation")}${span}`;
}
/** What the cards are from: the plan (the TV's words), and each side's words and dates. */
export function detailsModel(t: TransferResponse): DetailsModel {
  return {
    plan: `Set ${fmtDate(t.prereg.registeredAt)}, before you first practised. A change counts only with ${fmtWords(t.minWordsPerPeriod)}+ words each side and a clear gap.`,
    habits: [...t.habits.filter((x) => x.role === "drilled"), ...t.habits.filter((x) => x.role !== "drilled")].map((h) => ({
      title: habitTitle(h.habit, h.label),
      before: period(h.before),
      after: period(h.after, h.verdict !== "not drilled yet"),
      need: h.verdict === "too little data" && h.wordsNeededPerPeriod ? `About ${fmtWords(h.wordsNeededPerPeriod)} words each side would show a real change` : null,
    })),
  };
}

// Recent conversations

export interface RecapRow {
  id: string;
  when: string;
  setting: string | null;
  headline: string;
}
/**
 * The last recaps, newest first: when, where (the setting), and the hub's headline. Only those
 * three: the wearer's own moment, its rephrase and the spoken narration stay off this tab.
 */
export function recapRows(list: Pick<RecapList, "recaps"> | null | undefined, nowMs: number, timeZone?: string): RecapRow[] {
  return (list?.recaps ?? []).slice(0, RECAPS_SHOWN).map((r: Recap) => ({ id: r.id, when: recapWhen(r.startedAt, nowMs, timeZone), setting: settingName(r.setting ?? null), headline: curly(r.headline) }));
}

const ymd = (ms: number, timeZone?: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const dayNumber = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
/** "Today · 1:31 PM", "Yesterday · 6:10 PM", "Mon Oct 19 · 9:05 AM": the phone's own time zone, the hub's clock for "today". */
export function recapWhen(ms: number, nowMs: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return DASH;
  const day = ymd(ms, timeZone);
  const diff = dayNumber(ymd(nowMs, timeZone)) - dayNumber(day);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(ms)).replace(/ | /g, " ");
  return `${diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtDay(day)} · ${time}`;
}

// Fetch outcomes, in words

export type LoadError = "forbidden" | "offline" | "server";
export function errorText(e: LoadError): string {
  if (e === "forbidden") return "Progress needs the TV’s QR link: it carries this phone’s pairing key. Scan the QR on the TV’s Pair phone tab again.";
  if (e === "offline") return "Can’t reach the TV’s hub right now.";
  return "The hub couldn’t send your progress just now.";
}
/** A failed response's kind: 403 is the gate (no or wrong pairing key), 5xx the hub, anything else the network. */
export function errorOf(status: number | null): LoadError {
  if (status === 403 || status === 401) return "forbidden";
  if (status !== null && status >= 500) return "server";
  return "offline";
}

/**
 * A habit key's hue class in style.css (the TV's HABIT_HUE, tv/web/src/theme.ts): 'hedge:...' and
 * 'filler:...' keys take their family's, as habitHue does; an unknown key has none (the dim mark).
 */
export function hueClass(key: string | null | undefined): string {
  const k = key ?? "";
  if (k === "hedges" || k.startsWith("hedge")) return "hue-hedges";
  if (k === "fillers" || k.startsWith("filler")) return "hue-fillers";
  if (k === "vague") return "hue-vague";
  if (k === "restart" || k === "restarts") return "hue-restart";
  return "";
}
