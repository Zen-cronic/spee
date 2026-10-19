// TV time formatting (review L3): round first, then split into minutes and seconds.
import { describe, expect, it } from "vitest";
import { fmtDay, fmtMs, overruleText, sessionTally } from "../tv/web/src/mirror/format.js";

describe("fmtMs", () => {
  it("never shows 60 s or 1 min 60 s", () => {
    expect(fmtMs(0)).toBe("0 s");
    expect(fmtMs(40)).toBe("40 ms");
    expect(fmtMs(17_390)).toBe("17.4 s");
    expect(fmtMs(48_000)).toBe("48 s");
    expect(fmtMs(59_960)).toBe("1 min");
    expect(fmtMs(74_000)).toBe("1 min 14 s");
    expect(fmtMs(119_600)).toBe("2 min");
    expect(fmtMs(null)).toBe("–");
  });
});

describe("fmtDay", () => {
  it("reads a calendar date without a time zone shift", () => {
    expect(fmtDay("2026-10-22")).toBe("Thu Oct 22");
    expect(fmtDay("2026-11-01")).toBe("Sun Nov 1");
    expect(fmtDay(null)).toBe("–");
    expect(fmtDay("tomorrow")).toBe("–");
  });
});

describe("overruleText (review M42)", () => {
  it("follows Bee's verdict in both directions", () => {
    expect(overruleText("alexa", true, "the deploy finished")).toBe('Alexa heard a fail. Bee heard "the deploy finished" and passed it: Bee is what counts.');
    expect(overruleText("phone", false, "um the deploy")).toBe('The phone heard a pass. Bee heard "um the deploy" and that is what counts.');
    expect(overruleText(undefined, false, null)).toMatch(/^The preview heard a pass/);
  });
});

describe("sessionTally", () => {
  it("names attempts still with Bee", () => {
    expect(sessionTally("Session over", { passed: 0, failed: 0, unverified: 0, pending: 1 })).toBe("Session over: 0 passed, 0 failed, 0 unverified, 1 still with Bee.");
  });
});
