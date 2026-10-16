// The recap after each conversation: the wearer's metrics against the baseline, one short moment
// in the wearer's own words with a rephrase, and template phrasing (headline, narration, wrist).
// Deterministic: the optional model phrasing (live/recapPrompt.ts) only rewords this, and is
// rejected for the template whenever it fails a check.
import type { Recap, RecapHabit } from "../contract.js";
import { RECAP_MOMENT_MAX_WORDS } from "../contract.js";
import { parseHabitKey } from "../habits.js";
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
const SHORT: Record<RecapKey, string> = { hedges: "Hedges", "filler:like": '"Like"', vague: "Vague answers", restart: "Restarts" };
const WRIST: Record<RecapKey, string> = { hedges: "hedges", "filler:like": "likes", vague: "vague", restart: "restarts" };

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
}

export function paceWord(wpm: number | null, base: number | null): "steady" | "fast" | "slow" | null {
  if (wpm == null || base == null) return null;
  return wpm > base * 1.15 ? "fast" : wpm < base * 0.85 ? "slow" : "steady";
}

export function buildRecap(i: RecapInput): Recap {
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

  const longTurn = a.longestMonologueMs >= (i.monologueMs ?? 90_000) ? a.longestMonologueMs : 0; // conversation time (unscaled)
  const turnMin = (Math.round(longTurn / 6000) / 10).toFixed(1);
  let headline: string;
  if (worse[0]) {
    const w = worse[0];
    headline = `${SHORT[w.key as RecapKey]} ran high: ${f1(w.per100)} per 100 words against your usual ${f1(w.baselinePer100!)}.${better[0] ? ` ${SHORT[better[0].key as RecapKey]} was down.` : ""}`;
  } else if (longTurn) headline = `One turn ran ${turnMin} minutes without a break.${hedges.count === 0 ? " No hedges." : ""}`;
  else if (better[0]) {
    const b = better[0];
    headline = b.count === 0 ? `No ${SHORT[b.key as RecapKey].toLowerCase()} this time (usually ${f1(b.baselinePer100!)} per 100 words).` : `${SHORT[b.key as RecapKey]} was down: ${f1(b.per100)} per 100 words against your usual ${f1(b.baselinePer100!)}.`;
  } else if (hedges.baselinePer100 != null) {
    headline = `A typical conversation: ${f1(hedges.per100)} hedges per 100 words against your usual ${f1(hedges.baselinePer100)}.`;
  } else headline = `${a.window.wearer.words} words from you, ${hedges.count} hedges.`;

  const focus = worse[0] ?? hedges;
  const verb: Record<RecapKey, (n: number) => string> = {
    hedges: (n) => (n ? `You hedged ${n} ${n === 1 ? "time" : "times"}` : "You didn't hedge once"),
    "filler:like": (n) => (n ? `You said "like" ${n} ${n === 1 ? "time" : "times"}` : `You never said "like"`),
    vague: (n) => (n ? `You gave ${n} vague ${n === 1 ? "answer" : "answers"}` : "You gave no vague answers"),
    restart: (n) => (n ? `You restarted ${n} ${n === 1 ? "time" : "times"}` : "You never restarted a sentence"),
  };
  const minutes = Math.round(storyMs / 60_000);
  const s1 = minutes >= 1 ? `That conversation ran about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` : "That conversation ran under a minute.";
  const vs = focus.baselinePer100 != null && focus.count > 0 ? `, ${f1(focus.per100)} per 100 words against your usual ${f1(focus.baselinePer100)}` : "";
  const paceClause = wpm == null ? "" : pace === "steady" ? `, and your pace held at ${wpm} words a minute` : pace === "fast" ? `, and you spoke fast at ${wpm} words a minute (usually ${baseWpm})` : pace === "slow" ? `, and you spoke slowly at ${wpm} words a minute (usually ${baseWpm})` : `, at ${wpm} words a minute`;
  const s2 = !worse[0] && longTurn ? `Your longest turn ran ${turnMin} minutes without a break${paceClause}.` : `${verb[focus.key as RecapKey](focus.count)}${vs}${paceClause}.`;
  const s3 = moment ? (moment.habit === "hedges" ? `Try it without the hedges: "${moment.rephrase}"` : `Try it without the "like": "${moment.rephrase}"`) : !worse[0] && longTurn ? "Next time, check in with a question before the 90-second mark." : "";
  const narration = [s1, s2, s3].filter(Boolean).join(" ");
  const what = worse[0] ? `${WRIST[worse[0].key as RecapKey]} high` : longTurn ? "one long turn" : "a typical talk";
  const wristText = clipWrist(`[coach] Recap: ${what}${pace ? `, pace ${pace}` : ""}`);

  return {
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
}
