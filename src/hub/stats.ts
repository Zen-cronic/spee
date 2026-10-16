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
import { countHabitKey, habitMatches, isRegistered, parseHabitKey, umbrellaOf, vagueMatches } from "./habits.js";

export interface StatLine {
  key: string;
  text: string;
  dom: "fr" | "en";
  uncertain: boolean;
}
export interface StatSession {
  id: string;
  kind: "conversation" | "meeting" | "voice_note";
  startMs: number;
  lines: StatLine[];
  timeline?: MeetingTimeline;
  synthetic?: boolean;
}

// Merge the gitignored real-data files into one session list (deduplicated by session and line key).
export function loadRealSessions(dir = "real"): StatSession[] {
  const byId = new Map<string, StatSession>();
  const add = (corpus: RealCorpus | undefined, timelines: MeetingTimeline[] = []) => {
    if (!corpus) return;
    for (const s of corpus.sessions) {
      if (s.skipped) continue;
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, kind: s.kind, startMs: s.startMs, lines: [] });
    }
    for (const l of corpus.lines as WearerLine[]) {
      const s = byId.get(l.session);
      if (s && !s.lines.some((x) => x.key === l.key)) s.lines.push({ key: l.key, text: l.text, dom: l.dom, uncertain: l.uncertain });
    }
    for (const t of timelines) {
      const s = byId.get(t.session);
      if (s) s.timeline = t;
    }
  };
  const read = (f: string) => {
    const p = join(dir, f);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  };
  add(read("corpus.json"));
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => /^class-.*\d\.json$/.test(f))) add(read(f)?.corpus);
  const m = read("meetings.json");
  if (m) add(m.corpus, m.timelines);
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

export type RangeSpec = { kind: "today" | "week" | "all" } | { kind: "session"; id: string };

export function parseRange(s: string | null | undefined): RangeSpec | null {
  const v = (s ?? "week").trim();
  if (v === "today" || v === "week" || v === "all") return { kind: v };
  const m = /^(?:meeting|session):(.+)$/.exec(v);
  return m ? { kind: "session", id: m[1]! } : null;
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
}

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

function period(sessions: StatSession[], key: string, tz?: string): Period {
  const texts = enLines(sessions).map((l) => l.text);
  const words = texts.reduce((n, t) => n + wordCount(t), 0);
  const h = parseHabitKey(key)!;
  const count = texts.reduce((n, t) => n + habitMatches(h, t, "en").length, 0);
  const r = rate(count, words);
  const dates = sessions.map((s) => localDate(s.startMs, tz)).sort();
  return { sessions: sessions.length, words, count, per100: r.per100, ci95: r.ci95, from: dates[0] ?? null, to: dates.at(-1) ?? null };
}

export function transfer(opts: { sessions: StatSession[]; prereg: TransferPrereg; preregPath: string; drills: DrillEvent[]; nowMs: number; tz?: string; source?: SourceSel }): TransferReport {
  const { prereg } = opts;
  const source = opts.source ?? "bee";
  const minWords = prereg.min_words_per_period;
  const ss = opts.sessions.filter((s) => inSource(s, source)).sort((a, b) => a.startMs - b.startMs);
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
        detail = `95% intervals overlap (before ${before.ci95[0]}-${before.ci95[1]}, after ${after.ci95[0]}-${after.ci95[1]} per 100 words)`;
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
  const headline = dropped.length
    ? `${dropped.map((h) => h.label).join(" and ")} dropped in real speech after drilling${flat ? "; the undrilled control stayed flat" : control.some((h) => h.verdict === "dropped") ? "; but the undrilled control dropped too, so the drop may not be the drill" : "; the control has too little data to compare"}`
    : habits.some((h) => h.role === "drilled" && h.verdict === "not drilled yet")
      ? "Not drilled yet: the after period starts at the first drill"
      : "No drilled habit has dropped measurably yet";
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

export function nextSessionDeltas(sessions: StatSession[], drills: DrillEvent[], tz?: string, source: SourceSel = "bee") {
  const ss = sessions.filter((s) => inSource(s, source)).sort((a, b) => a.startMs - b.startMs);
  const keys = [...new Set(drills.flatMap((d) => d.habitKeys))];
  return keys.map((key) => {
    const first = Math.min(...drills.filter((d) => d.habitKeys.includes(key)).map((d) => d.at));
    const prev = [...ss].reverse().find((s) => s.startMs < first);
    const next = ss.find((s) => s.startMs >= first);
    const one = (s: StatSession | undefined) => (s ? { session: s.id, date: localDate(s.startMs, tz), ...period([s], key, tz) } : null);
    const b = one(prev);
    const a = one(next);
    return { habit: key, label: parseHabitKey(key)?.label ?? key, firstDrillAt: first, lastSessionBefore: b, nextSessionAfter: a, deltaPer100: a && b && a.words && b.words ? r2(a.per100 - b.per100) : null };
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
