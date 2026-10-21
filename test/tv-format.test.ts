// TV time formatting (review L3): round first, then split into minutes and seconds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grade, type GradeCard } from "../src/hub/grade.js";
import { baselineWordsLabel, changeLabel, fmtDay, lastConversation, fmtMs, gradeFailure, habitTitle, overruleText, pctChange, plainReason, sessionTally, shortHabit, topWord, transferTitle, transferWorking, verdictWords, FIRST_SIGNAL_CAVEAT, firstSignalLine, firstSignalText, periodRate, transferRates, BEE_MEMORY_NOTE, beeMemoryLine, memoryAfterFetch, habitPill, habitRole, nudgeHops, nudgeHopsLine, nudgeRuleLine, nudgeText, planLine, recapNudgeLine, roundHeadline, roundLastLine, roundSegments, roundTally, skipLine, SKIP_LABEL, statTone, workingCell, type BeeMemoryIn } from "../tv/web/src/mirror/format.js";
import type { NudgeSkipReason, TransferHabit } from "../src/hub/contract.js";

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
    expect(overruleText("alexa", true, "the deploy finished.")).toBe('Alexa heard a miss, but Bee heard "the deploy finished" and passed it. Bee has the final say.');
    expect(overruleText("phone", false, "um the deploy")).toBe('The phone heard a pass, but Bee heard "um the deploy". Bee has the final say.');
    expect(overruleText(undefined, false, null)).toMatch(/^The preview heard a pass/);
  });
});

