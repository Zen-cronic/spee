// Voice notes arrive as one text blob (no utterances, no timing). Split into sentences so
// every extracted item can cite a stable id: v:<journalId>:<sentenceIndex>.
export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
