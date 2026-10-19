// Deterministic text normalization and fuzzy token alignment for grading spoken attempts.
// No model calls: the same two strings always give the same alignment.
//
// ASR slips seen live on Bee (2026-10-16 spike): "card" -> "car", "Rack Board" -> "rec board".
// Two tolerances cover them:
//   1. edit distance on the word, or on a light phonetic key ("rec" -> "rek", "rack" -> "rak"),
//      with a length-scaled budget and the first letter fixed;
//   2. compound joins ("standup" ~ "stand up", "rackboard" ~ "rack board").
import { FILLER_RE, HEDGE_RE } from "../real/text.js";

export type Lang = "en" | "fr";

// Function words count half toward content match: ASR drops and swaps them most.
export const FUNCTION_WORDS = new Set(
  (
    "a an the and or but so to of in on at for with from by as is are was were be been am it its this that these those " +
    "i you he she we they me us him her them my your our their do does did not no will would can could should have has had " +
    "le la les un une des de du au aux et ou en à a est sont je tu il elle on nous vous ils elles ce ça que qui ne pas j l d n c s m t qu y"
  ).split(" "),
);

const EN_CONTRACTIONS: [RegExp, string][] = [
  [/\bwon't\b/g, "will not"],
  [/\bcan't\b/g, "can not"],
  [/\bcannot\b/g, "can not"],
  [/\blet's\b/g, "let us"],
  [/n't\b/g, " not"],
  [/'re\b/g, " are"],
  [/'ve\b/g, " have"],
  [/'ll\b/g, " will"],
  [/'m\b/g, " am"],
  [/'d\b/g, " would"],
  [/'s\b/g, " is"],
];

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const NUM_WORDS_FR = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze"];

// Lowercased word tokens. English contractions are expanded and French elisions split, so
// "it's" ~ "it is" and "j'ai" ~ "j ai". Hyphens split ("follow-up" ~ "follow up"). Digits 0-12
// become words ("2" ~ "two").
export function normTokens(text: string, lang: Lang = "en"): string[] {
  let s = text.toLowerCase().replace(/[’`ʼ]/g, "'");
  if (lang === "en") for (const [re, rep] of EN_CONTRACTIONS) s = s.replace(re, rep);
  s = s.replace(/'/g, " ").replace(/-/g, " ");
  return s
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) && Number(w) <= 12 ? (lang === "fr" ? NUM_WORDS_FR : NUM_WORDS)[Number(w)]! : w));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

// A light English-leaning phonetic key: hard c / ck / q -> k, soft c -> s, ph -> f, doubled
// letters collapsed, a silent final e dropped. Accents are folded.
export function phoneticKey(w: string): string {
  return w
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1")
    .replace(/(?<=...)e$/, "");
}

// Edit budget by the shorter word's length: 1-2 letters exact, 3-5 letters 1 edit, 6+ letters 2.
export const editBudget = (shorter: number) => (shorter <= 2 ? 0 : shorter <= 5 ? 1 : 2);

export function fuzzyEq(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  const budget = editBudget(n);
  if (!budget || a[0] !== b[0]) {
    // The phonetic key can still align a first letter (c/k): compare keys below.
    const ka = phoneticKey(a);
    const kb = phoneticKey(b);
    if (ka === kb && n >= 3) return true;
    if (!budget || ka[0] !== kb[0]) return false;
    return levenshtein(ka, kb) <= editBudget(Math.min(ka.length, kb.length));
  }
  if (levenshtein(a, b) <= budget) return true;
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  return ka[0] === kb[0] && levenshtein(ka, kb) <= editBudget(Math.min(ka.length, kb.length));
}

export const tokenWeight = (w: string) => (FUNCTION_WORDS.has(w) ? 0.5 : 1);

export interface Alignment {
  matched: boolean[]; // per target token
  pairs: { target: string; heard: string; exact: boolean; at: number }[]; // in target order; `at` = index of the (first) heard token
  score: number; // weighted recall over the target, 0..1
  heardUsed: number; // attempt tokens consumed by the alignment
}

// Order-preserving alignment of target tokens onto attempt tokens (a fuzzy longest common
// subsequence), maximizing matched target weight. Merges: two target tokens may match one heard
// token ("stand up" ~ "standup") and one target token may match two heard ones.
export function align(target: string[], heard: string[]): Alignment {
  const n = target.length;
  const m = heard.length;
  const W = target.map(tokenWeight);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  type Move = 0 | 1 | 2 | 3 | 4 | 5; // 0 none, 1 skip target, 2 skip heard, 3 match, 4 two targets to one heard, 5 one target to two heard
  const mv: Move[][] = Array.from({ length: n + 1 }, () => new Array<Move>(m + 1).fill(0));
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n || j === m) {
        dp[i]![j] = 0;
        mv[i]![j] = i < n ? 1 : j < m ? 2 : 0;
        continue;
      }
      let best = dp[i + 1]![j]!;
      let move: Move = 1;
      if (dp[i]![j + 1]! > best) (best = dp[i]![j + 1]!), (move = 2);
      if (fuzzyEq(target[i]!, heard[j]!) && W[i]! + dp[i + 1]![j + 1]! > best) (best = W[i]! + dp[i + 1]![j + 1]!), (move = 3);
      if (i + 1 < n && fuzzyEq(target[i]! + target[i + 1]!, heard[j]!) && W[i]! + W[i + 1]! + dp[i + 2]![j + 1]! > best)
        (best = W[i]! + W[i + 1]! + dp[i + 2]![j + 1]!), (move = 4);
      if (j + 1 < m && fuzzyEq(target[i]!, heard[j]! + heard[j + 1]!) && W[i]! + dp[i + 1]![j + 2]! > best) (best = W[i]! + dp[i + 1]![j + 2]!), (move = 5);
      dp[i]![j] = best;
      mv[i]![j] = move;
    }
  }
  const matched = new Array<boolean>(n).fill(false);
  const pairs: Alignment["pairs"] = [];
  let i = 0,
    j = 0,
    used = 0;
  while (i < n && j < m) {
    const move = mv[i]![j]!;
    if (move === 1) i++;
    else if (move === 2) j++;
    else if (move === 3) {
      matched[i] = true;
      pairs.push({ target: target[i]!, heard: heard[j]!, exact: target[i] === heard[j], at: j });
      i++, j++, used++;
    } else if (move === 4) {
      matched[i] = matched[i + 1] = true;
      pairs.push({ target: `${target[i]} ${target[i + 1]}`, heard: heard[j]!, exact: false, at: j });
      i += 2, j++, used++;
    } else if (move === 5) {
      matched[i] = true;
      pairs.push({ target: target[i]!, heard: `${heard[j]} ${heard[j + 1]}`, exact: false, at: j + 1 });
      i++, j += 2, used += 2;
    } else break;
  }
  const total = W.reduce((a, b) => a + b, 0);
  return { matched, pairs, score: total ? Math.round((dp[0]![0]! / total) * 1000) / 1000 : 0, heardUsed: used };
}

// Symmetric similarity for matching a Bee utterance to a phone attempt (Dice over aligned weight).
export function similarity(a: string, b: string, lang: Lang = "en"): number {
  const ta = normTokens(a, lang);
  const tb = normTokens(b, lang);
  if (!ta.length || !tb.length) return 0;
  const ab = align(ta, tb).score;
  const ba = align(tb, ta).score;
  return Math.round(((2 * ab * ba) / (ab + ba || 1)) * 1000) / 1000;
}

// Count occurrences of a phrase (as a contiguous token sequence) in a token list.
export function countPhrase(tokens: string[], phrase: string[]): number {
  if (!phrase.length || phrase.length > tokens.length) return 0;
  let n = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) if (phrase.every((p, k) => tokens[i + k] === p)) n++;
  return n;
}

// The part of a Bee line that is the attempt. Bee can merge the drill sentence with what the
// wearer said next ("... this morning. How did I do?") or before it, so whole sentences with no
// word aligned to the target are cut before the content and required-word rules. A sentence
// holding any aligned word is kept whole, so a habit inside it ("Um, the ...") is still graded.
// `habitText` is the span plus the bare habit sentences right next to it: a hedge or filler said as
// its own sentence ("... this morning. I guess.", "Maybe. The deploy ...", "Um. The ...") is still
// the attempt, so the habit and filler rules read it. A neighbour with any other word in it ("Um,
// how did I do?") is the wearer's next remark, not the attempt, and stays out.
export function attemptSpan(target: string, beeText: string, lang: Lang = "en"): { graded: string; extra: string; habitText: string } {
  const sents = beeText.trim().split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sents.length <= 1) return { graded: beeText.trim(), extra: "", habitText: beeText.trim() };
  const counts = sents.map((x) => normTokens(x, lang).length);
  const a = align(normTokens(target, lang), sents.flatMap((x) => normTokens(x, lang)));
  if (!a.pairs.length) return { graded: beeText.trim(), extra: "", habitText: beeText.trim() };
  const sentOf = (k: number) => {
    let acc = 0;
    for (let i = 0; i < counts.length; i++) if (k < (acc += counts[i]!)) return i;
    return counts.length - 1;
  };
  const first = sentOf(a.pairs[0]!.at);
  const last = sentOf(a.pairs.at(-1)!.at);
  let from = first;
  let to = last;
  while (from > 0 && bareHabit(sents[from - 1]!, lang)) from--;
  while (to < sents.length - 1 && bareHabit(sents[to + 1]!, lang)) to++;
  return {
    graded: sents.slice(first, last + 1).join(" "),
    extra: [...sents.slice(0, first), ...sents.slice(last + 1)].join(" "),
    habitText: sents.slice(from, to + 1).join(" "),
  };
}

// A sentence made of hedges and fillers, plus at most two tag words ("I guess.", "Um.", "Maybe, I
// think.", "I guess so.", "Yeah, I think so.", "Je pense que oui.", "Je crois que si."): the
// attempt's own trailing hedge, not a new remark.
const TAG_WORDS: Record<Lang, Set<string>> = {
  en: new Set(["so", "yeah", "yes", "ok", "okay", "right", "anyway", "then", "really", "too", "well", "not"]),
  fr: new Set(["oui", "ouais", "bon", "voilà", "voila", "alors", "donc", "quoi", "bref", "non", "pas", "que", "si"]),
};
function bareHabit(sentence: string, lang: Lang): boolean {
  const rest = sentence.replace(new RegExp(HEDGE_RE[lang].source, "gi"), " ").replace(new RegExp(FILLER_RE[lang].source, "gi"), " ");
  if (rest === sentence) return false;
  const left = rest.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return left.length <= 2 && left.every((w) => TAG_WORDS[lang].has(w));
}
