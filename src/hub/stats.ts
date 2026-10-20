// Habit statistics over the wearer's analysed real sessions (Bee conversations and meeting
// captions), and the transfer check: did a drilled habit drop in later non-drill speech, compared
// with a pre-registered control habit that was deliberately not drilled?
//
// Rates are per 100 of the wearer's English words, with a 95% interval for a Poisson count
// (Byar's approximation, `rateCi95` in src/real/talk.ts). Lines flagged "maybe not the wearer"
// are excluded. Voice notes are excluded: on this project they hold scripted readings and drills,
// not natural speech. Drill attempts never count as sessions.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate, addDays } from "../real/deck.js";
import type { RealCorpus, WearerLine } from "../real/corpus.js";
import type { MeetingTimeline } from "../real/tactiq.js";
import { rateCi95, talkMetrics } from "../real/talk.js";
import { listRe, wordCount, FILLER_RE, HEDGE_RE } from "../real/text.js";
import { readJsonSafe } from "./atomic.js";
import { FIRST_SIGNAL_MIN_WORDS } from "./contract.js";
import { align, normTokens } from "./fuzzy.js";
import { countHabitKey, habitMatches, isRegistered, parseHabitKey, umbrellaOf, vagueMatches } from "./habits.js";

export interface StatLine {
  key: string;
  text: string;
  dom: "fr" | "en";
  uncertain: boolean;
  spokenAt?: number | null; // Bee spoken_at (epoch ms), when the source has it
}
export interface StatSession {
  id: string;
  kind: "conversation" | "meeting" | "voice_note";
  startMs: number;
  lines: StatLine[];
  timeline?: MeetingTimeline;
  synthetic?: boolean;
  // Distinct speakers heard, the wearer included: a count from the session's counts (SessionStats
  // `speakers`, else 2 when it has lines that are not the wearer's), never anyone's words.
  // Undefined when unknown. Used only to guess the conversation's setting (src/hub/settings.ts).
  speakers?: number;
}

// Where the running live hub keeps the conversations it picked up itself (src/hub/ingest.ts),
// relative to its state dir: a RealCorpus of wearer lines and per-conversation counts, gitignored.
export const LIVE_SESSIONS_FILE = join("live", "sessions.json");

// Add a corpus's sessions (and their wearer lines) to `byId`. Lines of a session already present
// are merged by line key, as between the offline files. With `newOnly`, a session already present
// is left exactly as it is: the live ingest never changes what an offline run produced.
export function mergeCorpus(byId: Map<string, StatSession>, corpus: RealCorpus | undefined, timelines: MeetingTimeline[] = [], opts: { newOnly?: boolean } = {}): void {
  if (!corpus) return;
  const mine = new Set<string>();
  for (const s of corpus.sessions ?? []) {
    if (s.skipped) continue;
    if (!byId.has(s.id)) {
      const speakers = s.speakers ?? (s.totalLines > s.wearerLines ? 2 : s.wearerLines > 0 ? 1 : undefined);
      byId.set(s.id, { id: s.id, kind: s.kind, startMs: s.startMs, lines: [], ...(speakers ? { speakers } : {}) });
      mine.add(s.id);
    }
  }
  for (const l of (corpus.lines ?? []) as WearerLine[]) {
    if (opts.newOnly && !mine.has(l.session)) continue;
    const s = byId.get(l.session);
    if (s && !s.lines.some((x) => x.key === l.key)) s.lines.push({ key: l.key, text: l.text, dom: l.dom, uncertain: l.uncertain, spokenAt: l.spokenAt ?? null });
  }
  for (const t of timelines) {
    const s = byId.get(t.session);
    if (s && (!opts.newOnly || mine.has(t.session))) s.timeline = t;
  }
}

