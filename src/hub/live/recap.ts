// The recap after each conversation: the wearer's metrics against the baseline, one short moment
// in the wearer's own words with a rephrase, and template phrasing (headline, narration, wrist).
// Deterministic: the optional model phrasing (live/recapPrompt.ts) only rewords this, and is
// rejected for the template whenever it fails a check.
import type { Recap, RecapHabit } from "../contract.js";
import { RECAP_MOMENT_MAX_WORDS } from "../contract.js";
import { parseHabitKey } from "../habits.js";
import { habitNameOf, habitTitle } from "../habitNames.js";
import { stripHedges } from "../realCards.js";
import { countHabitKey } from "../habits.js";
import { HEDGE_RE, listRe, stripFillers, wordCount } from "../../real/text.js";
import type { Baseline } from "./baseline.js";
import { clipWrist } from "./rules.js";
import type { Analysis, ConversationWindow } from "./window.js";

const r2 = (x: number) => Math.round(x * 100) / 100;
const f1 = (x: number) => x.toFixed(1);

export const RECAP_HABITS = ["hedges", "filler:like", "vague", "restart"] as const;
type RecapKey = (typeof RECAP_HABITS)[number];
// Display names come from habitNames.ts; the wrist line has no quotes, so "like" is spelled out.
const WRIST: Record<RecapKey, string> = { hedges: "more unsure words than usual", "filler:like": "more filler likes than usual", vague: "more vague answers than usual", restart: "started over more than usual" };
// "Unsure words were down", 'Filler "like" was down'.
const was = (k: RecapKey) => (/s$/.test(habitNameOf(k)) ? "were" : "was");

// Better or worse than usual: a Poisson z-score of the count against the baseline expectation,
// |z| >= 1 (a conversation is a small sample, so this is a nudge, not a test).
export function verdictOf(count: number, words: number, basePer100: number | null): RecapHabit["verdict"] {
  if (basePer100 == null || !words) return "no-baseline";
  const expected = (basePer100 / 100) * words;
  const z = (count - expected) / Math.sqrt(Math.max(expected, 1));
  return z >= 1 ? "worse" : z <= -1 ? "better" : "typical";
}
const zOf = (h: RecapHabit, words: number) => (h.baselinePer100 == null ? 0 : (h.count - (h.baselinePer100 / 100) * words) / Math.sqrt(Math.max((h.baselinePer100 / 100) * words, 1)));

export function recapHabits(a: Analysis, baseline: Baseline | null): RecapHabit[] {
  const words = a.englishWords;
  const t = a.window.totals;
  const rows: [RecapKey, number, number | null][] = [
    ["hedges", t.hedges, baseline?.hedgesPer100 ?? null],
    ["filler:like", t.likes, baseline?.likesPer100 ?? null],
    ["vague", t.vague, baseline?.vaguePer100 ?? null],
    ["restart", t.restarts, baseline?.restartsPer100 ?? null],
  ];
  return rows.map(([key, count, base]) => ({ key, label: parseHabitKey(key)!.label, count, per100: words ? r2((count / words) * 100) : 0, baselinePer100: base, verdict: verdictOf(count, words, base) }));
}

