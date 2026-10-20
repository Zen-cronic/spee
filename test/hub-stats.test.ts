// Habit rates, the transfer check (drilled vs pre-registered control) and the demo fixtures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countHabitKey, habitKeysOf, parseHabitKey } from "../src/hub/habits.js";
import { firstSignalSentence, habitRates, loadPrereg, nextSessionDeltas, transfer, wordsToSeeHalving, type StatSession, type TransferPrereg } from "../src/hub/stats.js";
import { wordCount } from "../src/real/text.js";
import { demoFixtures } from "../scripts/build-demo-fixtures.js";

const sess = (id: string, kind: StatSession["kind"], start: string, texts: string[]): StatSession => ({
  id, kind, startMs: Date.parse(start), lines: texts.map((t, i) => ({ key: `${id}:${i}`, text: t, dom: "en", uncertain: false })),
});
const PREREG: TransferPrereg = {
  kind: "transfer", registered_at: "2026-10-12T13:00:00.000Z", registered_local: "", lang: "en", basis: "test",
  drilled: [{ habit: "hedge:i guess", why: "" }], control: [{ habit: "restart", why: "" }], min_words_per_period: 400, cutover_rule: "",
};
const wordsOf = (ts: string[]) => ts.reduce((n, t) => n + wordCount(t), 0);
const filler = (n: number) => new Array(n).fill("The export finished on time and the totals match the ledger today.").join(" ");