// Merge the gitignored real-data files into one session list (deduplicated by session and line key):
// the offline runs first (real/corpus.json, real/class-*.json, real/meetings.json), then the
// conversations the live hub ingested (LIVE_SESSIONS_FILE), which only add sessions no offline file has.
export function loadRealSessions(dir = "real"): StatSession[] {
  const byId = new Map<string, StatSession>();
  const read = (f: string) => {
    const p = join(dir, f);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  };
  mergeCorpus(byId, read("corpus.json"));
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => /^class-.*\d\.json$/.test(f))) mergeCorpus(byId, read(f)?.corpus);
  const m = read("meetings.json");
  if (m) mergeCorpus(byId, m.corpus, m.timelines);
  // The hub writes this one while it runs: a damaged file is set aside (readJsonSafe), never fatal.
  mergeCorpus(byId, readJsonSafe<RealCorpus | undefined>(join(dir, LIVE_SESSIONS_FILE), () => undefined), [], { newOnly: true });
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs);
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const NON_DRILL_KINDS = new Set(["conversation", "meeting"]);
// Bee captures are the input of record. Meeting caption transcripts are a secondary source,
// included only when asked for (source=all) and always labelled.
export type SourceSel = "bee" | "all";
export const parseSource = (s: string | null | undefined): SourceSel | null => (!s || s === "bee" ? "bee" : s === "all" ? "all" : null);
export const inSource = (s: StatSession, src: SourceSel) => (src === "bee" ? s.kind === "conversation" : NON_DRILL_KINDS.has(s.kind));
export const SOURCE_LABEL: Record<string, string> = { conversation: "Bee (Apple Watch) conversation", meeting: "meeting captions (secondary source)", voice_note: "Bee voice note (excluded: scripted readings/drills)" };
const enLines = (ss: StatSession[]) => ss.flatMap((s) => s.lines.filter((l) => !l.uncertain && l.dom === "en"));

export interface Rate {
  count: number;
  per100: number;
  ci95: [number, number];
}
const rate = (count: number, words: number): Rate => ({ count, per100: words ? r2((count / words) * 100) : 0, ci95: rateCi95(count, words) });

function breakdown(texts: string[], f: (t: string) => string[]) {
  const b: Record<string, number> = {};
  for (const t of texts) for (const m of f(t)) b[m] = (b[m] ?? 0) + 1;
  return b;
}

export interface HabitRates {
  words: number;
  lines: number;
  fillers: Rate & { breakdown: Record<string, number> };
  hedges: Rate & { breakdown: Record<string, number> };
  vague: Rate & { breakdown: Record<string, number> };
  restarts: Rate;
  trailingOff: Rate;
  yeahTics: Rate;
}

export function habitRates(sessions: StatSession[]): HabitRates {
  const ls = enLines(sessions);
  const texts = ls.map((l) => l.text);
  const words = texts.reduce((n, t) => n + wordCount(t), 0);
  const fb = breakdown(texts, (t) => listRe(t, FILLER_RE.en).map((m) => m.replace(/(.)\1+$/, "$1")));
  const hb = breakdown(texts, (t) => listRe(t, HEDGE_RE.en));
  const vb = breakdown(texts, vagueMatches);
  const sum = (b: Record<string, number>) => Object.values(b).reduce((a, x) => a + x, 0);
  const count = (key: string) => texts.reduce((n, t) => n + countHabitKey(key, t), 0);
  return {
    words,
    lines: ls.length,
    fillers: { ...rate(sum(fb), words), breakdown: fb },
    hedges: { ...rate(sum(hb), words), breakdown: hb },
    vague: { ...rate(sum(vb), words), breakdown: vb },
    restarts: rate(count("restart"), words),
    trailingOff: rate(count("trailing"), words),
    yeahTics: rate(count("yeah-tic"), words),
  };
}

// `label` is the range as asked ("meeting:<id>" or "session:<id>"), echoed back in the response.
export type RangeSpec = { kind: "today" | "week" | "all" } | { kind: "session"; id: string; label?: string };

export function parseRange(s: string | null | undefined): RangeSpec | null {
  const v = (s ?? "week").trim();
  if (v === "today" || v === "week" || v === "all") return { kind: v };
  const m = /^(?:meeting|session):(.+)$/.exec(v);
  return m ? { kind: "session", id: m[1]!, label: v } : null;
}

export function selectSessions(all: StatSession[], r: RangeSpec, nowMs: number, tz?: string, source: SourceSel = "bee"): StatSession[] {
  const today = localDate(nowMs, tz);
  const ss = all.filter((s) => inSource(s, source) || (r.kind === "session" && NON_DRILL_KINDS.has(s.kind)));
  if (r.kind === "all") return ss;
  if (r.kind === "session") return ss.filter((s) => s.id === r.id);
  const from = r.kind === "today" ? today : addDays(today, -6);
  return ss.filter((s) => {
    const d = localDate(s.startMs, tz);
    return d >= from && d <= today;
  });
}

// Pre-registration

