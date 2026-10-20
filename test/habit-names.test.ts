// The hub and the TV name each habit the same way: the hub's map (src/hub/habitNames.ts) and the
// TV's own copy (tv/web/src/mirror/format.ts, which cannot import hub code) agree on every key.
import { describe, expect, it } from "vitest";
import { HABIT_NAME as HUB, habitTitle } from "../src/hub/habitNames.js";
import * as tv from "../tv/web/src/mirror/format.js";

describe("habit display names", () => {
  it("the TV map has the hub's names for every key it shows", () => {
    const TV = (tv as unknown as { HABIT_NAME?: Record<string, string> }).HABIT_NAME;
    expect(TV).toBeDefined();
    const keys = Object.keys(TV!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(TV![k], k).toBe(HUB[k]);
    for (const k of ["hedges", "filler:like", "fillers", "vague", "restart", "restarts"]) expect(keys, k).toContain(k);
  });

  it("uses the plain names, never the old jargon", () => {
    expect(HUB.hedges).toBe("unsure words");
    expect(HUB["filler:like"]).toBe('filler "like"');
    expect(HUB.fillers).toBe("filler words");
    expect(HUB.vague).toBe("vague answers");
    expect(HUB.restart).toBe("starting over");
    expect(habitTitle("hedges")).toBe("Unsure words");
    expect(habitTitle("filler:like")).toBe('Filler "like"');
    for (const v of Object.values(HUB)) expect(v).not.toMatch(/hedg|restart|control|drill/i);
  });
});
