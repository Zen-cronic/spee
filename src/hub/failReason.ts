// The first failing rule of a Bee grade, as one plain spoken clause ("you still said "I guess"").
// Used by the hub's own narration and by the Alexa skill (src/alexa/speech.ts). Pure.
import type { GradeResult } from "./contract.js";

const q = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");
// The first failing rule of a Bee grade, as one spoken clause.
export function failReason(g: GradeResult): string {
  const failed = g.checks.find((c) => !c.ok);
  switch (failed?.rule) {
    case "nonempty":
      return "Bee heard nothing";
    case "habit":
      return g.habit.found.length ? `you still said ${q(g.habit.found.slice(0, 2))}` : `the habit was still there`;
    case "fillers":
      return g.fillers.length === 1 ? `Bee heard a filler word, "${g.fillers[0]}"` : `Bee heard ${g.fillers.length} filler words, ${q(g.fillers.slice(0, 3))}`;
    case "content":
      return g.missing.length ? `some words were missing, like ${q(g.missing.slice(0, 3))}` : "too much of the sentence changed";
    case "required": {
      const miss = g.required.filter((r) => !r.ok).map((r) => r.word);
      return miss.length ? `you didn't say ${q(miss.slice(0, 3))}` : "a key word was missing";
    }
    default:
      return "it didn't match the line";
  }
}
