// The live window (src/hub/live/window.ts) and rules (rules.ts): metrics from Bee timing, rules
// relative to the baseline, one firing per streak, and generated wrist text. Synthetic lines only.
import { describe, expect, it } from "vitest";
import type { BeeLine } from "../src/hub/bee.js";
import { WRIST_TEXT_MAX } from "../src/hub/contract.js";
import { DEFAULT_THRESHOLDS } from "../src/hub/live/principles.js";
import { firing, nudgeText, windowThresholds } from "../src/hub/live/rules.js";
import { ConversationWindow, habitCounts } from "../src/hub/live/window.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const TH = windowThresholds(DEFAULT_THRESHOLDS);
const BASE = { hedgesPer100: 1.43, likesPer100: 1.79 };
let uid = 1;
// A line spoken from startS to endS (recording seconds), tagged 5.9 s after it ended.
function line(speaker: BeeLine["speaker"], text: string, startS: number, endS: number, extra: Partial<BeeLine> = {}): BeeLine {
  const words = text.split(/\s+/).filter(Boolean).length;
  return { utteranceId: uid++, conversationUuid: "conv-w", speaker, ...(speaker === "wearer" ? { text } : {}), words, spokenAt: T0 + startS * 1000, durMs: (endS - startS) * 1000, startS, endS, receivedAt: T0 + endS * 1000 + 5400, resolvedAt: T0 + endS * 1000 + 5900, score: 0.8, drill: false, ...extra };
}

describe("habit counts on a wearer line", () => {
  it("counts hedges, like-as-filler, fillers, vague answers and restarts", () => {
    expect(habitCounts("I guess we could maybe ship it, like, on Friday and stuff. The the rest is done.")).toEqual({ hedges: 2, likes: 1, fillers: 1, vague: 1, restarts: 1 });
    expect(habitCounts("I like the new export.").likes).toBe(0);
  });
});

describe("ConversationWindow metrics", () => {
  it("rate from Bee start/end, talk share from counts, monologue runs and pauses", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    // 14 words in 6 s = 140 wpm, twice, with a 1.5 s pause between: one 13.5 s run.
    w.upsert(line("wearer", "The billing export finished on Monday and the totals match the ledger today too.", 0, 6));
    w.upsert(line("wearer", "We moved the release of the mobile build to Friday afternoon for the whole team.", 7.5, 13.5));
    w.upsert(line("other", "great what about the beta", 14.5, 16));
    const a = w.analyze(T0 + 30_000, TH, BASE);
    expect(a.window.wearer).toEqual({ lines: 2, words: 29, talkMs: 12_000, wpm: 145 });
    expect(a.window.others).toEqual({ lines: 1, words: 5 });
    expect(a.window.talkShare).toBe(0.85);
    expect(a.window.monologue).toEqual({ currentMs: 0, longestMs: 13_500 });
    expect(a.window.pauses).toEqual({ count: 1, longestMs: 1500 });
    expect(a.window.lang).toBe("en");
  });
  it("other speakers carry no text; drill lines are skipped; French lines count as talk, not habits", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("other", "the zebra orchid passcode is 4417", 0, 3));
    w.upsert(line("wearer", "I guess the export is ready for review today.", 4, 7, { drill: true }));
    w.upsert(line("wearer", "Oui, je pense que c'est bon pour vendredi.", 8, 11));
    const a = w.analyze(T0 + 20_000, TH, BASE);
    expect(JSON.stringify([...w.lines.values()])).not.toContain("zebra");
    expect(a.window.skipped).toEqual({ frenchLines: 1, drillLines: 1 });
    expect(a.window.totals.hedges).toBe(0);
    expect(a.window.wearer.lines).toBe(1);
    expect(a.window.lang).toBe("fr");
  });
  it("live.window carries no transcript text", () => {
    const w = new ConversationWindow("conv-w", T0, true);
    w.upsert(line("wearer", "I guess we could maybe ship the export on Friday.", 0, 4));
    const strings: string[] = [];
    JSON.stringify(w.analyze(T0, TH, BASE).window, (_k, v) => (typeof v === "string" && strings.push(v), v));
    expect(strings.every((s) => /^(conv-w|en|fr|mixed|hedge-streak|like-streak|monologue|fast-rate|count|ms|wpm)$/.test(s)), strings.join("|")).toBe(true);
  });
});

