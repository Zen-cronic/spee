// Habit rates, the transfer check (drilled vs pre-registered control) and the demo fixtures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countHabitKey, habitKeysOf, parseHabitKey } from "../src/hub/habits.js";
import { habitRates, loadPrereg, transfer, wordsToSeeHalving, type StatSession, type TransferPrereg } from "../src/hub/stats.js";
import { demoFixtures } from "../scripts/build-demo-fixtures.js";

const sess = (id: string, kind: StatSession["kind"], start: string, texts: string[]): StatSession => ({
  id, kind, startMs: Date.parse(start), lines: texts.map((t, i) => ({ key: `${id}:${i}`, text: t, dom: "en", uncertain: false })),
});
const PREREG: TransferPrereg = {
  kind: "transfer", registered_at: "2026-10-12T13:00:00.000Z", registered_local: "", lang: "en", basis: "test",
  drilled: [{ habit: "hedge:i guess", why: "" }], control: [{ habit: "restart", why: "" }], min_words_per_period: 400, cutover_rule: "",
};
const filler = (n: number) => new Array(n).fill("The export finished on time and the totals match the ledger today.").join(" ");

describe("habit keys and rates", () => {
  it("counts hero habits (hedges, vague answers) and supporting ones", () => {
    expect(countHabitKey("hedge:i guess", "I guess it works, I guess.")).toBe(2);
    expect(countHabitKey("hedges", "I think it's kind of done, maybe.")).toBe(3);
    expect(countHabitKey("vague", "I fixed that thing and stuff, it's getting there.")).toBe(3);
    expect(countHabitKey("filler:like", "It was, like, fine. I like it.")).toBe(1);
    expect(countHabitKey("restart", "We we moved it to Friday.")).toBe(1);
    expect(countHabitKey("restart", "We moved the, uh, the release.")).toBe(1); // um/uh ignored
    expect(parseHabitKey("EN_GENDER")).toBeNull();
  });
  it("rates per 100 words with Poisson intervals, excluding uncertain and French lines", () => {
    const s = sess("s1", "conversation", "2026-10-13T10:00:00-04:00", ["I guess the export is ready.", "That thing is, like, done."]);
    s.lines.push({ key: "x", text: "I guess this was not me", dom: "en", uncertain: true }, { key: "y", text: "je pense que oui", dom: "fr", uncertain: false });
    const r = habitRates([s]);
    expect(r.words).toBe(11);
    expect(r.hedges.count).toBe(1);
    expect(r.vague.breakdown).toEqual({ "that thing": 1 });
    expect(r.fillers.breakdown).toEqual({ like: 1 });
    expect(r.hedges.ci95[0]).toBeLessThan(r.hedges.per100);
  });
});

