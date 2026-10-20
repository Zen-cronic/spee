// The product's own voice in a recording (scripts/leak-check.ts, point 11). The coach speaks its
// prompts aloud (Alexa, the simulator, the Vega voice loop), the watch picks them up, and Bee labels
// that voice as another speaker. Those phrases then equal the product's own copy ("you can also ask
// how am I doing"), and a file edited after the recording fails the check although nothing leaked.
//
// A person vouches for each such file with `--approve-product-voice`. The ledger,
// leak-check-product-voice.txt, pins the file's sha256 and the sha256 of each matched phrase, never
// the text. A changed file has a new sha256, so every hit in it is flagged again until a person
// looks again.
//
// What counts as the product's copy can never be the file being checked as it is now: another
// speaker's words pasted into a string literal would vouch for themselves. A phrase is the product's
// only when (productVoice):
//   - it is in a string literal of the same file as it was committed BEFORE the recording started
//     (git history: words that existed before a conversation cannot be from it), or
//   - it is in a string literal of another file of the product's spoken and shown copy
//     (PRODUCT_COPY_RE: the Alexa skill, the simulator, MCP tool text, recap and narration
//     templates, the TV), never a data or fixture file (NOT_EVIDENCE_RE: demo data, demo scripts,
//     contract examples, fixtures), and never the file's own synced copy (tv/web and tv/vega).
import { createHash } from "node:crypto";

export const PRODUCT_VOICE = "leak-check-product-voice.txt";
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

// The product's spoken and shown copy, and the files that are never evidence (synthetic data that
// may hold invented other-speaker lines, and fixtures).
export const PRODUCT_COPY_RE = /^(src\/alexa\/|alexa\/skill-package\/|web\/sim\/|src\/sim\/|src\/mcp\/|src\/hub\/(core|habitNames|failReason|brief|mirror|home)\.ts$|src\/hub\/live\/(recap|engine|rules|policy|wrist|plugin)\.ts$|tv\/web\/src\/|tv\/vega\/src\/)/;
export const NOT_EVIDENCE_RE = /(^|\/)fixtures?\/|^src\/hub\/(demoData|contractExamples|fixtureV2)\.ts$|^src\/hub\/live\/demoScripts\.ts$|\.test\.tsx?$/;
// One origin for a file and its synced copies (scripts/tv-sync.ts): tv/vega/src/x is tv/web/src/x,
// and both apps' contract.ts are src/hub/contract.ts.
export function voiceOrigin(path: string): string {
  if (/^tv\/(web|vega)\/src\/contract\.ts$/.test(path)) return "src/hub/contract.ts";
  return path.replace(/^tv\/vega\/src\//, "tv/web/src/");
}
export const isCopyEvidence = (path: string) => PRODUCT_COPY_RE.test(path) && !NOT_EVIDENCE_RE.test(path);

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

// The copy files' phrases by origin (pass only files that pass isCopyEvidence).
export function copyPhrasesByOrigin(sources: { path: string; text: string }[], words: (s: string) => string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of sources) {
    const o = voiceOrigin(s.path);
    const set = out.get(o) ?? new Set<string>();
    for (const g of productPhrases([s], words)) set.add(g);
    out.set(o, set);
  }
  return out;
}

/**
 * Is `phrase`, flagged in `file`, the product's own copy? Yes when another copy file (not this one,
 * not its synced twin) says it in a literal, or when this file's own literals held it before the
 * recording: `before(phrase)` gives the phrases of the file as committed before the phrase's
 * earliest recording (null when there is no such commit).
 */
export function productVoice(file: string, copy: Map<string, Set<string>>, before: (phrase: string) => Set<string> | null): (phrase: string) => boolean {
  const self = voiceOrigin(file);
  return (g) => {
    for (const [o, set] of copy) if (o !== self && set.has(g)) return true;
    return !!before(g)?.has(g);
  };
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
// `approvable` (the product's own copy by productVoice, not approved yet) and `other` (anything else,
// which can never be approved this way).
export function classifyVoice(key: string, hits: string[], ledger: Map<string, VoiceEntry>, product: (phrase: string) => boolean): { approved: string[]; approvable: string[]; other: string[] } {
  const entry = ledger.get(key);
  const out = { approved: [] as string[], approvable: [] as string[], other: [] as string[] };
  for (const g of hits) {
    if (!product(g)) out.other.push(g);
    else if (entry?.phrases.has(phraseHash(g))) out.approved.push(g);
    else out.approvable.push(g);
  }
  return out;
}
