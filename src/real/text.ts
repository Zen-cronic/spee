// Per-utterance language detection (mixed lines allowed) and the filler / hedge lexicon used on
// real Bee transcripts. Verified 2026-10-15: Bee keeps fillers, and in French it renders "euh"
// as "um"/"uh", so both languages share um/uh.
export type LineLang = "fr" | "en" | "mixed" | "unk";

const FR_WORDS = new Set(
  (
    "je j' j'ai le la les un une des est et de du au aux pour avec pas c'est on vous nous mon ma mes très " +
    "il elle ils elles qui que qu'il qu'est-ce ce cette ces dans sur mais ou où donc alors parce oui non " +
    "comment dit dire suis sont avoir être fait faire peux pourrais pourriez veux voudrais aussi bien " +
    "d'accord voilà merci bonjour parfois toujours ça y en ne n'est tu te moi toi lui leur notre votre " +
    "puis quand plus moins encore déjà ici là quelque chose rien beaucoup peu avez avons était étais vais va"
  ).split(" "),
);
const EN_WORDS = new Set(
  (
    "i i'm i've i'll i'd the a an is and to of for with it it's that this we you my so but in on at " +
    "be was were are have has had do does did don't doesn't not just like what how why when where who " +
    "yeah yes no right think know say said say something about because if or would could should will " +
    "can can't me your our they them their there here then than also really very good group job"
  ).split(" "),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

export function langScores(text: string): { fr: number; en: number } {
  let fr = 0,
    en = 0;
  for (const w of tokens(text)) {
    if (FR_WORDS.has(w) || /^(j|l|d|n|qu|c|s|m|t)'/.test(w) || /[éèêàçùûôîœ]/.test(w)) fr++;
    else if (EN_WORDS.has(w) || /^\w+'(s|t|re|ve|ll|d|m)$/.test(w)) en++;
  }
  return { fr, en };
}

export function lineLang(text: string): LineLang {
  const { fr, en } = langScores(text);
  if (fr + en === 0) return "unk";
  const share = fr / (fr + en);
  if (fr + en >= 3 && share > 0.2 && share < 0.8 && Math.min(fr, en) >= 2) return "mixed";
  return share >= 0.5 ? "fr" : "en";
}

// Dominant language for metrics; mixed lines count toward their majority language.
export function dominantLang(text: string, fallback: "fr" | "en" = "en"): "fr" | "en" {
  const { fr, en } = langScores(text);
  if (fr === en) return fallback;
  return fr > en ? "fr" : "en";
}

// Filler lexicon, per the operator's spec. EN "like" counts only in filler position (not
// "I like it", "feel like", "looks like", "something like").
export const FILLER_RE = {
  fr: /\b(?:um+|uh+|euh+|heu+|ben|bah)\b/gi,
  en: /\b(?:um+|uh+|you know)\b|(?<!\b(?:i|you|we|they|stuff|things|anything|everything|would|'d|feel|feels|felt|look|looks|looked|sound|sounds|seem|seems|something|just|don't|didn't|really|not|kind|sort)\s)\blike\b(?!\s+(?:to|it|that|this|me|you|him|her|them|us)\b)/gi,
} as const;

export const HEDGE_RE = {
  en: /\b(?:i think|i guess|i feel like|i mean|i don't know|i'm not sure|maybe|probably|possibly|kind of|sort of|hopefully|pretty much|a bit|i would say)\b/gi,
  fr: /\b(?:je pense|je crois|peut-être|peut être|un peu|on va dire|normalement|en fait|je sais pas|je ne sais pas|genre|j'imagine)\b/gi,
} as const;

export const countRe = (text: string, re: RegExp) => (text.match(new RegExp(re.source, re.flags)) ?? []).length;
export const listRe = (text: string, re: RegExp) => (text.match(new RegExp(re.source, re.flags)) ?? []).map((m) => m.toLowerCase());

export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// The lines a habit rate counts: the wearer's English lines, without the ones flagged "maybe not the
// wearer". Stats (src/hub/stats.ts), the settings view and the instrument check (src/real/instruments.ts)
// share it.
export const countedLines = <L extends { uncertain: boolean; dom: "fr" | "en" }>(ls: L[]): L[] => ls.filter((l) => !l.uncertain && l.dom === "en");

// Immediate repetition / restart ("the the", "I I I", "I've been I've been")
export function repeats(text: string): number {
  const t = tokens(text);
  let n = 0;
  for (let i = 1; i < t.length; i++) if (t[i] === t[i - 1]) n++;
  for (let k = 2; k <= 3; k++)
    for (let i = k; i + k <= t.length; i++) if (t.slice(i - k, i).join(" ") === t.slice(i, i + k).join(" ")) n++;
  return n;
}

export function stripFillers(text: string, lang: "fr" | "en"): string {
  return text
    .replace(new RegExp(FILLER_RE[lang].source, "gi"), "")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/([.?!]),/g, "$1") // "ask. Uh, a" -> "ask., a" -> "ask. a"
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+/, "")
    .trim();
}
