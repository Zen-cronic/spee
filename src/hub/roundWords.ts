// A round's per-line words for the voice surfaces: the MCP end_drill narration (src/mcp/tools.ts)
// and Alexa (src/alexa/skill.ts). The TV's Round over is the filmed surface, so these are its words
// (tv/web/src/mirror/format.ts roundHeadline and roundTally, which the phone's "Session over" line
// takes too), with a straight apostrophe: "1 of 2 lines passed", then "1 passed, 1 not yet, 1 Bee
// didn't catch, 1 still with Bee, 1 not tried" (zero parts left out). Each line counts once: a line
// missed and then passed on a retry is one line passed. A hub from before `lines` (the MCP server
// may talk to one) sends tries, and the tally says so: "3 tries: 1 passed, 2 not yet". A round with
// no line Bee checked says "Bee didn't check any line this round", unless a line is still with Bee:
// then Bee is still checking it ("Bee is still checking 1 line"), never a final "didn't check".
// test/round-words.test.ts holds the four surfaces to the same words.
import type { SessionSummary } from "./contract.js";

// The try counts may be missing (read as 0): only a hub without `lines` needs them.
export type RoundWordsIn = Pick<SessionSummary, "cards" | "counted"> & Partial<Pick<SessionSummary, "passed" | "failed" | "unverified" | "pending" | "lines">>;
export interface RoundWords {
  headline: string; // "1 of 2 lines passed" ("No lines this round" with none)
  tally: string; // "1 passed, 1 not yet, 1 not tried"; an older hub: "3 tries: 1 passed, 2 not yet"
  rest: string; // what a voice surface adds after the headline: the tally less its passes (the headline has them); an older hub's whole tally of tries
  checked: boolean; // Bee graded a try this round
  said: string; // the round in one clause: "1 of 2 lines passed, checked by Bee (1 not yet)", "Bee is still checking 1 line (1 not tried)" or "Bee didn't check any line this round (1 not tried)"
}

export function roundLineWords(s: RoundWordsIn): RoundWords {
  const l = s.lines;
  const t = { passed: s.passed ?? 0, failed: s.failed ?? 0, unverified: s.unverified ?? 0, pending: s.pending ?? 0 };
  const passed = l?.passed ?? t.passed;
  const cards = Math.max(s.cards, passed);
  const headline = cards ? `${passed} of ${cards} line${cards === 1 ? "" : "s"} passed` : "No lines this round";
  const c = l ?? t;
  const part = { failed: c.failed ? `${c.failed} not yet` : null, unverified: c.unverified ? `${c.unverified} Bee didn't catch` : null, pending: c.pending ? `${c.pending} still with Bee` : null, untried: l?.untried ? `${l.untried} not tried` : null };
  const others = Object.values(part).filter(Boolean).join(", ");
  const words = [`${c.passed} passed`, others].filter(Boolean).join(", ");
  const tries = t.passed + t.failed + t.unverified + t.pending;
  const tally = l ? words : `${tries} ${tries === 1 ? "try" : "tries"}: ${words}`;
  const rest = l ? others : tries ? tally : "";
  const checked = s.counted > 0;
  // Nothing checked yet, but a line is still with Bee: it is still checking (its verdict usually
  // lands seconds later), so the clause says so and the bracket leaves that part out. An older hub's
  // tries too: the bracket keeps only the tries Bee didn't catch, so each count is said once.
  const checking = !checked && c.pending > 0;
  const unit = l ? (c.pending === 1 ? "line" : "lines") : c.pending === 1 ? "try" : "tries";
  const head = checked ? `${headline}, checked by Bee` : checking ? `Bee is still checking ${c.pending} ${unit}` : "Bee didn't check any line this round";
  const bracket = checking ? [part.failed, part.unverified, part.untried].filter(Boolean).join(", ") : rest;
  const said = `${head}${bracket ? ` (${bracket})` : ""}`;
  return { headline, tally, rest, checked, said };
}
