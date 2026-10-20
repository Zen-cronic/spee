// Speech helpers: short, deterministic, SSML-safe lines. Everything the skill composes is
// at most 2 sentences; a hub narration passed through keeps the contract's own limit (CoachNow
// narration is at most 4 sentences). Quoted card sentences count as part of the sentence quoting
// them. Pure.

export const MAX_SENTENCES = 2;

// Tidy whitespace and drop control characters and SSML/markup brackets.
export function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Split into sentences on . ! ? followed by a space (or the end), never inside double quotes.
export function sentences(text: string): string[] {
  const t = clean(text);
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '"' || ch === "“" || ch === "”") {
      const wasQuoted = quoted;
      quoted = ch === "“" ? true : ch === "”" ? false : !quoted;
      // a closing quote right after the quoted sentence's own terminator ends the sentence
      if (wasQuoted && !quoted && i > 0 && ".!?".includes(t[i - 1]!) && (i + 1 === t.length || t[i + 1] === " ")) {
        out.push(t.slice(start, i + 1).trim());
        start = i + 1;
      }
      continue;
    }
    if (quoted || !".!?".includes(ch)) continue;
    let j = i + 1;
    while (j < t.length && (t[j] === '"' || t[j] === "”" || ".!?".includes(t[j]!))) j++;
    if (j < t.length && t[j] !== " ") continue; // "2.1", "e.g.x"
    if (/\b\d$/.test(t.slice(0, i)) && /^\d/.test(t.slice(i + 1))) continue;
    out.push(t.slice(start, j).trim());
    start = j;
    i = j - 1;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export function clip(text: string, max = MAX_SENTENCES): string {
  return sentences(text).slice(0, max).join(" ");
}

const terminate = (s: string) => (/[.!?]["”]?$/.test(s) ? s : `${s}.`);

// Join parts into one line of at most `max` sentences.
export function line(parts: (string | null | undefined | false)[], max = MAX_SENTENCES): string {
  return clip(parts.filter((p): p is string => !!p && !!p.trim()).map((p) => terminate(clean(p))).join(" "), max);
}

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const escapeSsml = (s: string) => s.replace(/[&<>"']/g, (c) => XML[c]!);
export const ssml = (text: string) => `<speak>${escapeSsml(clean(text))}</speak>`;

// "Say: "<card sentence>"" (the sentence's own final punctuation sits inside the quotes).
export const sayCard = (lead: string, resay: string) => `${lead} "${clean(resay).replace(/"/g, "'")}"`;

// Round a wait up to a speakable number of seconds.
export function seconds(ms: number | null | undefined): string {
  const s = Math.max(5, Math.ceil((ms ?? 15_000) / 5000) * 5);
  return `${s} seconds`;
}

// The first failing rule of a Bee grade, as one spoken clause (shared with the hub narration).
export { failReason } from "../hub/failReason.js";
