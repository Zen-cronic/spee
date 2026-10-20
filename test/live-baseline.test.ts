// The wearer's usual numbers (src/hub/live/baseline.ts): this week when it has enough words, else
// every Bee conversation, and the payload says which, so the TV labels the word count truly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoachHub } from "../src/hub/core.js";
import { DEMO_TZ, DEMO_WEARER } from "../src/hub/demoData.js";
import { computeBaseline, MIN_BASELINE_WORDS } from "../src/hub/live/baseline.js";
import type { HubDeck } from "../src/hub/scheduler.js";
import { wearerRule } from "../src/hub/setup.js";
import type { StatSession } from "../src/hub/stats.js";

const NOW = Date.parse("2026-10-20T12:00:00-04:00");
const talk = (id: string, startMs: number, lines: number): StatSession => ({ id, kind: "conversation", startMs, lines: Array.from({ length: lines }, (_, i) => ({ key: `${id}:${i}`, text: "The export finished on time and the totals match today.", dom: "en" as const, uncertain: false })) });
const hub = (sessions: StatSession[]) => new CoachHub({ mode: "demo", clock: () => NOW, tz: DEMO_TZ, deck: JSON.parse(readFileSync("fixtures/demo/deck.json", "utf8")) as HubDeck, deckPath: null, attempts: [], attemptsPath: null, sessions, prereg: null, preregPath: "p", wearer: wearerRule(DEMO_WEARER, ""), replay: true });

describe("the live baseline's range", () => {
  it("is the week when the week has enough words, else every conversation", () => {
    const busy = computeBaseline(hub([talk("w", NOW - 3600_000, 60)]), { wpm: 140, synthetic: true });
    expect(busy.words).toBeGreaterThanOrEqual(MIN_BASELINE_WORDS);
    expect(busy.range).toBe("week");
    const quiet = computeBaseline(hub([talk("w", NOW - 3600_000, 5), talk("old", NOW - 30 * 86_400_000, 600)]), { wpm: 140, synthetic: true });
    expect(quiet.range).toBe("all");
    expect(quiet.words).toBeGreaterThan(MIN_BASELINE_WORDS);
  });
});
