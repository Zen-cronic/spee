// The grader: "AI finds the habits; code grades the attempt." Grading a spoken attempt is
// deterministic (no model call): the same card and the same attempt text always give the same
// verdict, with the reasons stated.
//
// Rules (GRADER_VERSION 1). An attempt passes only when all of these hold:
//   R1 nonempty  the attempt has at least one word.
//   R2 habit     the card's target habit occurs 0 times beyond its occurrences in the target
//                sentence itself (a hedge card fails on "I guess"; a vague card fails on "that thing").
//   R3 fillers   fillers (taxonomy: EN um/uh/filler "like"/"you know"; FR um/uh/euh/ben/bah)
//                beyond those in the target sentence: at most MAX_FILLERS (0).
//   R4 content   weighted token recall of the target sentence >= CONTENT_THRESHOLD (0.8), with
//                fuzzy word matching for ASR slips (src/hub/fuzzy.ts); function words weigh 0.5.
//   R5 required  every "must say" word (the concrete words the fix introduces) is heard exactly
//                or as a one-edit ASR slip ("car" for "card"); never as a two-edit match
//                ("relapse" for "release") or across days, months and numbers ("Tuesday" for
//                "Thursday", "match" for "March").
// Hedges are always counted and reported; they fail the attempt only on a hedge card (R2).
// R2 and R3 read `habitText` (default: the attempt itself): for a Bee line, the attempt's span plus
// its neighbouring sentences, so a hedge said as its own sentence still counts. Curly and other
// apostrophes are normalized before every habit pattern ("I don’t know" = "I don't know").
import { countPhrase, levenshtein, normTokens, align, type Lang } from "./fuzzy.js";
import { habitMatches, type Habit } from "./habits.js";
import { FILLER_RE, HEDGE_RE, listRe } from "../real/text.js";

export const GRADER_VERSION = 1;
export const MAX_FILLERS = 0;
export const CONTENT_THRESHOLD = 0.8;

export interface GradeCard {
  id?: string;
  lang: Lang;
  resay: string; // the target sentence
  habit: Habit;
  mustSay?: string[];
}

export interface Check {
  rule: "nonempty" | "habit" | "fillers" | "content" | "required";
  ok: boolean;
  detail: string;
}

export interface GradeResult {
  graderVersion: number;
  pass: boolean;
  reasons: string[]; // one line per rule, failures first
  checks: Check[];
  habit: { kind: Habit["kind"]; label: string; hits: number; found: string[] };
  fillerCount: number; // beyond the target sentence's own
  fillers: string[];
  hedgeCount: number; // every hedge heard (reported; fails only on a hedge card)
  hedges: string[];
  contentMatch: number; // 0..1
  contentThreshold: number;
  missing: string[]; // target words not heard
  fuzzy: { target: string; heard: string }[]; // non-exact matches accepted (ASR slips)
  required: { word: string; ok: boolean }[];
}

// Occurrences in `attempt` beyond those in `target` (a word the target itself needs is not a habit).
function excess(attempt: string[], target: string[]): string[] {
  const left = [...target];
  const out: string[] = [];
  for (const a of attempt) {
    const i = left.indexOf(a);
    if (i >= 0) left.splice(i, 1);
    else out.push(a);
  }
  return out;
}

const apos = (s: string) => s.replace(/[’‘`ʼ´]/g, "'");

// Words whose near neighbours are different facts, not ASR slips.
const CLOSED_CLASS = new Set(
  (
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
    "lundi mardi mercredi jeudi vendredi samedi dimanche janvier fevrier février mars avril mai juin juillet aout août septembre octobre novembre decembre décembre " +
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million " +
    "first second third fourth fifth sixth seventh eighth ninth tenth un deux trois quatre cinq sept huit neuf dix onze douze vingt trente quarante cinquante cent mille"
  ).split(" "),
);
const slipOk = (want: string, heard: string) => want === heard || (!CLOSED_CLASS.has(want) && !CLOSED_CLASS.has(heard) && !/\d/.test(want + heard) && levenshtein(want, heard) <= 1);

export function grade(card: GradeCard, attemptText: string, habitText: string = attemptText): GradeResult {
  const lang = card.lang;
  const text = attemptText.trim();
  const habitSrc = apos(habitText.trim() || text);
  const resay = apos(card.resay);
  const target = normTokens(card.resay, lang);
  const heard = normTokens(text, lang);

  const habitFound = excess(habitMatches(card.habit, habitSrc, lang), habitMatches(card.habit, resay, lang));
  const fillers = excess(listRe(habitSrc, FILLER_RE[lang]), listRe(resay, FILLER_RE[lang]));
  const hedges = listRe(habitSrc, HEDGE_RE[lang]);

  const a = align(target, heard);
  const missing = target.filter((_, i) => !a.matched[i]);
  const fuzzy = a.pairs.filter((p) => !p.exact).map(({ target, heard }) => ({ target, heard }));
  const heardSet = new Set(heard);
  const said = (w: string) => {
    const t = normTokens(w, lang);
    if (!t.length) return false;
    if (t.length > 1 ? countPhrase(heard, t) > 0 : heardSet.has(t[0]!)) return true;
    // an ASR slip: every token of the word aligned one-to-one within one edit
    return t.every((tok) => a.pairs.some((p) => p.target === tok && !p.heard.includes(" ") && slipOk(tok, p.heard)));
  };
  const required = (card.mustSay ?? []).map((w) => ({ word: w, ok: said(w) }));

  const checks: Check[] = [];
  checks.push({ rule: "nonempty", ok: heard.length > 0, detail: heard.length ? `${heard.length} words heard` : "nothing was heard" });
  checks.push({
    rule: "habit",
    ok: habitFound.length === 0,
    detail: habitFound.length ? `kept the habit (${card.habit.label}): ${habitFound.map((h) => `"${h}"`).join(", ")}` : `no ${card.habit.label}`,
  });
  checks.push({
    rule: "fillers",
    ok: fillers.length <= MAX_FILLERS,
    detail: fillers.length ? `${fillers.length} filler${fillers.length > 1 ? "s" : ""} (${fillers.map((f) => `"${f}"`).join(", ")}); allowed ${MAX_FILLERS}` : "no fillers",
  });
  checks.push({
    rule: "content",
    ok: a.score >= CONTENT_THRESHOLD,
    detail: `content match ${Math.round(a.score * 100)}% (needs ${Math.round(CONTENT_THRESHOLD * 100)}%)${missing.length ? `; missing: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}` : ""}${fuzzy.length ? `; accepted as ASR slips: ${fuzzy.map((f) => `"${f.heard}" for "${f.target}"`).join(", ")}` : ""}`,
  });
  if (required.length)
    checks.push({
      rule: "required",
      ok: required.every((r) => r.ok),
      detail: required.every((r) => r.ok) ? `said ${required.map((r) => `"${r.word}"`).join(", ")}` : `did not say ${required.filter((r) => !r.ok).map((r) => `"${r.word}"`).join(", ")}`,
    });
  const pass = checks.every((c) => c.ok);
  const reasons = [...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)].map((c) => `${c.ok ? "ok" : "FAIL"} ${c.rule}: ${c.detail}`);
  return {
    graderVersion: GRADER_VERSION,
    pass,
    reasons,
    checks,
    habit: { kind: card.habit.kind, label: card.habit.label, hits: habitFound.length, found: habitFound },
    fillerCount: fillers.length,
    fillers,
    hedgeCount: hedges.length,
    hedges,
    contentMatch: a.score,
    contentThreshold: CONTENT_THRESHOLD,
    missing,
    fuzzy,
    required,
  };
}