export interface PreregHabit {
  habit: string; // habit key (src/hub/habits.ts)
  why: string;
}
export interface TransferPrereg {
  kind: "transfer";
  registered_at: string;
  registered_local: string;
  lang: "en";
  basis: string;
  drilled: PreregHabit[];
  control: PreregHabit[];
  min_words_per_period: number;
  cutover_rule: string;
  synthetic?: boolean;
  note?: string;
}

export function loadPrereg(path: string): TransferPrereg {
  const p = JSON.parse(readFileSync(path, "utf8")) as TransferPrereg;
  for (const h of [...p.drilled, ...p.control]) if (!parseHabitKey(h.habit)) throw new Error(`${path}: unknown habit key "${h.habit}"`);
  return p;
}

// Transfer

export interface DrillEvent {
  at: number;
  habitKeys: string[]; // the habit keys the drilled card exercises
}

export interface Period {
  sessions: number;
  words: number;
  count: number;
  per100: number;
  ci95: [number, number];
  from: string | null; // local dates
  to: string | null;
}

export type Verdict = "dropped" | "no change" | "rose" | "too little data" | "not drilled yet" | "invalid";

export interface TransferHabit {
  habit: string;
  label: string;
  role: "drilled" | "control";
  firstDrillAt: number | null;
  cutoverAt: number | null;
  cutoverSource: string;
  before: Period;
  after: Period;
  deltaPer100: number | null;
  verdict: Verdict;
  detail: string;
  wordsNeededPerPeriod: number | null; // to tell a halving of the "before" rate from no change
}

export interface TransferReport {
  generatedAt: string;
  synthetic: boolean;
  source: SourceSel;
  sources: Record<string, { sessions: number; words: number; label: string }>;
  prereg: { path: string; registeredAt: string; drilled: string[]; control: string[]; basis: string };
  minWordsPerPeriod: number;
  method: string;
  habits: TransferHabit[];
  unregistered: { habit: string; drills: number; note: string }[];
  headline: string;
  claim: TransferClaim;
  firstSignal: FirstSignal[];
}

// The first signal: one pre-registered drilled habit in the last conversation before its first drill
// vs the next conversation after it. A same-day glance (the stand-up an hour after the drill), never
// a verdict: one conversation either side, no interval, and only with enough words on both sides.
// Drill lines are left out, as in the transfer periods; a conversation with too few words is passed
// over (signalPair).
export type FirstSignalStatus = "measured" | "too-few-words" | "no-next-conversation" | "no-earlier-conversation";
export interface FirstSignalSide {
  session: string;
  date: string; // local date
  startMs: number;
  words: number;
  count: number;
  per100: number;
}
export interface FirstSignal {
  habit: string;
  label: string;
  firstDrillAt: number;
  status: FirstSignalStatus;
  before: FirstSignalSide | null; // the last conversation before the first drill with enough words (its pre-drill lines only)
  after: FirstSignalSide | null; // the next conversation that started at or after it with enough words
  deltaPer100: number | null; // after - before, only when "measured"
  minWords: number; // FIRST_SIGNAL_MIN_WORDS, on each side
  note: string;
}
export const FIRST_SIGNAL_NOTE = "one conversation either side of the first drill: a first signal, not proof (the pre-registered before/after is the test)";

// The two conversations either side of a habit's first drill: the last one before it and the next
// one after it that each hold at least FIRST_SIGNAL_MIN_WORDS of the wearer's words (a short exchange
// is passed over, not compared). "Before" is strictly pre-drill: a conversation that was still going
// when the drill began counts only its lines spoken before it. When no conversation on a side has
// enough words, the nearest one with any words is returned, so the caller can say it was too short.
// The first signal (/api/transfer) and drilledVsNextSession (/api/stats) both use this.
export function signalPair(ss: StatSession[], firstDrillAt: number): { before: StatSession | null; after: StatSession | null; status: FirstSignalStatus } {
  const words = (s: StatSession) => enLines([s]).reduce((n, l) => n + wordCount(l.text), 0);
  const sorted = [...ss].sort((a, b) => a.startMs - b.startMs);
  const pre = sorted
    .filter((s) => s.startMs < firstDrillAt)
    .map((s) => (s.lines.some((l) => l.spokenAt != null && l.spokenAt >= firstDrillAt) ? { ...s, lines: s.lines.filter((l) => l.spokenAt == null || l.spokenAt < firstDrillAt) } : s))
    .filter((s) => words(s) > 0)
    .reverse();
  const post = sorted.filter((s) => s.startMs >= firstDrillAt && words(s) > 0);
  const pick = (xs: StatSession[]) => xs.find((s) => words(s) >= FIRST_SIGNAL_MIN_WORDS) ?? xs[0] ?? null;
  const before = pick(pre);
  const after = pick(post);
  const status: FirstSignalStatus = !after ? "no-next-conversation" : !before ? "no-earlier-conversation" : words(before) < FIRST_SIGNAL_MIN_WORDS || words(after) < FIRST_SIGNAL_MIN_WORDS ? "too-few-words" : "measured";
  return { before, after, status };
}