const tidy = (s: string) => {
  const t = s.replace(/\s+([,.?!])/g, "$1").replace(/,(\s*,)+/g, ",").replace(/^[\s,]+/, "").replace(/\s{2,}/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

// One sentence of the wearer's own (<= 12 words) that shows the habit, and the same sentence
// without it. Only hedges and "like" have a mechanical rephrase.
export function pickMoment(win: ConversationWindow, habits: RecapHabit[], words: number, maxWords = RECAP_MOMENT_MAX_WORDS): Recap["moment"] {
  const order = [
    ...habits.filter((h) => h.verdict === "worse").sort((a, b) => zOf(b, words) - zOf(a, words)).map((h) => h.key),
    "hedges",
    "filler:like",
  ].filter((k, i, xs) => (k === "hedges" || k === "filler:like") && xs.indexOf(k) === i);
  const sents = win.wearerSentences().filter((s) => {
    const n = wordCount(s.text);
    return n >= 4 && n <= maxWords;
  });
  for (const key of order) {
    const cands = sents
      .map((s) => {
        const hits = key === "hedges" ? [...new Set(listRe(s.text, HEDGE_RE.en))] : [];
        const n = key === "hedges" ? hits.length : countHabitKey("filler:like", s.text);
        const rephrase = key === "hedges" ? stripHedges(s.text, hits) : tidy(stripFillers(s.text.replace(/,\s*like\s*,/gi, " "), "en"));
        return { s, n, rephrase };
      })
      .filter((c) => c.n > 0 && wordCount(c.rephrase) >= 3 && c.rephrase.toLowerCase() !== c.s.text.toLowerCase())
      .sort((a, b) => b.n - a.n || a.s.line.ctStart - b.s.line.ctStart);
    const c = cands[0];
    if (c) return { text: c.s.text.trim(), at: c.s.line.spokenAt, habit: key, rephrase: c.rephrase };
  }
  return null;
}

export interface RecapInput {
  id: string;
  win: ConversationWindow;
  a: Analysis;
  baseline: Baseline | null;
  endedAt: number;
  createdAt: number;
  pace: number;
  dataLabel: string;
  synthetic: boolean;
  delivery: Recap["delivery"];
  momentMaxWords?: number;
  monologueMs?: number; // a turn this long leads the recap when no habit ran high
  // The baseline is the wearer's usual in this conversation's setting: "in meetings" follows each
  // "usual" (src/hub/settings.ts SETTING_WHERE). Absent: the overall usual, worded as before.
  usualWhere?: string;
}

export function paceWord(wpm: number | null, base: number | null): "steady" | "fast" | "slow" | null {
  if (wpm == null || base == null) return null;
  return wpm > base * 1.15 ? "fast" : wpm < base * 0.85 ? "slow" : "steady";
}

// The template's numbers as named slots: the phrasing a model may write uses these names in braces
// ({hedges_rate}) and code fills in the values, so a model never writes a number itself
// (live/recapPrompt.ts). `template` is the recap's own phrasing with every number as its slot.
export interface RecapSlots {
  values: Record<string, string>;
  template: { headline: string; narration: string; wristText: string };
}
// Slot-name stems per habit: {hedges_count}, {like_rate}, {vague_usual}, {restarts_count}.
export const SLOT_HABIT: Record<RecapKey, string> = { hedges: "hedges", "filler:like": "like", vague: "vague", restart: "restarts" };

export function buildRecap(i: RecapInput): Recap {
  return composeRecap(i).recap;
}

export function composeRecap(i: RecapInput): { recap: Recap; slots: RecapSlots } {
  const { a, baseline } = i;
  const words = a.englishWords;
  const habits = recapHabits(a, baseline);
  const worse = habits.filter((h) => h.verdict === "worse").sort((x, y) => zOf(y, words) - zOf(x, words));
  const better = habits.filter((h) => h.verdict === "better").sort((x, y) => zOf(x, words) - zOf(y, words));
  const moment = pickMoment(i.win, habits, words, i.momentMaxWords);
  const wpm = a.window.wearer.wpm;
  const baseWpm = baseline?.wpm ?? null;
  const pace = paceWord(wpm, baseWpm);
  const storyMs = (i.endedAt - i.win.startedAt) / i.pace;
  const hedges = habits.find((h) => h.key === "hedges")!;

  // Every number below goes through a slot: `{name}` in the template, its value in `values`.
  const values: Record<string, string> = {};
  const slot = (name: string, value: string | number) => ((values[name] = String(value)), `{${name}}`);
  const rate = (h: RecapHabit) => slot(`${SLOT_HABIT[h.key as RecapKey]}_rate`, f1(h.per100));
  const where = i.usualWhere ? ` ${i.usualWhere}` : "";
  // "your usual {hedges_usual} in meetings": the setting is words, never a slot
  const usual = (h: RecapHabit) => `${slot(`${SLOT_HABIT[h.key as RecapKey]}_usual`, f1(h.baselinePer100!))}${where}`;
  const count = (h: RecapHabit) => slot(`${SLOT_HABIT[h.key as RecapKey]}_count`, h.count);
  // Every habit's count may be named, whatever the template says ("no unsure words" may become "{hedges_count} unsure words").
  for (const h of habits) values[`${SLOT_HABIT[h.key as RecapKey]}_count`] = String(h.count);

  const longTurn = a.longestMonologueMs >= (i.monologueMs ?? 90_000) ? a.longestMonologueMs : 0; // conversation time (unscaled)
  const turnMin = (Math.round(longTurn / 6000) / 10).toFixed(1);
  let headline: string;
  if (worse[0]) {
    const w = worse[0];
    // With the setting named ("... your usual 1.4 at work.") the headline has no room for the habit that
    // was down: the TV shows it two lines high, and the rows below already say "Fewer".
    headline = `${habitTitle(w.key)} ran high: ${rate(w)} per 100 words against your usual ${usual(w)}.${better[0] && !where ? ` ${habitTitle(better[0].key)} ${was(better[0].key as RecapKey)} down.` : ""}`;
  } else if (longTurn) headline = `A long turn: ${slot("longest_turn_min", turnMin)} minutes without a break.${hedges.count === 0 ? " No unsure words." : ""}`;
  else if (better[0]) {
    const b = better[0];
    headline = b.count === 0 ? `No ${habitNameOf(b.key)} this time (usually ${slot(`${SLOT_HABIT[b.key as RecapKey]}_usual`, f1(b.baselinePer100!))} per 100 words${where}).` : `${habitTitle(b.key)} ${was(b.key as RecapKey)} down: ${rate(b)} per 100 words against your usual ${usual(b)}.`;
  } else if (hedges.baselinePer100 != null) {
    headline = `A typical conversation: unsure words at ${rate(hedges)} per 100 words, against your usual ${usual(hedges)}.`;
  } else headline = `${slot("words", a.window.wearer.words)} words from you, ${count(hedges)} of them unsure words.`;

  const focus = worse[0] ?? hedges;
  const verb: Record<RecapKey, (n: number) => string> = {
    hedges: (n) => (n ? `You used ${count(focus)} unsure ${n === 1 ? "word" : "words"}` : "You didn't use any unsure words"),
    "filler:like": (n) => (n ? `You said "like" ${count(focus)} ${n === 1 ? "time" : "times"}` : `You never said "like"`),
    vague: (n) => (n ? `You gave ${count(focus)} vague ${n === 1 ? "answer" : "answers"}` : "You gave no vague answers"),
    restart: (n) => (n ? `You started over ${count(focus)} ${n === 1 ? "time" : "times"}` : "You never had to start over"),
  };
  const minutes = Math.round(storyMs / 60_000);
  const s1 = minutes >= 1 ? `That conversation ran about ${slot("minutes", minutes)} ${minutes === 1 ? "minute" : "minutes"}.` : "That conversation ran under a minute.";
  const vs = focus.baselinePer100 != null && focus.count > 0 ? `, ${rate(focus)} out of every 100 words you said against your usual ${usual(focus)}` : "";
  const w = () => slot("wpm", wpm!);
  const bw = () => slot("usual_wpm", baseWpm!);
  const paceClause = wpm == null ? "" : pace === "steady" ? `, and your pace held at ${w()} words a minute` : pace === "fast" ? `, and you spoke fast at ${w()} words a minute (usually ${bw()})` : pace === "slow" ? `, and you spoke slowly at ${w()} words a minute (usually ${bw()})` : `, at ${w()} words a minute`;
  const s2 = !worse[0] && longTurn ? `Your longest turn ran ${slot("longest_turn_min", turnMin)} minutes without a break${paceClause}.` : `${verb[focus.key as RecapKey](focus.count)}${vs}${paceClause}.`;
  const s3 = moment ? (moment.habit === "hedges" ? `Try it without the unsure words: "${moment.rephrase}"` : `Try it without the "like": "${moment.rephrase}"`) : !worse[0] && longTurn ? `Next time, check in with a question before the ${slot("check_in_seconds", 90)}-second mark.` : "";
  const narrationT = [s1, s2, s3].filter(Boolean).join(" ");
  const what = worse[0] ? WRIST[worse[0].key as RecapKey] : longTurn ? "a long turn" : "a typical chat";
  const wristT = `[coach] Recap: ${what}${pace ? `, pace ${pace}` : ""}`;
  const fill = (t: string) => fillSlots(t, values);
  const narration = fill(narrationT);
  const wristText = clipWrist(fill(wristT));
  const slots: RecapSlots = { values, template: { headline, narration: narrationT, wristText: wristT } };
  headline = fill(headline);

  const recap: Recap = {
    dataLabel: i.dataLabel,
    synthetic: i.synthetic,
    id: i.id,
    conversationId: i.win.conversationId,
    startedAt: i.win.startedAt,
    endedAt: i.endedAt,
    durationMs: Math.max(0, i.endedAt - i.win.startedAt),
    createdAt: i.createdAt,
    replay: i.win.replay,
    metrics: {
      wearerWords: a.window.wearer.words,
      wpm,
      baselineWpm: baseWpm,
      talkShare: a.window.talkShare,
      longestMonologueMs: a.longestMonologueMs,
      pauses: { ...a.window.pauses },
      habits,
    },
    headline,
    moment,
    narration,
    wristText,
    phrasing: "template",
    nudges: { ...i.win.nudges },
    delivery: i.delivery,
  };
  return { recap, slots };
}

/** `{name}` placeholders replaced by their values; an unknown name is left as it is. */
export function fillSlots(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (m, name: string) => values[name] ?? m);
}
