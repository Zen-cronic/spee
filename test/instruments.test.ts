import { describe, expect, it } from "vitest";
import type { StatSession } from "../src/hub/stats.js";
import { habitRates, pairMeetings } from "../src/real/instruments.js";

const session = (id: string, kind: StatSession["kind"], startMs: number, texts: string[]): StatSession => ({
  id,
  kind,
  startMs,
  lines: texts.map((text, i) => ({ key: `${id}:${i}`, text, dom: "en", uncertain: false })),
});

describe("instrument check", () => {
  it("counts the same habits the same way for both transcribers", () => {
    const r = habitRates(["Um I guess it was like done, you know.", "Uh maybe we ship it."]);
    expect(r.words).toBe(14);
    expect(r.umUh).toBeCloseTo((2 / 14) * 100, 1);
    expect(r.like).toBeCloseTo((1 / 14) * 100, 1);
    expect(r.unsure).toBeGreaterThan(0);
  });

  it("pairs a meeting with the Bee conversation closest in time, within the window", () => {
    const t = Date.UTC(2026, 9, 19, 17, 30);
    const pairs = pairMeetings([
      session("meet-a", "meeting", t, ["I guess we ship it."]),
      session("bee-far", "conversation", t - 3 * 3600_000, ["Something else entirely."]),
      session("bee-near", "conversation", t + 4 * 60_000, ["Um I guess we ship it."]),
      session("meet-b", "meeting", t + 2 * 86400_000, ["No Bee recording for this one."]),
    ]);
    expect(pairs.map((p) => [p.meeting, p.bee])).toEqual([["meet-a", "bee-near"]]);
    expect(pairs[0]!.beeRates.umUh).toBeGreaterThan(pairs[0]!.captions.umUh);
  });

  it("leaves out uncertain and French lines", () => {
    const t = 0;
    const m = session("meet-c", "meeting", t, ["Like, I guess so."]);
    const b = session("bee-c", "conversation", t, ["Like, I guess so."]);
    b.lines.push({ key: "x", text: "Um um um um.", dom: "en", uncertain: true }, { key: "y", text: "Je pense que oui.", dom: "fr", uncertain: false });
    const [p] = pairMeetings([m, b]);
    expect(p!.beeRates).toEqual(p!.captions);
  });
});
