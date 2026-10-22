// A round's per-line words on all four surfaces (review L182): the TV's Round over (roundHeadline,
// roundTally: the filmed surface), the phone's "Session over" line (it takes the TV's tally), and
// the voice surfaces through src/hub/roundWords.ts, the MCP end_drill narration and Alexa (speech,
// screen, and the pass screen's hint at the round's end). The same summaries go to all four, and
// they must say the same thing in the TV's words: "passed", "not yet", "Bee didn't catch", "still
// with Bee", "not tried". A round with no line Bee checked, but one still with Bee, says Bee is still
// checking it (the TV's "Bee is still checking your last line"), never that Bee didn't check it
// (review L186).
import { describe, expect, it } from "vitest";
import { summaryHint, summaryLine, summaryScreen } from "../src/alexa/skill.js";
import type { SessionSummary } from "../src/hub/contract.js";
import { roundLineWords } from "../src/hub/roundWords.js";
import { demoSetup } from "../src/hub/setup.js";
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
      const stillChecking = !s.counted && s.lines.pending > 0;
      for (const voice of [mcp, alexa, screen]) {
        for (const p of parts) {
          // the clause says the lines still with Bee: "Bee is still checking 1 line"
          if (stillChecking && /still with Bee$/.test(p)) expect(voice, voice).toContain(`Bee is still checking ${s.lines.pending} line${s.lines.pending === 1 ? "" : "s"}`);
          else expect(voice, voice).toContain(p);
        }
        if (s.counted) expect(voice).toContain(`${tvHeadline}, checked by Bee`);
        else {
          expect(voice).toContain(stillChecking ? "Bee is still checking" : "Bee didn't check any line this round");
          expect(voice).not.toMatch(/checked by Bee/);
          if (stillChecking) expect(voice).not.toMatch(/didn't check/);
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
  it("R2: the line was said and Bee is still checking it when the round ends: every voice surface says so, never that Bee didn't check it (review L186)", () => {
    const pending = ROUNDS[2]![1]; // one still with Bee, one not tried
    expect(summaryText(pending)).toBe("Practice done: Bee is still checking 1 line (1 not tried).");
    expect(summaryLine(pending)).toBe("Bee is still checking 1 line (1 not tried)");
    expect(summaryScreen(pending)).toMatchObject({ headline: "That’s the round.", line: "Bee is still checking 1 line (1 not tried)." });
    expect(`${roundHeadline(pending)} | ${roundTally(pending)}`).toBe("0 of 2 lines passed. | 0 passed, 1 still with Bee, 1 not tried");
    // Alexa's stop, through the demo hub: say the line, then "stop" before Bee's verdict
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const { card } = hub.startSession({ by: "alexa", size: 1 });
    hub.submit({ text: card!.resay, source: "alexa" });
    const s = hub.endSession()!;
    expect(summaryLine(s)).toBe("Bee is still checking 1 line");
    expect(summaryText(s)).toBe("Practice done: Bee is still checking 1 line.");
    hub.dispose();
  });
  it("the pass screen's hint at the round's end has the screen's apostrophes, as the round's own screen does", () => {
    const missed = ROUNDS[5]![1];
    expect(summaryHint(missed)).toBe("That’s the round: 0 of 2 lines passed, checked by Bee (1 not yet, 1 still with Bee)");
    expect(summaryHint(missed)).toBe(summaryLine(missed).replace(/'/g, "’"));
    expect(summaryLine(missed)).toContain("That's the round"); // speech keeps the straight one
  });
  it("an older hub sends no `lines`: the TV, the phone and MCP say the counts are tries, in the same words", () => {
    const { lines: _, ...older } = round(2, { attempts: 3, counted: 3, passed: 1, failed: 2 }, {});
    expect(roundTally(older)).toBe("3 tries: 1 passed, 2 not yet");
    expect(roundLineWords(older).tally).toBe("3 tries: 1 passed, 2 not yet");
    expect(sessionOverLine(older)).toBe("Session over, 3 tries: 1 passed, 2 not yet.");
    expect(summaryText(older)).toBe("Practice done: 1 of 2 lines passed, checked by Bee (3 tries: 1 passed, 2 not yet).");
  });
  it("an older hub with a try still with Bee: the clause says Bee is still checking it, and the bracket says each other count once (review L198)", () => {
    const { lines: _, ...one } = round(1, { attempts: 1, counted: 0, pending: 1 }, {});
    expect(roundLineWords(one).said).toBe("Bee is still checking 1 try");
    expect(summaryText(one)).toBe("Practice done: Bee is still checking 1 try.");
    const { lines: __, ...more } = round(2, { attempts: 3, counted: 0, unverified: 2, pending: 1 }, {});
    expect(roundLineWords(more).said).toBe("Bee is still checking 1 try (2 Bee didn't catch)");
    expect(roundLineWords(more).tally).toBe("3 tries: 0 passed, 2 Bee didn't catch, 1 still with Bee"); // the TV's tally keeps every part
  });
});
