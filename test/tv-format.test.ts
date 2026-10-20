// TV time formatting (review L3): round first, then split into minutes and seconds.
import { describe, expect, it } from "vitest";
import { grade, type GradeCard } from "../src/hub/grade.js";
import { changeLabel, fmtDay, fmtMs, gradeFailure, overruleText, pctChange, plainReason, sessionTally, shortHabit, topWord, transferTitle, transferWorking, verdictWords } from "../tv/web/src/mirror/format.js";

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

describe("plainReason: the drill verdict says what Bee heard, never the card's label", () => {
  const card = (habit: GradeCard["habit"], resay = "We ship the export on Friday.", mustSay?: string[]): GradeCard => ({ lang: "en", resay, habit, mustSay });
  const reason = (c: GradeCard, said: string) => plainReason(gradeFailure(grade(c, said)));
  it("a hedge card whose label quotes two hedges, failed on one of them", () => {
    const c = card({ kind: "hedge", targets: ["i guess", "i think"], label: 'hedges: "i guess", "i think"' });
    expect(reason(c, "I think we ship the export on Friday.")).toBe("You still said “i think”");
    expect(reason(c, "I guess I think we ship the export on Friday.")).toBe("You still said “i guess” and “i think”");
  });
  it('a "like" card names the word once, not "like" and "like"', () => {
    const c = card({ kind: "filler", targets: ["like"], label: '"like" as a filler' });
    expect(reason(c, "We like ship the export on, like, Friday.")).toBe("You still said “like”");
  });
  it("fillers, missing content, a required word, nothing heard; null on a pass", () => {
    const hedge = card({ kind: "hedge", targets: ["i guess"], label: 'the hedge "i guess"' });
    expect(reason(hedge, "Um, um, we ship the export on Friday.")).toBe("Bee heard “um”");
    expect(reason(hedge, "We ship it.")).toMatch(/^A few words were missing: /);
    const long = "We ship the billing export to the finance team on Friday morning.";
    expect(reason(card({ kind: "hedge", targets: ["i guess"], label: "hedges" }, long, ["Friday"]), long.replace("Friday", "Monday"))).toBe("You didn’t say “Friday”");
    expect(reason(hedge, "")).toBe("Bee heard nothing");
    expect(reason(hedge, "We ship the export on Friday.")).toBeNull();
    expect(plainReason(null)).toBeNull();
  });
});

describe("pctChange, shortHabit, topWord", () => {
  it("whole-number change, short names, the top word", () => {
    expect(pctChange(2.47, 0.64)).toBe(-74);
    expect(pctChange(0, 1)).toBeNull();
    expect(pctChange(null, 1)).toBeNull();
    expect(shortHabit("hedges (I guess, I think, maybe, kind of...)")).toBe("Hedges");
    expect(shortHabit('"like" as a filler')).toBe("“Like”");
    expect(topWord({ "i guess": 15, "i think": 5 })).toBe("“I guess”");
    expect(topWord({})).toBeNull();
  });
});

describe("the transfer claim on Home and Progress comes from the hub, never from the verdicts", () => {
  it('"It\u2019s working" and the plain Progress line only when the hub says the control stayed flat', () => {
    expect(transferWorking("all-dropped-control-flat")).toBe(true);
    expect(transferWorking("dropped-control-flat")).toBe(true);
    // Both drilled habits dropped, but the control has too little data, rose, was drilled or dropped too.
    for (const claim of ["dropped-control-unclear", "dropped-control-dropped", "not-drilled-yet", "no-drop-yet", undefined] as const) {
      expect(transferWorking(claim)).toBe(false);
      // never the "drilled habits dropped, the control didn't" line
      if (claim) expect(transferTitle({ claim, headline: "x" }).rest).not.toBe("The one you didn’t, didn’t.");
    }
    expect(transferTitle({ claim: "all-dropped-control-flat", headline: "x" })).toEqual({ lead: "The habits you drilled dropped.", rest: "The one you didn’t, didn’t." });
    const habits = [
      { role: "drilled", verdict: "dropped", label: "hedges (I guess, I think, maybe, kind of...)" },
      { role: "drilled", verdict: "invalid", label: '"like" as a filler' },
      { role: "control", verdict: "dropped", label: "restarts" },
    ] as never;
    expect(transferTitle({ claim: "dropped-control-flat", headline: "x", habits })).toEqual({ lead: "Hedges dropped.", rest: "The habit you never drilled stayed flat." });
    expect(transferTitle({ claim: "dropped-control-dropped", headline: "x", habits })).toEqual({ lead: "Hedges dropped.", rest: "So did the control, so it may not be the drill." });
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits }).rest).toBe("The control needs more speech to compare.");
    expect(transferTitle({ claim: "no-drop-yet", headline: "x" })).toEqual({ lead: "No drilled habit has dropped yet.", rest: null });
  });
  it("each title line stays short enough for one line of the TV's big type", () => {
    const habits = [
      { role: "drilled", verdict: "dropped", label: "hedges (I guess, I think, maybe, kind of...)" },
      { role: "drilled", verdict: "dropped", label: '"like" as a filler' },
    ] as never;
    for (const claim of ["all-dropped-control-flat", "dropped-control-flat", "dropped-control-dropped", "dropped-control-unclear", "not-drilled-yet", "no-drop-yet"] as const) {
      const t = transferTitle({ claim, headline: "x", habits });
      expect(t.lead.length).toBeLessThanOrEqual(40);
      expect((t.rest ?? "").length).toBeLessThanOrEqual(48);
    }
  });
});

describe("Since drilling on Home: a percent only for a decided change", () => {
  const h = (verdict: string, before: number, after: number) => ({ verdict, before: { per100: before }, after: { per100: after } }) as never;
  it("words, as on Progress, for anything the hub has not decided; never \u2212 0%", () => {
    expect(changeLabel(h("dropped", 2.47, 0.64))).toEqual({ text: "−74%", pct: true });
    expect(changeLabel(h("rose", 1, 1.12))).toEqual({ text: "+12%", pct: true });
    expect(changeLabel(h("too little data", 2.47, 0.9))).toEqual({ text: "Needs more speech", pct: false });
    expect(changeLabel(h("no change", 1, 1.001))).toEqual({ text: "No change", pct: false });
    expect(changeLabel(h("not drilled yet", 1, 0))).toEqual({ text: "Not drilled yet", pct: false });
    expect(changeLabel(h("invalid", 1, 0.2))).toEqual({ text: "Not counted", pct: false });
    expect(changeLabel(h("dropped", 1, 0.998)).text).toBe("0%");
    expect(verdictWords(h("dropped", 2.47, 0.64))).toBe("Down 74%");
  });
});