describe("transfer", () => {
  const before = sess("b", "conversation", "2026-10-13T10:00:00-04:00", [filler(30), ...new Array(12).fill("I guess we we shipped it.")]);
  const after = sess("a", "conversation", "2026-10-17T10:00:00-04:00", [filler(30), "We we shipped it.", ...new Array(11).fill("We shipped it, we we did.")]);
  const drill = { at: Date.parse("2026-10-15T12:00:00-04:00"), habitKeys: ["hedge:i guess"] };
  it("reports a drop for the drilled habit and no change for the control", () => {
    const t = transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now() });
    const h = t.habits.find((x) => x.habit === "hedge:i guess")!;
    expect(h).toMatchObject({ role: "drilled", verdict: "dropped", firstDrillAt: drill.at });
    expect(h.before.count).toBe(12);
    expect(h.after.count).toBe(0);
    expect(t.habits.find((x) => x.habit === "restart")).toMatchObject({ role: "control", verdict: "no change", cutoverSource: expect.stringContaining("earliest") });
    expect(t.headline).toMatch(/dropped.*control stayed flat/);
  });
  it("drill sentences Bee heard are not counted as everyday speech (review M2)", () => {
    // the after period is mostly drill lines (hedge-free card sentences): without the exclusion they
    // would dilute the after rate
    const withDrills = sess("a2", "conversation", "2026-10-17T10:00:00-04:00", [filler(30), ...new Array(12).fill("I guess we we shipped it.")]);
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const key = `u:${9000 + i}`;
      withDrills.lines.push({ key, text: "The billing export is ready for review today, and the totals match.", dom: "en", uncertain: false });
      keys.add(key);
    }
    const counted = transfer({ sessions: [before, withDrills], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now() });
    const fixed = transfer({ sessions: [before, withDrills], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now(), drillLineKeys: keys });
    const h = (t: typeof fixed) => t.habits.find((x) => x.habit === "hedge:i guess")!;
    expect(h(fixed).after.words).toBeLessThan(h(counted).after.words);
    expect(h(fixed).after.per100).toBeGreaterThan(h(counted).after.per100);
    expect(h(fixed).verdict).toBe("no change");
    expect(h(fixed).detail).toMatch(/^no detectable change/);
  });
  it("too little data, with the words needed", () => {
    const small = transfer({ sessions: [sess("b", "conversation", "2026-10-13T10:00:00-04:00", ["I guess so."]), sess("a", "conversation", "2026-10-17T10:00:00-04:00", ["Yes."])], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now() });
    expect(small.habits[0]).toMatchObject({ verdict: "too little data" });
    expect(small.habits[0]!.detail).toMatch(/at least 400 words/);
    expect(wordsToSeeHalving(2)).toBeGreaterThan(400);
    expect(wordsToSeeHalving(0)).toBeNull();
  });
  it("not drilled yet; refuses unregistered habits; invalidates a drilled control or a pre-registration after drilling", () => {
    const none = transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [], nowMs: Date.now() });
    expect(none.habits.map((h) => h.verdict)).toEqual(["not drilled yet", "not drilled yet"]);
    const unreg = transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [drill, { at: drill.at, habitKeys: ["vague"] }], nowMs: Date.now() });
    expect(unreg.unregistered).toEqual([{ habit: "vague", drills: 1, note: expect.stringContaining("not pre-registered") }]);
    expect(unreg.habits.some((h) => h.habit === "vague")).toBe(false);
    const ctl = transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [drill, { at: drill.at, habitKeys: ["restart"] }], nowMs: Date.now() });
    expect(ctl.habits.find((h) => h.habit === "restart")!.verdict).toBe("invalid");
    const early = transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [{ at: Date.parse("2026-10-11T12:00:00Z"), habitKeys: ["hedge:i guess"] }], nowMs: Date.now() });
    expect(early.habits[0]!.verdict).toBe("invalid");
  });
  it("counts a specific hedge drill toward a pre-registered umbrella and keeps refusing others", () => {
    const umbrella: TransferPrereg = { ...PREREG, drilled: [{ habit: "hedges", why: "" }, { habit: "filler:like", why: "" }] };
    const keys = habitKeysOf({ kind: "hedge", targets: ["i guess"], label: "" });
    expect(keys).toEqual(["hedge:i guess", "hedges"]);
    expect(habitKeysOf({ kind: "filler", targets: ["like"], label: "" })).toEqual(["filler:like", "fillers"]);
    const t = transfer({ sessions: [before, after], prereg: umbrella, preregPath: "p", drills: [{ at: drill.at, habitKeys: keys }, { at: drill.at, habitKeys: ["filler:like", "fillers"] }, { at: drill.at, habitKeys: ["filler:um", "fillers"] }, { at: drill.at, habitKeys: ["vague"] }], nowMs: Date.now() });
    expect(t.habits.find((h) => h.habit === "hedges")!.firstDrillAt).toBe(drill.at);
    expect(t.unregistered.map((u) => u.habit).sort()).toEqual(["filler:um", "vague"]);
  });
  it("uses Bee conversations by default; meetings only with source=all; never voice notes", () => {
    const meet = sess("m", "meeting", "2026-10-18T10:00:00-04:00", new Array(40).fill("I guess the totals match the ledger today."));
    const note = sess("v", "voice_note", "2026-10-18T11:00:00-04:00", new Array(40).fill("I guess I guess I guess."));
    const bee = transfer({ sessions: [before, after, meet, note], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now() });
    expect(bee.habits[0]!.after.sessions).toBe(1);
    expect(Object.keys(bee.sources)).toEqual(["conversation"]);
    const all = transfer({ sessions: [before, after, meet, note], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now(), source: "all" });
    expect(all.habits[0]!.after.sessions).toBe(2);
    expect(all.sources.meeting!.label).toMatch(/secondary/);
  });
});

