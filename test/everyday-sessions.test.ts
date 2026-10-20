// One drill-line rule for every view: the per-setting usual, the settings report, /api/stats habits
// and the live baseline leave the drill sentence out exactly as the transfer does, though Bee's final
// transcript gives it an id of its own (the stream matched realtime id 9001; the final line is 7777).
// Synthetic text only.
import { describe, expect, it } from "vitest";
import { CoachHub, type Attempt } from "../src/hub/core.js";
import { buildPrereg, DEMO_TZ } from "../src/hub/demoData.js";
import { computeBaseline } from "../src/hub/live/baseline.js";
import { SettingsBook } from "../src/hub/settings.js";
import { habitRates, withoutDrillLines, type StatLine, type StatSession } from "../src/hub/stats.js";

const t0 = Date.parse("2026-10-20T10:00:00-04:00"); // a Tuesday, in work hours
const PLAIN = "The billing export finished on Monday and the totals match the ledger today";
const DRILL = "We will ship the export on Friday after the review";

function rig() {
  const lines: StatLine[] = Array.from({ length: 40 }, (_, i) => ({ key: `u:${5000 + i}`, text: PLAIN, dom: "en" as const, uncertain: false, spokenAt: t0 + i * 20_000 }));
  lines.push({ key: "u:7777", text: DRILL, dom: "en", uncertain: false, spokenAt: t0 + 400_000 });
  const conv: StatSession = { id: "123", kind: "conversation", startMs: t0, endMs: t0 + 900_000, lines, speakers: 3 };
  const attempt: Attempt = {
    id: "att1", cardId: "c1", sessionId: null, status: "graded", counted: true, createdAt: t0 + 410_000, settledAt: t0 + 411_000, provisional: null,
    bee: { text: DRILL, utteranceIds: [9001], speakerScore: 0.9, via: "stream", latencyMs: 8000, coverage: null, replay: false, spokenFromMs: t0 + 398_000, spokenToMs: t0 + 402_000, conversationId: "123" },
    final: { source: "bee", pass: true, grade: {} as never }, agreement: null, reason: "", box: null,
  };
  const hub = new CoachHub({ mode: "demo", clock: () => t0 + 3_600_000, tz: DEMO_TZ, deck: { cards: [] } as never, deckPath: null, attemptsPath: null, sessions: [conv], prereg: buildPrereg(), preregPath: "test", wearer: { minScore: 0.5 } as never, attempts: [attempt] } as never);
  return { hub, conv };
}

describe("everyday sessions: one drill-line rule", () => {
  it("the settings usual, the settings report, /api/stats habits and the live baseline all leave the drill line out", () => {
    const { hub, conv } = rig();
    const transferWords = habitRates(withoutDrillLines(hub.sessions, hub.drillLines())).words;
    expect(transferWords).toBe(habitRates([conv]).words - 10); // the 10-word drill sentence is gone
    expect(habitRates(hub.everydaySessions()).words).toBe(transferWords);
    const book = new SettingsBook({ hub, stateDir: null });
    expect(book.tagSession("123")!.setting).toBe("work");
    expect(book.baselineFor("work")!.words).toBe(transferWords);
    const r = book.report("bee");
    expect(r.rates.find((x) => x.setting === "work")!.words).toBe(transferWords);
    expect(r.sessions[0]!.words).toBe(transferWords);
    expect(hub.stats({ kind: "all" }).habits.words).toBe(transferWords);
    expect(computeBaseline(hub, { wpm: null, synthetic: true }).words).toBe(transferWords);
    hub.dispose();
  });
});