describe("rules", () => {
  it("hedge-streak: max(3, 2 x expected) in 120 s; fires once, then needs fresh hedges", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("wearer", "I guess we could maybe ship the export on Friday.", 70, 74));
    let a = w.analyze(T0, TH, BASE);
    expect(firing(a.evidence, () => true)).toHaveLength(0);
    w.upsert(line("wearer", "I think the retry logic is kind of ready.", 75, 79));
    a = w.analyze(T0, TH, BASE);
    const ev = a.evidence.find((e) => e.rule === "hedge-streak")!;
    expect(ev).toMatchObject({ value: 4, threshold: 3, unit: "count", over: true, windowMs: 120_000, expected: 0.27, fresh: true });
    expect(firing(a.evidence, () => true).map((e) => e.rule)).toEqual(["hedge-streak"]);
    w.consume("hedge-streak", a);
    w.upsert(line("wearer", "Probably just the alerting is left.", 80, 83));
    a = w.analyze(T0, TH, BASE);
    expect(a.evidence.find((e) => e.rule === "hedge-streak")!.value).toBe(1); // only after the firing
    expect(firing(a.evidence, () => true)).toHaveLength(0);
    expect(a.window.recent.hedges).toBe(5); // the window itself still counts all of them
  });
  it("hedges older than 2 minutes drop out of the streak", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("wearer", "I guess maybe it works.", 0, 3));
    w.upsert(line("wearer", "The release is on Friday afternoon as planned.", 200, 204));
    w.upsert(line("wearer", "I think so.", 205, 206));
    expect(w.analyze(T0, TH, BASE).evidence.find((e) => e.rule === "hedge-streak")!.value).toBe(1);
  });
  it("the threshold scales with the baseline and the words spoken", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    for (let i = 0; i < 10; i++) w.upsert(line("wearer", "The billing export finished on Monday and the totals match the ledger today.", i * 6, i * 6 + 5.5));
    const e = w.analyze(T0, TH, { hedgesPer100: 2, likesPer100: 3 }).evidence;
    expect(e.find((x) => x.rule === "hedge-streak")).toMatchObject({ expected: 2.6, threshold: 5.2 });
    expect(e.find((x) => x.rule === "like-streak")).toMatchObject({ expected: 3.9, threshold: 7.8 });
  });
  it("monologue: 90 s in one turn fires once per run; fast-rate stays off by default", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    for (let i = 0; i < 20; i++) w.upsert(line("wearer", "The billing export finished on Monday and the totals match.", i * 5, i * 5 + 4.4));
    const a = w.analyze(T0, TH, BASE);
    const mono = a.evidence.find((e) => e.rule === "monologue")!;
    expect(mono).toMatchObject({ value: 99_400, threshold: 90_000, unit: "ms", over: true, fresh: true });
    const enabled = { "hedge-streak": true, "like-streak": true, monologue: true, "fast-rate": false } as const;
    expect(firing(a.evidence, (r) => enabled[r]).map((e) => e.rule)).toEqual(["monologue"]);
    w.consume("monologue", a);
    w.upsert(line("wearer", "And the release is on Friday.", 100, 102));
    expect(firing(w.analyze(T0, TH, BASE).evidence, (r) => enabled[r])).toHaveLength(0);
    w.upsert(line("other", "thanks", 103, 104));
    expect(w.analyze(T0, TH, BASE).window.monologue.currentMs).toBe(0);
  });
  it("wrist text is generated, starts [coach] and fits the wrist", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("wearer", "I guess maybe I think it is kind of sort of done.", 70, 74));
    const e = w.analyze(T0, TH, BASE).evidence;
    for (const x of e) {
      const t = nudgeText({ ...x, value: x.rule === "monologue" ? 95_000 : x.value });
      expect(t.startsWith("[coach] ")).toBe(true);
      expect(t.length).toBeLessThanOrEqual(WRIST_TEXT_MAX);
      expect(t).not.toMatch(/guess|sort of|done/i);
    }
    expect(nudgeText(e[0]!)).toBe("[coach] 5 unsure words in 2 minutes. Say it plainly.");
  });
});

describe("review fixes (M4, M24)", () => {
  it("an appended recording (Bee offsets back at 0) still moves conversation time forward", () => {
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("wearer", "The first recording opens the conversation with a few words here.", 0, 5));
    w.upsert(line("wearer", "And it runs for ten minutes before the wearer stops the recording.", 590, 595));
    // 10 minutes later a new recording is appended: offsets restart at 0, spoken_at is 10 min on
    const late = (text: string, s: number, e: number) => line("wearer", text, s, e, { spokenAt: T0 + 600_000 + s * 1000, receivedAt: T0 + 600_000 + e * 1000 + 5400, resolvedAt: T0 + 600_000 + e * 1000 + 5900 });
    for (let i = 0; i < 4; i++) w.upsert(late("I guess maybe we could probably kind of ship it.", i * 6, i * 6 + 5));
    const a = w.analyze(T0 + 640_000, TH, BASE);
    const hedge = a.evidence.find((e) => e.rule === "hedge-streak")!;
    expect(hedge.value).toBeGreaterThanOrEqual(12); // all four new lines are recent, not "10 minutes ago"
  });
  it("streak evidence counts over the rule's own window", () => {
    const th = { ...TH, hedges: { ...TH.hedges, windowMs: 60_000 } };
    const w = new ConversationWindow("conv-w", T0, false);
    w.upsert(line("wearer", "I guess maybe we could ship it.", 0, 5)); // 2 hedges, 100 s before the end
    w.upsert(line("wearer", "Probably the totals match, I think.", 95, 100)); // 2 hedges, recent
    const hedge = w.analyze(T0 + 110_000, th, BASE).evidence.find((e) => e.rule === "hedge-streak")!;
    expect(hedge.windowMs).toBe(60_000);
    expect(hedge.value).toBe(2);
  });
});
