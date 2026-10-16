import type { Lang } from "./taxonomy.js";
// Bee exposes no language field (verified by absence), so route by stopword counts.
const FR = new Set("je j'ai le la les un une des est et de du au aux pour avec pas c'est on vous nous mon ma mes très".split(" "));
const EN = new Set("i the a an is and to of for with on it's that this we you my so but in".split(" "));
export function detectLang(text: string): Lang {
  let fr = 0, en = 0;
  for (const w of text.toLowerCase().split(/[\s,.?!]+/)) {
    if (FR.has(w)) fr++;
    if (EN.has(w)) en++;
  }
  return fr > en ? "fr" : "en";
}