describe("sessionTally", () => {
  it("names lines still with Bee and leaves out zero parts", () => {
    expect(sessionTally("Last time", { passed: 0, failed: 0, unverified: 0, pending: 1 })).toBe("Last time: 0 passed, 1 still with Bee.");
    expect(sessionTally("Last time", { passed: 2, failed: 1, unverified: 1, beeOverrules: 1 })).toBe("Last time: 2 passed, 1 not yet, 1 Bee didn’t catch, 1 decided by Bee.");
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

describe("pctChange, shortHabit, habitTitle, topWord", () => {
  it("whole-number change, short names, the top word", () => {
    expect(pctChange(2.47, 0.64)).toBe(-74);
    expect(pctChange(0, 1)).toBeNull();
    expect(pctChange(null, 1)).toBeNull();
    expect(shortHabit("hedges (I guess, I think, maybe, kind of...)")).toBe("Hedges");
    expect(shortHabit('"like" as a filler')).toBe("“Like”");
    expect(shortHabit("unsure words (I guess, I think, maybe, kind of...)")).toBe("Unsure words");
    expect(shortHabit('filler "like"')).toBe("Filler “like”");
    // a habit is named from its key, whatever label the hub sent
    expect(habitTitle("hedges", "hedges (I guess)")).toBe("Unsure words");
    expect(habitTitle("filler:like")).toBe("Filler “like”");
    expect(habitTitle("restart")).toBe("Starting over");
    expect(habitTitle("hedge:i guess")).toBe("Unsure words");
    expect(habitTitle("yeah-tic", '"and yeah" / "so yeah" endings')).toBe("“And yeah” / “so yeah” endings");
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
      if (claim) expect(transferTitle({ claim, headline: "x" }).rest).not.toBe("The one you didn’t practise didn’t.");
    }
    expect(transferTitle({ claim: "all-dropped-control-flat", headline: "x" })).toEqual({ lead: "The habits you practised dropped.", rest: "The one you didn’t practise didn’t." });
    const habits = [
      { role: "drilled", verdict: "dropped", label: "hedges (I guess, I think, maybe, kind of...)" },
      { role: "drilled", verdict: "invalid", label: '"like" as a filler' },
      { role: "control", verdict: "dropped", label: "restarts" },
    ] as never;
    expect(transferTitle({ claim: "dropped-control-flat", headline: "x", habits })).toEqual({ lead: "Hedges dropped.", rest: "The one you didn’t practise stayed flat." });
    expect(transferTitle({ claim: "dropped-control-dropped", headline: "x", habits })).toEqual({ lead: "Hedges dropped.", rest: "So did the one you didn’t practise: not proof." });
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits }).rest).toBe("The unpractised one needs more speech.");
    // worded from the control's own verdict
    const withControl = (verdict: string) => [{ role: "drilled", verdict: "dropped", label: "hedges" }, ...(verdict ? [{ role: "control", verdict, label: "restarts" }] : [])] as never;
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits: withControl("rose") }).rest).toBe("The unpractised one went up.");
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits: withControl("invalid") }).rest).toBe("The unpractised one was practised too.");
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits: withControl("too little data") }).rest).toBe("The unpractised one needs more speech.");
    expect(transferTitle({ claim: "dropped-control-unclear", headline: "x", habits: withControl("") }).rest).toBe("There’s no unpractised one to compare.");
    expect(transferTitle({ claim: "no-drop-yet", headline: "x" })).toEqual({ lead: "Nothing has dropped yet.", rest: "Keep practising: it takes a few conversations." });
    // named from the key when the hub sends one
    const keyed = [{ habit: "hedges", role: "drilled", verdict: "dropped", label: "unsure words (I guess, I think, maybe, kind of...)" }, { habit: "filler:like", role: "drilled", verdict: "dropped", label: 'filler "like"' }] as never;
    expect(transferTitle({ claim: "all-dropped-control-flat", headline: "x", habits: keyed }).lead).toBe("Unsure words and filler “like” dropped.");
  });
  it("partly started: the habit measured since its drill, and the one not drilled yet; never a drop", () => {
    const habits = [
      { role: "drilled", verdict: "not drilled yet", label: "hedges (I guess, I think, maybe, kind of...)" },
      { role: "drilled", verdict: "too little data", label: '"like" as a filler' },
      { role: "control", verdict: "too little data", label: "restarts (the the, I I)" },
    ] as never;
    const headline = 'After period started for "like" on Oct 19; hedges not drilled yet';
    const t = transferTitle({ claim: "partly-started", headline, habits });
    expect(t).toEqual({ lead: "Measuring “like” now.", rest: "Hedges: not practised yet." });
    expect(t.lead.length).toBeLessThanOrEqual(40);
    expect(transferWorking("partly-started")).toBe(false);
    // without the habits to name, the hub's own headline
    expect(transferTitle({ claim: "partly-started", headline })).toEqual({ lead: "After period started for “like” on Oct 19; hedges not drilled yet", rest: null });
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

describe("Since you started, on Today: a percent only for a decided change", () => {
  const h = (verdict: string, before: number, after: number) => ({ verdict, before: { per100: before }, after: { per100: after } }) as never;
  it("words, as on Progress, for anything the hub has not decided; never \u2212 0%", () => {
    expect(changeLabel(h("dropped", 2.47, 0.64))).toEqual({ text: "−74%", pct: true });
    expect(changeLabel(h("rose", 1, 1.12))).toEqual({ text: "+12%", pct: true });
    expect(changeLabel(h("too little data", 2.47, 0.9))).toEqual({ text: "Needs more speech", pct: false });
    expect(changeLabel(h("no change", 1, 1.001))).toEqual({ text: "No change", pct: false });
    expect(changeLabel(h("not drilled yet", 1, 0))).toEqual({ text: "Not practised yet", pct: false });
    expect(changeLabel(h("invalid", 1, 0.2))).toEqual({ text: "Not counted", pct: false });
    expect(changeLabel(h("dropped", 1, 0.998)).text).toBe("0%");
    expect(verdictWords(h("dropped", 2.47, 0.64))).toBe("Down 74%");
  });
});

describe("Progress numbers: a dash, never 0.0, without enough speech", () => {
  const period = (words: number, per100: number) => ({ words, per100 });
  const h = (verdict: string, before: [number, number], after: [number, number]) => ({ verdict, before: period(...before), after: period(...after) }) as never;
  it("an empty period, a habit not practised yet, or too few words shows no number", () => {
    // what the stick showed: no speech since practising, and the hub's per100 of an empty period is 0
    expect(transferRates(h("too little data", [1381, 2.46], [0, 0]), 400)).toEqual({ before: "2.5", after: null });
    expect(transferRates(h("not drilled yet", [2601, 1.31], [0, 0]), 400)).toEqual({ before: "1.3", after: null });
    // not practised yet: whatever the after period holds, there is no "now" for it
    expect(transferRates(h("not drilled yet", [2601, 1.31], [900, 0.4]), 400).after).toBeNull();
    // some speech, under the minimum: still a dash (0 of 180 words is not a real 0.0)
    expect(transferRates(h("too little data", [1381, 2.1], [180, 0]), 400).after).toBeNull();
    expect(periodRate(period(399, 0.5), 400)).toBeNull();
    expect(periodRate(null, 400)).toBeNull();
  });
  it("a real 0.0 only when the period has the minimum words", () => {
    expect(transferRates(h("dropped", [1381, 2.1], [1220, 0]), 400)).toEqual({ before: "2.1", after: "0.0" });
    expect(periodRate(period(400, 0.57), 400)).toBe("0.6");
  });
});

describe("first signal on Progress: numbers only when the hub measured them, always with the caveat", () => {
  const side = (words: number, per100: number) => ({ session: "s", date: "2026-10-20", startMs: 0, words, count: 0, per100 });
  const like = { label: '"like" as a filler', minWords: 100 };
  it("measured: the two rates for the next conversation", () => {
    expect(firstSignalText({ ...like, status: "measured", before: side(309, 5.43), after: side(259, 2.1) })).toEqual({ text: "“Like” 5.4 → 2.1 per 100 words in your next conversation", measured: true });
    expect(FIRST_SIGNAL_CAVEAT).toBe("one conversation, not proof");
  });
  it("too few words, no next conversation, nothing before: words instead of a number", () => {
    expect(firstSignalText({ ...like, status: "too-few-words", before: side(309, 5.4), after: side(60, 0) })).toEqual({ text: "“Like”: your next conversation was too short to compare (60 words)", measured: false });
    expect(firstSignalText({ ...like, status: "too-few-words", before: side(40, 5.4), after: side(300, 1) }).text).toBe("“Like”: the conversation before you practised was too short to compare (40 words)");
    expect(firstSignalText({ ...like, status: "no-next-conversation", before: side(309, 5.4), after: null })).toEqual({ text: "“Like”: your next conversation after practising shows here", measured: false });
    expect(firstSignalText({ ...like, status: "no-earlier-conversation", before: null, after: side(300, 1) }).text).toBe("“Like”: no conversation before you practised to compare");
    expect(firstSignalText({ ...like, habit: "filler:like", status: "measured", before: side(309, 5.43), after: side(259, 2.1) }).text).toBe("Filler “like” 5.4 → 2.1 per 100 words in your next conversation");
  });
  it("one line on Progress: every measured habit on it; else one status; nothing before any drill", () => {
    const hedges = { label: "hedges (I guess, I think, maybe, kind of...)", minWords: 100 };
    type Who = { label: string; minWords: number };
    const m = (x: Who, b: number, a: number) => ({ ...x, status: "measured" as const, before: side(309, b), after: side(259, a) });
    const wait = (x: Who) => ({ ...x, status: "no-next-conversation" as const, before: side(309, 2), after: null });
    expect(firstSignalLine([m(hedges, 2.59, 0.77), m(like, 3.24, 0.77)])).toEqual({ text: "Your next conversation: Hedges 2.6 → 0.8 · “Like” 3.2 → 0.8", measured: true });
    expect(firstSignalLine([wait(hedges), m(like, 5.4, 2.1)])).toEqual({ text: "Your next conversation: “Like” 5.4 → 2.1", measured: true });
    expect(firstSignalLine([wait(hedges), wait(like)])).toEqual({ text: "Your next conversation after practising shows here", measured: false });
    expect(firstSignalLine([m({ ...hedges, habit: "hedges" } as Who, 2.59, 0.77)])!.text).toBe("Your next conversation: Unsure words 2.6 → 0.8");
    expect(firstSignalLine([wait(hedges), { ...like, status: "too-few-words", before: side(309, 5), after: side(60, 0) }])!.text).toMatch(/too short to compare \(60 words\)$/);
    expect(firstSignalLine([])).toBeNull();
    expect(firstSignalLine(undefined)).toBeNull();
  });
});

describe("Live between conversations", () => {
  const ended = (id: string, endedAt: number, recap: "pending" | "skipped-short" = "pending") => ({ conversationId: id, endedAt, wearerWords: 42, recap });
  const recap = (id: string, endedAt: number) => ({ conversationId: id, endedAt, headline: `headline of ${id}` });
  it("right after a conversation ends, says what comes next instead of an older conversation's headline", () => {
    expect(lastConversation(ended("c2", 2000), recap("c1", 1000))).toEqual({ headline: null, hint: "42 of your words. Your recap is on its way." });
    expect(lastConversation(ended("c2", 2000, "skipped-short"), recap("c1", 1000))).toEqual({ headline: null, hint: "42 of your words. Too short for a recap." });
    // its own recap arrived: that one is the last conversation
    expect(lastConversation(ended("c2", 2000), recap("c2", 2000))).toEqual({ headline: "headline of c2", hint: null });
    expect(lastConversation(null, recap("c1", 1000))).toEqual({ headline: "headline of c1", hint: null });
    expect(lastConversation(ended("c1", 1000), null).hint).toMatch(/on its way/);
    expect(lastConversation(null, null)).toEqual({ headline: null, hint: null });
  });
  it("labels the usual word count by what it covers", () => {
    expect(baselineWordsLabel({ source: "bee week (non-drill conversations)", range: "week" })).toBe("your words this week");
    expect(baselineWordsLabel({ source: "bee all Bee conversations (non-drill conversations)", range: "all" })).toBe("your words so far");
    // an older hub without `range`: read from the source
    expect(baselineWordsLabel({ source: "bee all Bee conversations (non-drill conversations)" })).toBe("your words so far");
    expect(baselineWordsLabel({ source: "bee week (non-drill conversations)" })).toBe("your words this week");
  });
});

// Packet S: the wrist moment, the quiet line, the plan, Bee memory, the round and the early cards.
describe("nudgeHopsLine names the alarm, not a buzz", () => {
  const nudge = (o: { total?: number | null; status?: "scheduled" | "failed" | "replay"; alarmAt?: number | null } = {}) => ({
    hops: { spokenAt: 0, beeAt: 5900, detectedAt: 5950, todoAt: 7400, alarmAt: o.alarmAt === undefined ? 17_400 : o.alarmAt },
    latencyMs: { bee: 5900, detect: 50, todo: 1450, total: o.total === undefined ? 17_400 : o.total },
    wrist: { channel: "bee-todo" as const, status: o.status ?? ("scheduled" as const), todoId: "t1", leadMs: 10_000, error: null },
  });
  it("you said it, Bee, then the wrist alarm the hub set", () => {
    expect(nudgeHopsLine(nudge())).toBe("You said it → Bee 5.9 s → wrist alarm 17.4 s");
    expect(nudgeHops(nudge()).map((h) => h.ms)).toEqual([0, 5900, 17_400]);
  });
  it("a wrist call that failed says the alarm was not set", () => {
    expect(nudgeHopsLine(nudge({ status: "failed", alarmAt: null, total: null }))).toBe("You said it → Bee 5.9 s → wrist alarm not set");
    expect(nudgeHops(nudge({ status: "failed", alarmAt: null, total: null }))[2]!.ms).toBeNull();
  });
  it("never claims a buzz or something on your wrist the hub cannot see", () => {
    for (const n of [nudge(), nudge({ status: "replay" }), nudge({ status: "failed", alarmAt: null, total: null })]) {
      const line = nudgeHopsLine(n);
      expect(line).not.toMatch(/buzz|on your wrist|vibrat/i);
      expect(line).toMatch(/wrist alarm/);
    }
  });
  it("shows the wrist text without its [coach] tag", () => {
    expect(nudgeText({ text: '[coach] 4 unsure words in 2 min. Say it plainly.' })).toBe("4 unsure words in 2 min. Say it plainly.");
  });
});

describe("skipLine words every NudgeSkipReason and never says Bee", () => {
  const reasons: NudgeSkipReason[] = ["off", "warmup", "quiet-hours", "drill-active", "cooldown", "rule-cooldown", "cap-hour", "cap-day", "wrist-down"];
  it("the cooldown line, with when it lifts", () => {
    expect(skipLine({ reason: "cooldown", retryAfterMs: 117_000 })).toBe("Stayed quiet: cooldown between nudges · again in 2 min");
    expect(skipLine({ reason: "cooldown", retryAfterMs: 40_000 })).toBe("Stayed quiet: cooldown between nudges · again in 40 s");
    expect(skipLine({ reason: "off", retryAfterMs: null })).toBe("Stayed quiet: live coaching is off");
  });
  it("every reason has its own words, and none credits Bee with the coach's decision", () => {
    expect(Object.keys(SKIP_LABEL).sort()).toEqual([...reasons].sort());
    const lines = reasons.map((reason) => skipLine({ reason, retryAfterMs: 60_000 }));
    expect(new Set(lines).size).toBe(reasons.length);
    for (const l of lines) {
      expect(l).toMatch(/^Stayed quiet: \S/);
      expect(l).not.toMatch(/\bBee\b/);
      expect(l).not.toMatch(/undefined|held back$/);
    }
  });
  it("the rule line comes from the hub's own thresholds and cooldown", () => {
    const rules = [{ rule: "hedge-streak" as const, threshold: 4 }, { rule: "like-streak" as const, threshold: 3 }];
    const mode = { cooldownMs: 180_000, rules: { "hedge-streak": true, "like-streak": true, monologue: true, "fast-rate": false } };
    expect(nudgeRuleLine(rules, mode, 120_000)).toBe("One wrist nudge when unsure words reach 4 or “like” reaches 3 in 2 min, then quiet for 3 min.");
    expect(nudgeRuleLine(rules, { ...mode, rules: { ...mode.rules, "like-streak": false } }, 120_000)).toBe("One wrist nudge when unsure words reach 4 in 2 min, then quiet for 3 min.");
    expect(nudgeRuleLine(undefined, mode, 120_000)).toBeNull();
  });
  it("the recap's nudge line", () => {
    expect(recapNudgeLine({ sent: 1, skipped: 1 })).toBe("1 wrist nudge, then stayed quiet once");
    expect(recapNudgeLine({ sent: 2, skipped: 0 })).toBe("2 wrist nudges");
    expect(recapNudgeLine({ sent: 0, skipped: 3 })).toBe("Stayed quiet 3 times: no wrist nudge");
    expect(recapNudgeLine({ sent: 0, skipped: 0 })).toBeNull();
  });
});

describe("planLine says pilot, gives counts per phase, never 'proves'", () => {
  const period = (sessions: number, words = 1200) => ({ sessions, words, count: 10, per100: 1, ci95: [0, 2] as [number, number], from: "2026-10-12", to: "2026-10-16" });
  const habit = (key: string, role: "drilled" | "control", before: number, after: number, verdict: TransferHabit["verdict"] = "dropped") => ({ habit: key, label: key, role, verdict, before: period(before), after: period(after) });
  const t = { prereg: { path: "prereg/x.md", registeredAt: "2026-10-17T12:00:00Z", drilled: ["hedges", "filler:like"], control: ["restart"], basis: "" }, minWordsPerPeriod: 400 };
  it("a two-tier pilot with the points per phase", () => {
    const p = planLine({ ...t, habits: [habit("hedges", "drilled", 6, 3), habit("filler:like", "drilled", 6, 2), habit("restart", "control", 9, 3, "no change")] });
    expect(p.text).toMatch(/^A pilot in two tiers, set Oct 17 before your first practice: two habits you practise against one you don’t\./);
    expect(p.text).toMatch(/400\+ words each side/);
    expect(p.points).toBe("Conversations counted, before → since: Unsure words 6 → 3 · Filler “like” 6 → 2 (too few) · Starting over 9 → 3");
    expect(p.caveat).toMatch(/a pilot, not proof of cause$/);
    expect(`${p.text} ${p.points} ${p.caveat}`).not.toMatch(/prove|proof that|proven/i);
  });
  it("a habit not practised yet has no after phase", () => {
    const p = planLine({ ...t, habits: [habit("hedges", "drilled", 4, 0, "not drilled yet"), habit("restart", "control", 4, 0, "not drilled yet")] });
    expect(p.text).toMatch(/^A pilot in one tier,/);
    expect(p.points).toBe("Conversations counted, before → since: Unsure words 4 → not started · Starting over 4 → not started");
  });
});

describe("beeMemoryLine is null when disabled", () => {
  const mem = (o: Partial<BeeMemoryIn> = {}): BeeMemoryIn => ({ enabled: true, status: "synced", goal: { factId: "f1", text: "Speaking goal (Speaking Mirror): ...", confirmed: true, updatedAt: Date.parse("2026-10-20T15:00:00Z") }, insights: { count: 0, readAt: Date.parse("2026-10-20T15:00:00Z") }, facts: { count: 14, readAt: Date.parse("2026-10-20T15:00:00Z") }, note: "Bee's chat and Alexa+ may not read coach-written facts.", ...o });
  it("hidden when the hub has it off, or does not report it", () => {
    expect(beeMemoryLine(mem({ enabled: false }))).toBeNull();
    expect(beeMemoryLine(mem({ status: "off" }))).toBeNull();
    expect(beeMemoryLine(null)).toBeNull();
    expect(beeMemoryLine(undefined)).toBeNull();
  });
  it("the goal fact, Bee's counts and the note, never more than the coach wrote", () => {
    const m = beeMemoryLine(mem())!;
    expect(m.text).toBe("Your speaking goal is saved in Bee as a confirmed fact, updated Oct 20.");
    expect(m.counts).toBe("Bee holds 14 facts and 0 insights, read Oct 20");
    expect(m.caveat).toBe("Bee’s chat and Alexa+ may not read coach-written facts.");
    expect(beeMemoryLine(mem({ status: "pending" }))!.text).toMatch(/^Saving/);
    expect(beeMemoryLine(mem({ status: "failed" }))!.text).toMatch(/tries again/);
    expect(beeMemoryLine(mem({ status: "demo" }))!.text).toBe("Demo: the coach would save your speaking goal in Bee as a fact. Nothing is written.");
    expect(beeMemoryLine(mem({ status: "demo", goal: null, facts: null, insights: null }))).toEqual({ text: "Demo: after a line Bee passes, the coach would save your speaking goal in Bee.", counts: null, caveat: BEE_MEMORY_NOTE });
    expect(beeMemoryLine(mem({ goal: null }))!.text).toMatch(/^No speaking goal in Bee yet/);
    expect(beeMemoryLine(mem({ note: "" }))!.caveat).toBe(BEE_MEMORY_NOTE);
    expect(beeMemoryLine(mem({ facts: null, insights: null }))!.counts).toBeNull();
  });
  it("a failed save says the hub tries again only while it does: a goal the coach stopped looking for says so, never that it didn't save", () => {
    expect(beeMemoryLine(mem({ status: "failed", stopped: false }))!.text).toBe("Your speaking goal didn’t save to Bee this time; the hub tries again.");
    // the create may have landed (it exited 0 without an id): Bee never listed it, which is all the coach knows
    const stopped = beeMemoryLine(mem({ status: "failed", stopped: true, goal: { factId: null, text: "Speaking goal (Speaking Mirror): ...", confirmed: false, updatedAt: null } }))!.text;
    expect(stopped).toBe("Bee never listed your speaking goal, so the coach stopped trying (it never makes a second copy).");
    expect(stopped).not.toMatch(/tries again|didn’t save|not saved/);
  });
  it("a failed refetch keeps the row's last good memory; an answer that is not Bee memory hides it", () => {
    const good = mem();
    expect(memoryAfterFetch(good, null)).toBe(good); // offline, a timeout or an error status
    expect(memoryAfterFetch(null, null)).toBeNull(); // nothing yet: still hidden
    const next = mem({ status: "pending" });
    expect(memoryAfterFetch(good, next)).toBe(next);
    expect(memoryAfterFetch(good, { error: "not_found" })).toBeNull();
    expect(beeMemoryLine(memoryAfterFetch(good, null))!.text).toBe(beeMemoryLine(good)!.text);
  });
  it("the TV's refetch goes through memoryAfterFetch (web TV and Vega)", () => {
    for (const file of ["tv/web/src/mirror/useMirror.ts", "tv/vega/src/mirror/useMirror.ts"]) expect(readFileSync(file, "utf8"), file).toContain("setMemory((have) => memoryAfterFetch(have, r))");
  });
  it("an older hub sends no stopped: a failure reads as one the hub tries again, never as stopped", () => {
    const older: BeeMemoryIn = { enabled: true, status: "failed", goal: { factId: null, text: "Speaking goal (Speaking Mirror): ...", confirmed: false, updatedAt: null }, insights: null, facts: null, note: "Bee's chat and Alexa+ may not read coach-written facts." };
    expect("stopped" in older).toBe(false);
    expect(beeMemoryLine(older)).toEqual(beeMemoryLine({ ...older, stopped: false }));
    expect(beeMemoryLine(older)!.text).not.toBe(beeMemoryLine({ ...older, stopped: true })!.text);
  });
});

describe("before the first practice: the cards never say Practised beside Not practised yet (the phone's rule)", () => {
  const h = (role: "drilled" | "control", verdict: TransferHabit["verdict"]) => ({ role, verdict, before: { per100: 2, words: 900 } as any, after: { per100: 0, words: 0 } as any });
  it("a practised habit is still to practise; the one you don't practise starts at your first practice", () => {
    expect(habitRole(h("drilled", "not drilled yet"))).toBe("To practise");
    expect(habitPill(h("drilled", "not drilled yet"))).toBeNull(); // "To practise" already says it
    expect(habitRole(h("control", "not drilled yet"))).toBe("Not practised");
    expect(habitPill(h("control", "not drilled yet"))).toBe("Starts at your first practice");
    expect(habitRole(h("drilled", "dropped"))).toBe("Practised");
    expect(habitPill(h("control", "no change"))).toBe("No change");
  });
});

describe("Today's since-you-started cells: a cell without a number still names its role (Progress's words)", () => {
  const h = (role: "drilled" | "control", verdict: TransferHabit["verdict"], after = 0.6) => ({ role, verdict, before: { per100: 2.1, words: 900 } as any, after: { per100: after, words: 900 } as any });
  it("too little speech everywhere: the three cells are never alike, the one you don't practise says so", () => {
    const cells = [workingCell(h("drilled", "too little data")), workingCell(h("drilled", "too little data")), workingCell(h("control", "too little data"))];
    expect(cells).toEqual([
      { value: null, status: "Needs speech", role: "Practised" },
      { value: null, status: "Needs speech", role: "Practised" },
      { value: null, status: "Needs speech", role: "Not practised" },
    ]);
  });
  it("before the first practice: a dash and To practise; the one you don't practise starts at your first practice", () => {
    expect(workingCell(h("drilled", "not drilled yet"))).toEqual({ value: null, status: null, role: "To practise" });
    expect(workingCell(h("control", "not drilled yet"))).toEqual({ value: null, status: "Starts at your first practice", role: "Not practised" });
  });
  it("a number keeps the card's own words; an undecided result is Progress's words in its place", () => {
    expect(workingCell(h("drilled", "dropped", 0.57))).toEqual({ value: "−73%", status: null, role: "Practised" });
    expect(workingCell(h("control", "no change", 2.2))).toEqual({ value: "Flat", status: null, role: "Not practised" });
    expect(workingCell(h("drilled", "no change", 2.0))).toEqual({ value: null, status: "No change", role: "Practised" });
    expect(workingCell(h("control", "invalid"))).toEqual({ value: null, status: "Not counted", role: "Not practised" });
  });
  it("one row reads in one case: a decided change beside one that needs more speech and the control", () => {
    const row = [workingCell(h("drilled", "dropped", 0.57)), workingCell(h("drilled", "too little data")), workingCell(h("control", "no change", 2.2))];
    expect(row.map((c) => c.role)).toEqual(["Practised", "Practised", "Not practised"]);
    expect(row.map((c) => c.value ?? c.status)).toEqual(["−73%", "Needs speech", "Flat"]);
  });
  it("Today draws every cell, the control's too, from workingCell and always shows its role (web TV and Vega)", () => {
    for (const file of ["tv/web/src/views/WeekView.tsx", "tv/vega/src/views/WeekView.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src.match(/<WorkCell\b/g), file).toHaveLength(2); // the practised habits, and the control
      expect(src, file).toContain("const c = workingCell(h);");
      expect(src, file).toMatch(/numberOfLines=\{1\}>\{c\.role\}<\/Text>/);
    }
  });
});

describe("Round over", () => {
  it("only a line still with Bee gets Bee's open ring: a line Bee didn't catch and one never tried are faint, each named in the tally", () => {
    // A retried and passed, B not yet, C still with Bee, D not caught, E opened and never said
    const s = { cards: 5, passed: 1, failed: 2, unverified: 1, pending: 1, lines: { passed: 1, failed: 1, unverified: 1, pending: 1, untried: 1 }, perCard: [
      { cardId: "A", attempts: 2, passed: 1, line: "passed" as const },
      { cardId: "B", attempts: 1, passed: 0, line: "failed" as const },
      { cardId: "C", attempts: 0, passed: 0, line: "pending" as const },
      { cardId: "D", attempts: 0, passed: 0, line: "unverified" as const },
      { cardId: "E", attempts: 0, passed: 0, line: "untried" as const },
    ] };
    expect(roundSegments(s).map((x) => x.line)).toEqual(["passed", "failed", "pending", "unverified", "untried"]);
    expect(roundTally(s)).toBe("1 passed, 1 not yet, 1 Bee didn’t catch, 1 still with Bee, 1 not tried");
    // an older hub sends no `line`: a graded try decides; an ungraded line is with Bee only while a try is
    const older = (pending: number, unverified: number) => roundSegments({ pending, unverified, perCard: s.perCard.map(({ line: _, ...c }) => c) }).map((x) => x.line);
    expect(older(0, 0)).toEqual(["passed", "failed", "untried", "untried", "untried"]);
    expect(older(0, 1)).toEqual(["passed", "failed", "unverified", "unverified", "unverified"]);
    expect(older(1, 1)).toEqual(["passed", "failed", "pending", "pending", "pending"]);
    expect(roundSegments({ pending: 0, unverified: 0, perCard: Array.from({ length: 12 }, (_, i) => ({ cardId: `c${i}`, attempts: 1, passed: 1 })) })).toHaveLength(10);
  });
  it("Round over draws its segments from roundSegments, one look per result (web TV and Vega)", () => {
    for (const file of ["tv/web/src/views/LiveView.tsx", "tv/vega/src/views/LiveView.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("const segs = roundSegments(s);");
      expect(src, file).toMatch(/const SEG = \{ passed: styles\.segPass, failed: styles\.segFail, pending: styles\.segOpen, unverified: styles\.segMissed, untried: styles\.segUntried \}/);
      expect(src, file).toContain("segOpen: { borderWidth: 3, borderColor: C.beeOnLight }"); // Bee's colour: the one still checking
      expect(src, file).not.toMatch(/segMissed: \{[^}]*C\.bee|segUntried: \{[^}]*C\.bee/);
    }
  });
  it("the round's headline, tally and last line", () => {
    expect(roundHeadline({ cards: 2, passed: 1 })).toBe("1 of 2 lines passed.");
    expect(roundHeadline({ cards: 1, passed: 1 })).toBe("1 of 1 line passed.");
    expect(roundHeadline({ cards: 0, passed: 0 })).toBe("No lines this round.");
    const lines = { passed: 1, failed: 1, unverified: 0, pending: 1, untried: 0 };
    expect(roundTally({ passed: 1, failed: 1, unverified: 0, pending: 1, lines })).toBe("1 passed, 1 not yet, 1 still with Bee");
    const g = { pass: false, agreement: "bee-overrules", beeText: "Um, the migration is not done yet.", failure: null };
    expect(roundLastLine({ graded: g, stage: "graded", previewSource: "phone" })).toBe("The phone heard a pass on your last line; Bee heard “Um, the migration is…”.");
    expect(roundLastLine({ graded: { ...g, agreement: "agree", pass: true }, stage: "graded", previewSource: "alexa" })).toBe("Last line: passed. Bee heard it.");
    expect(roundLastLine({ graded: null, stage: "checking", previewSource: null })).toMatch(/still checking/);
    expect(roundLastLine({ graded: null, stage: "idle", previewSource: null })).toBeNull();
  });
  it("the headline and the tally under it both count lines: a retried line is one line (review L164)", () => {
    // line A missed, then passed on a retry; line B missed: 2 lines, 3 tries
    const s = { cards: 2, attempts: 3, counted: 3, passed: 1, failed: 2, unverified: 0, pending: 0, beeOverrules: 2, lines: { passed: 1, failed: 1, unverified: 0, pending: 0, untried: 0 }, perCard: [{ cardId: "A", attempts: 2, passed: 1 }, { cardId: "B", attempts: 1, passed: 0 }] };
    expect(roundHeadline(s)).toBe("1 of 2 lines passed.");
    expect(roundTally(s)).toBe("1 passed, 1 not yet");
    // the tally's parts add up to the headline's lines, and match the segments (lime passed, coral not yet)
    expect(s.perCard.filter((c) => c.passed > 0)).toHaveLength(s.lines.passed);
    expect(s.perCard.filter((c) => !c.passed && c.attempts > 0)).toHaveLength(s.lines.failed);
    // a line opened and never said is named, so the parts still add up
    const three = { ...s, cards: 3, lines: { ...s.lines, untried: 1 } };
    expect(roundHeadline(three)).toBe("1 of 3 lines passed.");
    expect(roundTally(three)).toBe("1 passed, 1 not yet, 1 not tried");
    expect(roundTally({ ...s, lines: { passed: 0, failed: 0, unverified: 1, pending: 1, untried: 0 } })).toBe("0 passed, 1 Bee didn’t catch, 1 still with Bee");
    // each segment is coloured by its line's result, so lime and coral match the tally's passed and not yet
    expect(roundSegments({ ...s, perCard: [{ cardId: "A", attempts: 2, passed: 1, line: "passed" }, { cardId: "B", attempts: 1, passed: 0, line: "failed" }] }).map((x) => x.line)).toEqual(["passed", "failed"]);
    // an older hub sends no lines: its counts are tries, and the tally says so
    const { lines: _, ...older } = s;
    expect(roundHeadline(older)).toBe("1 of 2 lines passed.");
    expect(roundTally(older)).toBe("3 tries: 1 passed, 2 not yet");
    expect(roundTally({ passed: 1, failed: 0, unverified: 0, pending: 0 })).toBe("1 try: 1 passed");
  });
});

describe("Live's numbers: your usual ones are dimmed until you talk (statTone)", () => {
  it("between conversations every number is dimmed, a habit's too; while you talk a habit has its hue, coral once over", () => {
    expect(statTone({ habit: "hedges", usual: true })).toBe("usual");
    expect(statTone({ habit: "filler:like", usual: true })).toBe("usual");
    expect(statTone({ usual: true })).toBe("usual");
    expect(statTone({ habit: "hedges", usual: false })).toBe("habit");
    expect(statTone({ habit: "hedges", over: true })).toBe("over");
    expect(statTone({})).toBe("plain");
  });
  it("all four numbers on the conversation card pass usual={idle}, on the web TV and on Vega", () => {
    for (const file of ["tv/web/src/views/LiveView.tsx", "tv/vega/src/views/LiveView.tsx"]) {
      const stats = [...readFileSync(file, "utf8").matchAll(/<Stat\s[^>]*\/>/g)].map((m) => m[0]);
      expect(stats, file).toHaveLength(4);
      for (const s of stats) expect(s, file).toContain("usual={idle}");
    }
  });
});
