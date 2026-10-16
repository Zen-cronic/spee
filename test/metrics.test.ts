import { describe, expect, it } from "vitest";
import { detectLang } from "../src/analyze/lang.js";
import { lexical } from "../src/analyze/metrics.js";

describe("lexical metrics", () => {
  it("counts fillers, hedges and repeats per 100 words", () => {
    const m = lexical("en", ["Um I think maybe the the build is green, uh, today"], [{ start: 0, end: 5 }]);
    expect(m.fillersPer100).toBeGreaterThan(0);
    expect(m.hedgesPer100).toBeGreaterThan(0);
    expect(m.repeatsPer100).toBeGreaterThan(0);
    expect(m.medianWordsPerSec).toBeCloseTo(11 / 5, 1);
  });
  it("detects French vs English", () => {
    expect(detectLang("Je suis allé au marché avec ma sœur et c'est très bien")).toBe("fr");
    expect(detectLang("I merged the fix for the billing webhook")).toBe("en");
  });
});
