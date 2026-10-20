// The product's own voice in a recording (scripts/leak-check.ts, point 11). The coach speaks its
// prompts aloud (Alexa, the simulator, the Vega voice loop), the watch picks them up, and Bee labels
// that voice as another speaker. Those phrases then equal the product's own copy ("you can also ask
// how am I doing"), and a file edited after the recording fails the check although nothing leaked.
//
// A person vouches for each such file with `--approve-product-voice`. The ledger,
// leak-check-product-voice.txt, pins the file's sha256 and the sha256 of each matched phrase, never
// the text. Only a phrase that also appears inside one of the product's own string literals (or the
// text of a tracked HTML page) can be approved. A changed file has a new sha256, so every hit in it
// is flagged again until a person looks again.
import { createHash } from "node:crypto";

export const PRODUCT_VOICE = "leak-check-product-voice.txt";
export const PRODUCT_SOURCE_RE = /^(src|web|tv\/web\/src|tv\/vega\/src|alexa)\/.*\.(ts|tsx|js|mjs|html|json)$/;
const MIN_N = 3;
const MAX_N = 5;

export const phraseHash = (phrase: string) => createHash("sha256").update(phrase).digest("hex").slice(0, 32);

// String literals of a source file ('...', "...", `...` with ${...} breaking the text), and for an
// HTML page its text between tags too. Each is returned as one piece of text.
export function literalTexts(source: string, html = false): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(...body.split(/\$\{[^}]*\}/));
  }
  if (html) out.push(...source.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").split(/<[^>]*>/));
  return out.filter((t) => /\p{L}/u.test(t));
}

// Every 3- to 5-word run inside one literal, folded by `words`: the phrases the product can say.
export function productPhrases(sources: { path: string; text: string }[], words: (s: string) => string[]): Set<string> {
  const out = new Set<string>();
  for (const s of sources)
    for (const lit of literalTexts(s.text, s.path.endsWith(".html"))) {
      const w = words(lit.replace(/\\[nrt]/g, " "));
      for (let n = MIN_N; n <= MAX_N; n++) for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
    }
  return out;
}

// One ledger line: "<file sha256>  <path>  <phrase hash>,<phrase hash>,...".
export interface VoiceEntry {
  sha: string;
  path: string;
  phrases: Set<string>;
}
export function parseVoiceLedger(text: string): Map<string, VoiceEntry> {
  const out = new Map<string, VoiceEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [sha, path, list] = line.split("  ");
    if (!sha || !path || !/^[0-9a-f]{64}$/.test(sha)) continue;
    out.set(`${sha}  ${path}`, { sha, path, phrases: new Set((list ?? "").split(",").filter(Boolean)) });
  }
  return out;
}
export function formatVoiceLedger(entries: VoiceEntry[]): string {
  const lines = [...entries].sort((a, b) => a.path.localeCompare(b.path)).map((e) => `${e.sha}  ${e.path}  ${[...e.phrases].sort().join(",")}`);
  return `# Files whose other-speaker hits are the product's own spoken copy (Bee labelled the coach's voice as another speaker), vouched for by a person (scripts/leak-check.ts --approve-product-voice). File sha256, path, sha256 of each matched phrase; never the text.\n${lines.join("\n")}\n`;
}

// A file's fresh other-speaker hits, split: `approved` (in the ledger for this exact file content),
// `approvable` (the product says it in a literal, not approved yet) and `other` (anything else, which
// can never be approved this way).
export function classifyVoice(key: string, hits: string[], ledger: Map<string, VoiceEntry>, product: Set<string>): { approved: string[]; approvable: string[]; other: string[] } {
  const entry = ledger.get(key);
  const out = { approved: [] as string[], approvable: [] as string[], other: [] as string[] };
  for (const g of hits) {
    if (!product.has(g)) out.other.push(g);
    else if (entry?.phrases.has(phraseHash(g))) out.approved.push(g);
    else out.approvable.push(g);
  }
  return out;
}