export function firstSignals(ss: StatSession[], drilled: { habit: string; label: string; firstDrillAt: number | null }[], tz?: string): FirstSignal[] {
  const side = (s: StatSession | null, key: string): FirstSignalSide | null => {
    if (!s) return null;
    const p = period([s], key, tz);
    return { session: s.id, date: localDate(s.startMs, tz), startMs: s.startMs, words: p.words, count: p.count, per100: p.per100 };
  };
  return drilled
    .filter((h): h is { habit: string; label: string; firstDrillAt: number } => h.firstDrillAt != null)
    .map((h) => {
      const pair = signalPair(ss, h.firstDrillAt);
      const before = side(pair.before, h.habit);
      const after = side(pair.after, h.habit);
      const status = pair.status;
      return { habit: h.habit, label: h.label, firstDrillAt: h.firstDrillAt, status, before, after, deltaPer100: status === "measured" ? r2(after!.per100 - before!.per100) : null, minWords: FIRST_SIGNAL_MIN_WORDS, note: FIRST_SIGNAL_NOTE };
    });
}

// Bee lines that were drill attempts, which are not everyday speech. A line is a drill line when its
// key is one of the attempt's utterance ids, or, since the stats lines come from Bee's final
// transcript and an attempt matched on the live stream carries the realtime transcript's ids (two
// lists with their own ids and their own segmentation), when it was spoken inside the attempt's
// speech window (with the clock slack) in the same conversation and its words are the attempt's:
// most of the line is in the attempt's Bee text, or most of that text is in the line.
export interface DrillSpan {
  session: string | null; // the Bee conversation id, when known
  fromMs: number;
  toMs: number;
  text: string;
}
export interface DrillLines {
  keys: Set<string>; // "u:<utteranceId>"
  spans: DrillSpan[];
}
export const DRILL_LINE_SLACK_MS = 8000; // Bee spoken_at is second-granular, and clocks differ
export const DRILL_TEXT_MATCH = 0.6;
const drillText = (line: string, attempt: string) => {
  const l = normTokens(line);
  const a = normTokens(attempt);
  if (!l.length || !a.length) return false;
  return align(l, a).score >= DRILL_TEXT_MATCH || align(a, l).score >= DRILL_TEXT_MATCH;
};
export function isDrillLine(session: string, l: StatLine, d: DrillLines): boolean {
  if (d.keys.has(l.key)) return true;
  if (l.spokenAt == null) return false;
  const t = l.spokenAt;
  return d.spans.some((sp) => (sp.session == null || sp.session === session) && t >= sp.fromMs - DRILL_LINE_SLACK_MS && t <= sp.toMs + DRILL_LINE_SLACK_MS && drillText(l.text, sp.text));
}
export function withoutDrillLines(ss: StatSession[], d: DrillLines | undefined): StatSession[] {
  if (!d || (!d.keys.size && !d.spans.length)) return ss;
  return ss.map((s) => (s.lines.some((l) => isDrillLine(s.id, l, d)) ? { ...s, lines: s.lines.filter((l) => !isDrillLine(s.id, l, d)) } : s));
}

const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
// The first signal as one spoken sentence (the coach's "how am I doing?"), or null when no drilled
// habit has a next conversation yet. Says "too short to compare" instead of a number.
export function firstSignalSentence(fs: FirstSignal[]): string | null {
  const measured = fs.filter((f) => f.status === "measured");
  if (measured.length) {
    const parts = measured.map((f, i) => `${habitName(f.label)} ${i ? "from" : "went from"} ${f1(f.before!.per100)} to ${f1(f.after!.per100)}`);
    return `First signal, from one conversation and not proof: in your next conversation after practising, ${andList(parts)} per 100 words.`;
  }
  const short = fs.find((f) => f.status === "too-few-words");
  if (short) {
    const next = short.after!.words < short.minWords;
    const words = next ? short.after!.words : short.before!.words;
    return `First signal: ${next ? "your next conversation after" : "your last conversation before"} practising ${habitName(short.label)} was too short to compare (${words} words; it takes ${short.minWords}).`;
  }
  return null;
}

