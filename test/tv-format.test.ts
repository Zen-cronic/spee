// TV time formatting (review L3): round first, then split into minutes and seconds.
import { describe, expect, it } from "vitest";
import { fmtDay, fmtMs, overruleText, sessionTally, transferTitle, transferWorking } from "../tv/web/src/mirror/format.js";

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

describe("the transfer claim on Home and Progress comes from the hub, never from the verdicts", () => {
  it('"It\u2019s working" and the plain Progress line only when the hub says the control stayed flat', () => {
    expect(transferWorking("all-dropped-control-flat")).toBe(true);
    expect(transferWorking("dropped-control-flat")).toBe(true);
    // Both drilled habits dropped, but the control has too little data, rose, was drilled or dropped too.
    for (const claim of ["dropped-control-unclear", "dropped-control-dropped", "not-drilled-yet", "no-drop-yet", undefined] as const) {
      expect(transferWorking(claim)).toBe(false);
      if (claim) expect(transferTitle({ claim, headline: 'hedges and "like" dropped in real speech after drilling; the control has too little data to compare' })).toBe("hedges and “like” dropped in real speech after drilling; the control has too little data to compare");
    }
    expect(transferTitle({ claim: "all-dropped-control-flat", headline: "x" })).toBe("The habits you drilled dropped. The one you didn’t, didn’t.");
    expect(transferTitle({ claim: "dropped-control-flat", headline: "hedges dropped in real speech after drilling; the undrilled control stayed flat" })).toBe("hedges dropped in real speech after drilling; the undrilled control stayed flat");
  });
});
