// On-screen masking of private terms: display-only redaction, for filming the product with real data.
//
// Terms come from two gitignored files, one term per line, "#" starts a comment line:
//   coach/private-terms.local.txt   the leak check's banned terms (scripts/leak-check.ts)
//   coach/mask-terms.local.txt      extra names to hide on screen (optional)
// Each term is matched case-insensitively as a whole word (a multi-word phrase matches across any
// run of spaces): "Acme" hides "acme" and "ACME's" but not "Acmeville". On a screen it becomes
// MASK_SCREEN; in speech (Alexa, MCP text an assistant reads aloud) it becomes MASK_SPEECH.
//
// Masking is output-only. The hub grades, stores and counts the unmasked text; only what leaves
// the hub for a person to see or hear goes through maskOut / maskDeep, in the serialize path
// (src/hub/server.ts: the JSON writer, SSE, the bridge's send, the home page; the MCP tool result;
// the wrist to-do text). The terms themselves are never served, logged or printed: health shows
// only maskStatus() ("on (N terms)" or "off").
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MaskMode = "screen" | "speech";
export const MASK_SCREEN = "▒▒▒";
export const MASK_SPEECH = "name";
export const MASK_FILES = ["private-terms.local.txt", "mask-terms.local.txt"] as const;
// A term shorter than this is ignored: one or two letters would blank ordinary words.
export const MASK_MIN_TERM = 3;

/** The terms in one file's text: trimmed non-empty lines that do not start with "#", deduplicated case-insensitively. */
export function parseMaskTerms(text: string): string[] {
  const seen = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t || t.startsWith("#") || t.length < MASK_MIN_TERM) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

/** Every term in `<dir>/private-terms.local.txt` and `<dir>/mask-terms.local.txt` (either may be missing). */
export function loadMaskTerms(dir: string): string[] {
  const all: string[] = [];
  for (const f of MASK_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) all.push(...parseMaskTerms(readFileSync(p, "utf8")));
  }
  return parseMaskTerms(all.join("\n"));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regex for every term, longest first, so "Jordan Quill" wins over "Jordan". Null without terms. */
export function maskRegex(terms: string[]): RegExp | null {
  const alts = [...new Set(terms.map((t) => t.trim().replace(/\s+/g, " ")).filter((t) => t.length >= MASK_MIN_TERM))]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.split(" ").map(escape).join("\\s+"));
  if (!alts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

let active: { re: RegExp | null; count: number } = { re: null, count: 0 };

/** Set the hub's terms (startHubServer does this once). An empty list turns masking off. */
export function setMaskTerms(terms: string[]): void {
  const re = maskRegex(terms);
  active = { re, count: re ? new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= MASK_MIN_TERM)).size : 0 };
}

/** What health may say about masking: the count only, never a term. */
export function maskStatus(): string {
  return active.re ? `on (${active.count} term${active.count === 1 ? "" : "s"})` : "off";
}

export const maskingOn = (): boolean => !!active.re;

/** A text with every private term replaced, for a screen ("▒▒▒") or for speech ("name"). */
export function maskOut(text: string, mode: MaskMode): string {
  const re = active.re;
  if (!re || !text) return text;
  re.lastIndex = 0;
  return text.replace(re, mode === "speech" ? MASK_SPEECH : MASK_SCREEN);
}

// Fields that hold identifiers, enums, codes or links, never wording a person reads: left as they
// are, so ids still match between surfaces and the hub.
const KEEP_KEYS = new Set(["id", "key", "session", "habit", "type", "kind", "status", "topic", "code", "mode", "source", "role", "lang", "dom", "verdict", "claim", "rule", "via", "path", "route", "phrasing", "agreement", "url", "seq", "at", "date", "from", "to", "registeredAt", "generatedAt", "now"]);
const KEEP_SUFFIX = /(Id|Ids|Url|Key|Keys|At)$/;

/** A copy of `value` with maskOut applied to every string, except identifier fields (KEEP_KEYS). Object keys are left alone. */
export function maskDeep<T>(value: T, mode: MaskMode): T {
  if (!active.re) return value;
  const walk = (v: unknown, keep: boolean): unknown => {
    if (typeof v === "string") return keep ? v : maskOut(v, mode);
    if (Array.isArray(v)) return v.map((x) => walk(x, keep));
    if (v && typeof v === "object") {
      if (v instanceof Date) return v;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, KEEP_KEYS.has(k) || KEEP_SUFFIX.test(k));
      return out;
    }
    return v;
  };
  return walk(value, false) as T;
}
