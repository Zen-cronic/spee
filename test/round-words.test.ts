// A round's per-line words on all four surfaces (review L182): the TV's Round over (roundHeadline,
// roundTally: the filmed surface), the phone's "Session over" line (it takes the TV's tally), and
// the voice surfaces through src/hub/roundWords.ts, the MCP end_drill narration and Alexa (speech
// and screen). The same summaries go to all four, and they must say the same thing in the TV's
// words: "passed", "not yet", "Bee didn't catch", "still with Bee", "not tried".
import { describe, expect, it } from "vitest";
import { summaryLine, summaryScreen } from "../src/alexa/skill.js";
import type { SessionSummary } from "../src/hub/contract.js";
import { roundLineWords } from "../src/hub/roundWords.js";
import { summaryText } from "../src/mcp/tools.js";
import { roundHeadline, roundTally } from "../tv/web/src/mirror/format.js";
import { sessionOverLine } from "../web/phone/src/take.js";

const base = { sessionId: "s1", by: "mcp", startedAt: 0, endedAt: 1, beeOverrules: 0, perCard: [] };
const round = (cards: number, tries: Partial<Pick<SessionSummary, "attempts" | "counted" | "passed" | "failed" | "unverified" | "pending">>, lines: Partial<SessionSummary["lines"]>): SessionSummary => ({
  ...base,
  cards,
  attempts: 0,
  counted: 0,
  passed: 0,
  failed: 0,
  unverified: 0,
  pending: 0,
  ...tries,
  lines: { passed: 0, failed: 0, unverified: 0, pending: 0, untried: 0, ...lines },
});
const ROUNDS: [string, SessionSummary][] = [
  ["no line Bee checked: ended before the line was said", round(1, {}, { untried: 1 })],
  ["no line Bee checked: a try Bee didn't catch", round(1, { attempts: 1, unverified: 1 }, { unverified: 1 })],
  ["no line Bee checked: one still with Bee, one not tried", round(2, { attempts: 1, pending: 1 }, { pending: 1, untried: 1 })],
  ["a pass", round(1, { attempts: 1, counted: 1, passed: 1 }, { passed: 1 })],
  ["a pass on a retry, a try Bee didn't catch, a line not tried", round(3, { attempts: 3, counted: 2, passed: 1, failed: 1, unverified: 1 }, { passed: 1, unverified: 1, untried: 1 })],
  ["a miss, a line still with Bee", round(2, { attempts: 2, counted: 1, failed: 1, pending: 1 }, { failed: 1, pending: 1 })],
];
const straight = (t: string) => t.replace(/’/g, "'");

describe("a round's per-line words agree on the TV, the phone, MCP and Alexa (review L182)", () => {
  for (const [name, s] of ROUNDS) {
    it(name, () => {
      const tvHeadline = straight(roundHeadline(s)).replace(/\.$/, "");
      const tvTally = straight(roundTally(s));
      const parts = tvTally.split(", ").filter((p) => !/^\d+ passed$/.test(p)); // the headline has the passes
      const w = roundLineWords(s);
      // the hub's helper is the TV's rule
      expect(w.headline).toBe(tvHeadline);
      expect(w.tally).toBe(tvTally);
      const phone = straight(sessionOverLine(s));
      const mcp = summaryText(s);
      const alexa = summaryLine(s);
      const screen = straight(summaryScreen(s).line);
      expect(phone).toBe(`Session over: ${tvTally}.`);
      for (const voice of [mcp, alexa, screen]) {
        for (const p of parts) expect(voice, voice).toContain(p);
        if (s.counted) expect(voice).toContain(`${tvHeadline}, checked by Bee`);
        else {
          expect(voice).toContain("Bee didn't check any line this round");
          expect(voice).not.toMatch(/checked by Bee/);
        }
      }
      // one vocabulary, the TV's
      for (const out of [phone, mcp, alexa, screen, tvTally]) expect(out, out).not.toMatch(/confirm|unverified|failed|waiting/);
    });
  }
  it("the R4 rounds, word for word", () => {
    const [untried, uncaught] = [ROUNDS[0]![1], ROUNDS[1]![1]];
    expect(summaryText(untried)).toBe("Practice done: Bee didn't check any line this round (1 not tried).");
    expect(summaryLine(untried)).toBe("Bee didn't check any line this round (1 not tried)");
    expect(summaryText(uncaught)).toBe("Practice done: Bee didn't check any line this round (1 Bee didn't catch).");
    expect(summaryScreen(uncaught)).toMatchObject({ headline: "That’s the round.", line: "Bee didn’t check any line this round (1 Bee didn’t catch)." });
    expect(`${roundHeadline(uncaught)} | ${roundTally(uncaught)}`).toBe("0 of 1 line passed. | 0 passed, 1 Bee didn’t catch");
    expect(sessionOverLine(uncaught)).toBe("Session over: 0 passed, 1 Bee didn’t catch.");
  });
  it("an older hub sends no `lines`: the TV, the phone and MCP say the counts are tries, in the same words", () => {
    const { lines: _, ...older } = round(2, { attempts: 3, counted: 3, passed: 1, failed: 2 }, {});
    expect(roundTally(older)).toBe("3 tries: 1 passed, 2 not yet");
    expect(roundLineWords(older).tally).toBe("3 tries: 1 passed, 2 not yet");
    expect(sessionOverLine(older)).toBe("Session over, 3 tries: 1 passed, 2 not yet.");
    expect(summaryText(older)).toBe("Practice done: 1 of 2 lines passed, checked by Bee (3 tries: 1 passed, 2 not yet).");
  });
});
