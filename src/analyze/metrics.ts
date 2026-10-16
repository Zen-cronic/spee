// Deterministic lexical metrics. Wearer attribution is impossible in group conversations,
// so every metric is per channel: all speakers (conversations) or wearer-only (voice notes).
import type { Lang } from "./taxonomy.js";

const FILLERS: Record<Lang, RegExp> = {
  en: /\b(um+|uh+|er+m?|you know)\b|(?<=\s|,\s|^)like(?=,|\s+(?:uh|um|the|a|an|this|that|it|we|you|i|start|done|almost|putting|in|on|to)\b)/gi,
  fr: /\b(euh+|heu+|hum+|ben|bah|du coup|genre)\b/gi,
};
const HEDGES: Record<Lang, RegExp> = {
  en: /\b(i think|i guess|i feel like|i mean|maybe|probably|possibly|kind of|sort of|hopefully|pretty much|a bit|i would say)\b/gi,
  fr: /\b(je pense|je crois|peut-être|un peu|on va dire|normalement|en fait)\b/gi,
};
// A cross-source filler list, for a like-for-like comparison with a published 9-day real-Bee
// log (0.10-0.34 fillers per 100 tokens).
const CROSS_SOURCE_FILLERS = /\b(um|uh|er|erm|ah|hmm|mm|mhm|uhm|hm)\b/gi;
const REPEAT = /\b(\p{L}+)\s+\1\b/giu;

export const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export interface Metrics {
  words: number;
  fillersPer100: number;
  hedgesPer100: number;
  repeatsPer100: number;
  crossSourceFillersPer100: number;
  medianWordsPerSec: number | null;
}

export function lexical(lang: Lang, texts: string[], spans?: { start: number | null; end: number | null }[]): Metrics {
  const all = texts.join(" \n ");
  const w = words(all) || 1;
  const count = (re: RegExp) => (all.match(re) ?? []).length;
  let median: number | null = null;
  if (spans) {
    const rates = texts
      .map((t, i) => {
        const s = spans[i];
        if (!s || s.start == null || s.end == null || s.end - s.start < 0.5) return null;
        return words(t) / (s.end - s.start);
      })
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b);
    if (rates.length) median = rates[Math.floor(rates.length / 2)]!;
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    words: w,
    fillersPer100: r((count(FILLERS[lang]) / w) * 100),
    hedgesPer100: r((count(HEDGES[lang]) / w) * 100),
    repeatsPer100: r((count(REPEAT) / w) * 100),
    crossSourceFillersPer100: r((count(CROSS_SOURCE_FILLERS) / Math.max(1, all.split(/\s+/).filter(Boolean).length)) * 100),
    medianWordsPerSec: median == null ? null : r(median),
  };
}