describe("pre-registration and demo fixtures", () => {
  it("prereg/transfer.json pre-registers the default drilled and control habits", () => {
    const p = loadPrereg("prereg/transfer.json");
    expect(p.drilled.map((h) => h.habit)).toEqual(["hedges", "filler:like"]);
    expect(p.control.map((h) => h.habit)).toEqual(["restart"]);
    expect(p.synthetic).toBeUndefined();
    expect(Date.parse(p.registered_at)).toBeLessThan(Date.now());
  });
  it("committed demo fixtures match a fresh deterministic build", () => {
    for (const [f, v] of Object.entries(demoFixtures())) expect(JSON.parse(readFileSync(`fixtures/demo/${f}`, "utf8"))).toEqual(JSON.parse(JSON.stringify(v)));
  });
  it("demo data is labelled synthetic and shows a drilled habit dropping while the control stays flat", () => {
    const f = demoFixtures() as any;
    expect(f["prereg-transfer.json"].synthetic).toBe(true);
    expect(f["sessions.json"].sessions.every((s: StatSession) => s.synthetic)).toBe(true);
    expect(f["deck.json"].cards.every((c: { synthetic: boolean }) => c.synthetic)).toBe(true);
    const drills = f["attempts.json"].attempts.map((a: any) => ({ at: a.createdAt, habitKeys: a.cardId === "demo:filler-like" ? ["filler:like", "fillers"] : ["hedge:i guess", "hedges"] }));
    const t = transfer({ sessions: f["sessions.json"].sessions, prereg: f["prereg-transfer.json"], preregPath: "demo", drills, nowMs: Date.now() });
    expect(t.synthetic).toBe(true);
    expect(Object.fromEntries(t.habits.map((h) => [h.habit, h.verdict]))).toEqual({ hedges: "dropped", "filler:like": "dropped", restart: "no change" });
    expect(t.unregistered).toEqual([]);
  });
});

describe("deterministic real-data habit cards", async () => {
  const { habitCards, stripHedges } = await import("../src/hub/realCards.js");
  const { grade } = await import("../src/hub/grade.js");
  it("builds 'I guess', other-hedge and 'like' cards from Bee conversations only", () => {
    const s = [
      sess("c1", "conversation", "2026-10-13T10:00:00-04:00", ["I guess the export job finished before lunch today.", "So the dashboard, like, loads slowly on Monday mornings.", "Maybe we should move the review to Friday afternoon."]),
      sess("m1", "meeting", "2026-10-13T11:00:00-04:00", ["I guess the meeting caption line is long enough here."]),
    ];
    const cards = habitCards(s, { today: "2026-10-20" });
    expect(cards.map((c) => c.habit!.targets)).toEqual([["i guess"], ["maybe"], ["like"]]);
    expect(cards[0]).toMatchObject({ said: "I guess the export job finished before lunch today.", resay: "The export job finished before lunch today.", session: "c1" });
    expect(cards[2]!.resay).toBe("So the dashboard loads slowly on Monday mornings.");
    for (const c of cards) expect(grade({ lang: "en", resay: c.resay, habit: c.habit!, mustSay: c.mustSay }, c.said).pass).toBe(false); // the original line keeps the habit
    for (const c of cards) expect(grade({ lang: "en", resay: c.resay, habit: c.habit!, mustSay: c.mustSay }, c.resay).pass).toBe(true);
    expect(habitCards(s, { today: "2026-10-20", source: "all" }).some((c) => c.session === "m1")).toBe(true);
    expect(stripHedges("Well, I guess, it works.", ["i guess"])).toBe("Well, it works.");
  });
});