describe("habit keys and rates", () => {
  it("counts the drilled habits (hedges, \"like\") and the tracked ones", () => {
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
    expect(t.headline).toMatch(/dropped.*the one you didn't practise stayed the same/);
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
    const fixed = transfer({ sessions: [before, withDrills], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now(), drillLines: { keys, spans: [] } });
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
  it("states what its headline claims as a fixed value, by the headline's own rule", () => {
    const run = (o: Partial<Parameters<typeof transfer>[0]>) => transfer({ sessions: [before, after], prereg: PREREG, preregPath: "p", drills: [drill], nowMs: Date.now(), ...o });
    const flat = run({});
    expect(flat.claim).toBe("all-dropped-control-flat");
    // One of two drilled habits dropped ("like" was never said: no change), the control flat.
    const two = run({ prereg: { ...PREREG, drilled: [{ habit: "hedges", why: "" }, { habit: "filler:like", why: "" }] }, drills: [{ at: drill.at, habitKeys: ["hedge:i guess", "hedges"] }, { at: drill.at, habitKeys: ["filler:like", "fillers"] }] });
    expect(two.habits.filter((h) => h.role === "drilled").map((h) => h.verdict)).toEqual(["dropped", "no change"]);
    expect(two.claim).toBe("dropped-control-flat");
    // The control dropped too.
    const calm = sess("a", "conversation", "2026-10-17T10:00:00-04:00", [filler(32), ...new Array(12).fill("We shipped it.")]);
    const both = run({ sessions: [before, calm] });
    expect(both.habits.find((h) => h.role === "control")!.verdict).toBe("dropped");
    expect(both.claim).toBe("dropped-control-dropped");
    expect(both.headline).toMatch(/the one you didn't practise dropped too/);
    // A drop with no control to compare (none registered, or the control was drilled).
    const none = run({ prereg: { ...PREREG, control: [] } });
    expect(none.claim).toBe("dropped-control-unclear");
    expect(none.headline).toMatch(/there's no habit you left unpractised to compare it with$/);
    const drilledControl = run({ drills: [drill, { at: drill.at, habitKeys: ["restart"] }] });
    expect(drilledControl.habits.find((h) => h.role === "control")!.verdict).toBe("invalid");
    expect(drilledControl.claim).toBe("dropped-control-unclear");
    expect(drilledControl.headline).not.toMatch(/stayed flat/);
    expect(drilledControl.headline).toMatch(/the one you didn't practise was practised too, so it can't be compared$/);
    // the control went up, with plenty of words: never "not enough speech"
    const rising = sess("a", "conversation", "2026-10-17T10:00:00-04:00", [filler(30), ...new Array(40).fill("So we we did it, and then we we really did.")]);
    const up = run({ sessions: [before, rising] });
    expect(up.habits.find((h) => h.role === "control")!.verdict).toBe("rose");
    expect(up.claim).toBe("dropped-control-unclear");
    expect(up.headline).toMatch(/the one you didn't practise went up$/);
    expect(up.headline).not.toMatch(/enough speech/);
    expect(run({ drills: [] }).claim).toBe("not-drilled-yet");
    // Only "like" drilled so far (hedges not yet): its after period has started, and the headline says
    // so instead of "not drilled yet". It holds while "like" has too little data, as on the first day.
    const heroes = { ...PREREG, drilled: [{ habit: "hedges", why: "" }, { habit: "filler:like", why: "" }] };
    const likeAt = Date.parse("2026-10-19T20:09:00-04:00"); // late evening in Toronto: still Oct 19 there
    const partly = run({ prereg: heroes, drills: [{ at: likeAt, habitKeys: ["filler:like", "fillers"] }], tz: "America/Toronto" });
    expect(partly.habits.filter((h) => h.role === "drilled").map((h) => [h.habit, h.verdict])).toEqual([["hedges", "not drilled yet"], ["filler:like", "too little data"]]);
    expect(partly.claim).toBe("partly-started");
    expect(partly.headline).toBe('Counting from your first practice: filler "like" since Oct 19; unsure words not practised yet');
    // a drop still outranks it (the claim follows the drop)
    expect(run({ prereg: heroes, drills: [{ at: drill.at, habitKeys: ["hedge:i guess", "hedges"] }] }).claim).toBe("dropped-control-flat");
    const nothing = run({ sessions: [before, sess("a", "conversation", "2026-10-17T10:00:00-04:00", [filler(30), ...new Array(12).fill("I guess we we shipped it.")])] });
    expect(nothing.claim).toBe("no-drop-yet");
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

describe("GET /api/stats ranges", () => {
  it("a conversation or meeting range has no drill period: practice is null and the range is echoed as asked", async () => {
    const { demoSetup } = await import("../src/hub/setup.js");
    const { parseRange } = await import("../src/hub/stats.js");
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const id = hub.sessions[0]!.id;
    for (const asked of [`meeting:${id}`, `session:${id}`]) {
      const s = hub.stats(parseRange(asked)!);
      expect(s.range).toBe(asked);
      expect(s.practice).toBeNull();
      expect(s.sessions.map((x) => x.id)).toEqual([id]);
    }
    expect(hub.stats({ kind: "all" }).practice!.attempts).toBe(hub.attempts.length);
    hub.dispose();
  });
});

describe("first signal: the next conversation after the first drill", () => {
  // Tue: a stand-up the morning before, the drill at 10:02, the stand-up at 11:15 (synthetic)
  const tz = "America/Toronto";
  const PRE: TransferPrereg = { ...PREREG, drilled: [{ habit: "hedges", why: "" }, { habit: "filler:like", why: "" }] };
  const drillAt = Date.parse("2026-10-20T10:02:00-04:00");
  const likeDrill = { at: drillAt, habitKeys: ["filler:like", "fillers"] };
  const talk = (n: number, likes: number) => [filler(n), ...new Array(likes).fill("It was, like, fine.")];
  const mon = sess("mon", "conversation", "2026-10-19T09:30:00-04:00", talk(10, 6)); // 120 + 24 words, 6 likes
  const tue = sess("tue", "conversation", "2026-10-20T11:15:00-04:00", talk(10, 1));
  const run = (sessions: StatSession[], o: Partial<Parameters<typeof transfer>[0]> = {}) => transfer({ sessions, prereg: PRE, preregPath: "p", drills: [likeDrill], nowMs: Date.now(), tz, ...o }).firstSignal;
  it("measured: the last conversation before vs the next after, per drilled habit that was drilled", () => {
    const fs = run([mon, tue]);
    expect(fs.map((f) => f.habit)).toEqual(["filler:like"]); // hedges not drilled yet: no line
    expect(fs[0]).toMatchObject({ status: "measured", before: { session: "mon", date: "2026-10-19", count: 6 }, after: { session: "tue", date: "2026-10-20", count: 1 }, minWords: 100 });
    expect(fs[0]!.deltaPer100).toBeCloseTo(fs[0]!.after!.per100 - fs[0]!.before!.per100, 2);
    expect(fs[0]!.note).toMatch(/not proof/);
    expect(firstSignalSentence(fs)).toBe(`First signal, from one conversation and not proof: in your next conversation after practising, filler "like" went from ${fs[0]!.before!.per100.toFixed(1)} to ${fs[0]!.after!.per100.toFixed(1)} per 100 words.`);
  });
  it("no next conversation yet: no number, and nothing to say", () => {
    const fs = run([mon]);
    expect(fs[0]).toMatchObject({ status: "no-next-conversation", after: null, deltaPer100: null });
    expect(firstSignalSentence(fs)).toBeNull();
    expect(run([mon], { drills: [] })).toEqual([]);
  });
  it("too few words on either side: says so instead of a number", () => {
    const short = sess("tue", "conversation", "2026-10-20T11:15:00-04:00", ["Yes, like, sure."]);
    const fs = run([mon, short]);
    expect(fs[0]).toMatchObject({ status: "too-few-words", deltaPer100: null, after: { words: 3 } });
    expect(firstSignalSentence(fs)).toBe('First signal: your next conversation after practising filler "like" was too short to compare (3 words; it takes 100).');
    const shortBefore = run([sess("mon", "conversation", "2026-10-19T09:30:00-04:00", ["Like, ok."]), tue]);
    expect(firstSignalSentence(shortBefore)).toBe('First signal: your last conversation before practising filler "like" was too short to compare (2 words; it takes 100).');
  });
  it("no conversation before the drill to compare with", () => {
    expect(run([tue])[0]).toMatchObject({ status: "no-earlier-conversation", before: null, deltaPer100: null });
  });
  it("drill lines are not everyday speech: a conversation of drill attempts only is skipped", () => {
    const drillOnly = sess("drill", "conversation", "2026-10-20T10:01:00-04:00", ["The dashboard loads slowly on Mondays."]);
    drillOnly.startMs = drillAt + 30_000;
    const keys = new Set(["drill:0"]);
    const fs = run([mon, drillOnly, tue], { drillLines: { keys, spans: [] } });
    expect(fs[0]!.after!.session).toBe("tue");
  });
  it("a short exchange right after the drill is passed over: the first conversation with enough words is compared", () => {
    const short = sess("short", "conversation", "2026-10-20T10:12:00-04:00", ["Yes, like, sure.", "Sounds good."]);
    const fs = run([mon, short, tue]);
    expect(fs[0]).toMatchObject({ status: "measured", before: { session: "mon" }, after: { session: "tue" } });
    // and the same on the before side: a short exchange just before the drill is not the "before"
    const shortBefore = sess("early", "conversation", "2026-10-20T09:40:00-04:00", ["Like, ok."]);
    expect(run([mon, shortBefore, short, tue])[0]).toMatchObject({ status: "measured", before: { session: "mon" }, after: { session: "tue" } });
  });
  it("before is strictly pre-drill: a conversation still going at the drill counts only what was said before it", () => {
    // started at 09:50, before the 10:02 drill; 12 lines before it, 6 "like" lines after it
    const start = Date.parse("2026-10-20T09:50:00-04:00");
    const over: StatSession = { id: "over", kind: "conversation", startMs: start, lines: [] };
    talk(10, 0).forEach((t, i) => over.lines.push({ key: `o:${i}`, text: t, dom: "en", uncertain: false, spokenAt: start + i * 1000 }));
    for (let i = 0; i < 6; i++) over.lines.push({ key: `o:a${i}`, text: "It was, like, fine.", dom: "en", uncertain: false, spokenAt: drillAt + 60_000 + i * 1000 });
    const f = run([over, tue])[0]!;
    expect(f).toMatchObject({ status: "measured", before: { session: "over", count: 0 } });
    expect(f.before!.words).toBe(wordsOf(talk(10, 0)));
  });
  it("/api/stats' next-session glance compares the same two conversations as the first signal", () => {
    const short = sess("short", "conversation", "2026-10-20T10:12:00-04:00", ["Yes, like, sure."]);
    const fs = run([mon, short, tue])[0]!;
    const d = nextSessionDeltas([mon, short, tue], [likeDrill], tz).find((x) => x.habit === "filler:like")!;
    expect([d.lastSessionBefore?.session, d.nextSessionAfter?.session]).toEqual([fs.before!.session, fs.after!.session]);
    expect(d.deltaPer100).toBe(fs.deltaPer100);
    // too short on one side: no number from either
    const only = nextSessionDeltas([mon, short], [likeDrill], tz).find((x) => x.habit === "filler:like")!;
    expect(only).toMatchObject({ nextSessionAfter: { session: "short" }, deltaPer100: null });
  });
});