// Why a drop can't be set against the control ("dropped-control-unclear"), in the headline's words:
// no control registered, a control that was practised, one that went up, or too little speech.
function unclearControl(control: TransferHabit[]): string {
  if (!control.length) return "; there's no habit you left unpractised to compare it with";
  if (control.some((h) => h.verdict === "invalid")) return "; the one you didn't practise was practised too, so it can't be compared";
  if (control.some((h) => h.verdict === "rose")) return "; the one you didn't practise went up";
  return "; there isn't enough speech yet to compare the one you didn't practise";
}

// What the headline claims, for a screen to word without re-deriving it from the verdicts:
// "dropped-control-flat" only when a drilled habit dropped and every control showed no change
// ("all-dropped-control-flat" when every drilled habit dropped); "dropped-control-dropped" when a
// control dropped too; "dropped-control-unclear" when a drilled habit dropped but the controls
// cannot be compared (too little data, rose, invalid, or none registered). "partly-started" when
// nothing dropped, some drilled habit's after period has started and another is not drilled yet.
export type TransferClaim = "all-dropped-control-flat" | "dropped-control-flat" | "dropped-control-dropped" | "dropped-control-unclear" | "partly-started" | "not-drilled-yet" | "no-drop-yet";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-10-19" -> "Oct 19"
const monthDay = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
// A habit's name inside a sentence: 'unsure words (I guess, ...)' -> 'unsure words', 'filler "like"' stays.
export const habitName = (label: string) => label.replace(/\s*\(.*$/, "").replace(/ as a filler$/, "").trim();
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const ciOverlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

// Smallest words-per-period at which a halving of `per100` would give non-overlapping intervals.
export function wordsToSeeHalving(per100: number): number | null {
  if (per100 <= 0) return null;
  for (let n = 50; n <= 50_000; n += 50) {
    const before = rateCi95(Math.round((per100 / 100) * n), n);
    const after = rateCi95(Math.round((per100 / 200) * n), n);
    if (!ciOverlap(before, after)) return n;
  }
  return null;
}

export function period(sessions: StatSession[], key: string, tz?: string): Period {
  const texts = enLines(sessions).map((l) => l.text);
  const words = texts.reduce((n, t) => n + wordCount(t), 0);
  const h = parseHabitKey(key)!;
  const count = texts.reduce((n, t) => n + habitMatches(h, t, "en").length, 0);
  const r = rate(count, words);
  const dates = sessions.map((s) => localDate(s.startMs, tz)).sort();
  return { sessions: sessions.length, words, count, per100: r.per100, ci95: r.ci95, from: dates[0] ?? null, to: dates.at(-1) ?? null };
}

// `drillLines`: the lines Bee heard as drill attempts (DrillLines). They are left out of both
// periods: a card sentence said for a drill is not everyday speech, and counting it would make the
// "after" rate look better just because drills were recorded.
export function transfer(opts: { sessions: StatSession[]; prereg: TransferPrereg; preregPath: string; drills: DrillEvent[]; nowMs: number; tz?: string; source?: SourceSel; drillLines?: DrillLines }): TransferReport {
  const { prereg } = opts;
  const source = opts.source ?? "bee";
  const minWords = prereg.min_words_per_period;
  const ss = withoutDrillLines(
    opts.sessions.filter((s) => inSource(s, source)),
    opts.drillLines,
  ).sort((a, b) => a.startMs - b.startMs);
  const registeredAt = Date.parse(prereg.registered_at);
  const firstDrill = (key: string) => {
    const ts = opts.drills.filter((d) => d.habitKeys.includes(key)).map((d) => d.at);
    return ts.length ? Math.min(...ts) : null;
  };
  const drilledFirst = prereg.drilled.map((h) => firstDrill(h.habit)).filter((x): x is number => x != null);
  const commonCutover = drilledFirst.length ? Math.min(...drilledFirst) : null;
  const habits: TransferHabit[] = [];
  for (const [role, list] of [["drilled", prereg.drilled], ["control", prereg.control]] as const) {
    for (const ph of list) {
      const key = ph.habit;
      const label = parseHabitKey(key)!.label;
      const fd = role === "drilled" ? firstDrill(key) : null;
      const cut = role === "drilled" ? fd : commonCutover;
      const cutoverSource = role === "drilled" ? "this habit's first drill attempt" : "the earliest first drill of any pre-registered drilled habit";
      const before = period(cut == null ? ss : ss.filter((s) => s.startMs < cut), key, opts.tz);
      const after = period(cut == null ? [] : ss.filter((s) => s.startMs >= cut), key, opts.tz);
      let verdict: Verdict;
      let detail: string;
      const need = wordsToSeeHalving(before.per100);
      if (role === "control" && opts.drills.some((d) => d.habitKeys.includes(key))) {
        verdict = "invalid";
        detail = "the control habit was drilled, so it is no longer a control";
      } else if (cut == null) {
        verdict = "not drilled yet";
        detail = role === "drilled" ? "no drill attempt on this habit yet: there is no after period" : "no pre-registered habit has been drilled yet";
      } else if (role === "drilled" && cut < registeredAt) {
        verdict = "invalid";
        detail = "first drilled before the pre-registration date";
      } else if (before.words < minWords || after.words < minWords) {
        verdict = "too little data";
        detail = `needs at least ${minWords} words in each period (before ${before.words}, after ${after.words})${need ? `; telling a halving from no change at this rate takes about ${need} words per period` : ""}`;
      } else if (ciOverlap(before.ci95, after.ci95)) {
        verdict = "no change";
        detail = `no detectable change: the 95% intervals overlap (before ${before.ci95[0]}-${before.ci95[1]}, after ${after.ci95[0]}-${after.ci95[1]} per 100 words)`;
      } else if (after.per100 < before.per100) {
        verdict = "dropped";
        detail = `95% intervals do not overlap (before ${before.ci95[0]}-${before.ci95[1]}, after ${after.ci95[0]}-${after.ci95[1]} per 100 words)`;
      } else {
        verdict = "rose";
        detail = `95% intervals do not overlap and the rate went up (before ${before.ci95[0]}-${before.ci95[1]}, after ${after.ci95[0]}-${after.ci95[1]})`;
      }
      habits.push({
        habit: key,
        label,
        role,
        firstDrillAt: fd,
        cutoverAt: cut,
        cutoverSource,
        before,
        after,
        deltaPer100: cut == null || !after.words ? null : r2(after.per100 - before.per100),
        verdict,
        detail,
        wordsNeededPerPeriod: need,
      });
    }
  }
  // Refusal: a drilled habit that was not pre-registered is never reported as drilled.
  const registered = new Set([...prereg.drilled, ...prereg.control].map((h) => h.habit));
  const unreg = new Map<string, number>();
  // A specific key counts as registered when its umbrella is ("hedge:i guess" under "hedges"). The
  // umbrella key a targeted card also emits is not reported on its own: the specific key stands for it.
  for (const d of opts.drills)
    for (const k of d.habitKeys) {
      if (isRegistered(k, registered)) continue;
      if (d.habitKeys.some((s) => s !== k && umbrellaOf(s) === k)) continue;
      unreg.set(k, (unreg.get(k) ?? 0) + 1);
    }
  const unregistered = [...unreg].map(([habit, drills]) => ({ habit, drills, note: "drilled but not pre-registered: not reported as a transfer result" }));
  const dropped = habits.filter((h) => h.role === "drilled" && h.verdict === "dropped");
  const control = habits.filter((h) => h.role === "control");
  const flat = control.length > 0 && control.every((h) => h.verdict === "no change");
  const controlDropped = control.some((h) => h.verdict === "dropped");
  const drilled = habits.filter((h) => h.role === "drilled");
  const started = drilled.filter((h) => h.cutoverAt != null);
  const notYet = drilled.filter((h) => h.verdict === "not drilled yet");
  const claim: TransferClaim = dropped.length
    ? flat
      ? dropped.length === drilled.length
        ? "all-dropped-control-flat"
        : "dropped-control-flat"
      : controlDropped
        ? "dropped-control-dropped"
        : "dropped-control-unclear"
    : notYet.length
      ? started.length
        ? "partly-started"
        : "not-drilled-yet"
      : "no-drop-yet";
  // Worded for a person; `claim` above is what it may say.
  const names = andList(dropped.map((h) => habitName(h.label)));
  const headline = dropped.length
    ? `${names[0]!.toUpperCase()}${names.slice(1)} dropped in your real conversations since you started practising${flat ? "; the one you didn't practise stayed the same" : controlDropped ? "; but the one you didn't practise dropped too, so it may not be the practice" : unclearControl(control)}`
    : claim === "partly-started"
      ? `Counting from your first practice: ${andList(started.map((h) => `${habitName(h.label)} since ${monthDay(localDate(h.cutoverAt!, opts.tz))}`))}; ${andList(notYet.map((h) => habitName(h.label)))} not practised yet`
      : claim === "not-drilled-yet"
        ? "Not practised yet: the before and after starts with your first practice"
        : "Nothing you've practised has dropped clearly yet";
  return {
    generatedAt: new Date(opts.nowMs).toISOString(),
    synthetic: !!prereg.synthetic || ss.some((s) => s.synthetic),
    source,
    sources: sourceBreakdown(ss),
    prereg: { path: opts.preregPath, registeredAt: prereg.registered_at, drilled: prereg.drilled.map((h) => h.habit), control: prereg.control.map((h) => h.habit), basis: prereg.basis },
    minWordsPerPeriod: minWords,
    method:
      "Per habit: rate per 100 of the wearer's English words in non-drill sessions (Bee conversations by default; meeting captions only with source=all; drill attempts and voice notes always excluded), before vs after the cutover. Drilled habit cutover: its first drill attempt. Control cutover: the earliest first drill of any drilled habit. 95% Poisson intervals (Byar). Verdict 'dropped' or 'rose' only when the intervals do not overlap and both periods have the minimum words.",
    habits,
    unregistered,
    headline,
    claim,
    firstSignal: firstSignals(ss, drilled, opts.tz),
  };
}

// The compact "drilled habit vs the next real session" view for /api/stats.
export function sourceBreakdown(ss: StatSession[]) {
  const out: Record<string, { sessions: number; words: number; label: string }> = {};
  for (const s of ss) {
    const o = (out[s.kind] ??= { sessions: 0, words: 0, label: SOURCE_LABEL[s.kind] ?? s.kind });
    o.sessions++;
    o.words += enLines([s]).reduce((n, l) => n + wordCount(l.text), 0);
  }
  return out;
}

// The same pair as the first signal (signalPair), for every drilled habit key, pre-registered or not.
// Pass the sessions with the drill lines already left out (withoutDrillLines). deltaPer100 only when
// both sides have FIRST_SIGNAL_MIN_WORDS words.
export function nextSessionDeltas(sessions: StatSession[], drills: DrillEvent[], tz?: string, source: SourceSel = "bee") {
  const ss = sessions.filter((s) => inSource(s, source));
  const keys = [...new Set(drills.flatMap((d) => d.habitKeys))];
  return keys.map((key) => {
    const first = Math.min(...drills.filter((d) => d.habitKeys.includes(key)).map((d) => d.at));
    const pair = signalPair(ss, first);
    const one = (s: StatSession | null) => (s ? { session: s.id, date: localDate(s.startMs, tz), ...period([s], key, tz) } : null);
    const b = one(pair.before);
    const a = one(pair.after);
    return { habit: key, label: parseHabitKey(key)?.label ?? key, firstDrillAt: first, lastSessionBefore: b, nextSessionAfter: a, deltaPer100: pair.status === "measured" ? r2(a!.per100 - b!.per100) : null };
  });
}

export function talkSummary(sessions: StatSession[]) {
  const ms = sessions.filter((s) => s.kind === "meeting" && s.timeline);
  if (!ms.length) return null;
  const lines = ms.flatMap((s) => s.lines.map((l) => ({ ...l, session: s.id }))) as unknown as WearerLine[];
  const t = talkMetrics(
    ms.map((s) => s.timeline!),
    lines,
  );
  return {
    meetings: t.meetings,
    talkShareWords: t.talkShareWords,
    turns: t.turns,
    substantiveTurns: t.substantiveTurns,
    avgTurnWords: t.avgTurnWords,
    longestTurnWords: t.longestTurnWords,
    questions: t.questions,
    trailingOffSentences: t.trailingOff,
    sentences: t.sentences,
  };
}
