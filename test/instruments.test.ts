import { describe, expect, it } from "vitest";
import { habitTitle } from "../src/hub/habitNames.js";
import { fromSource, habitRates, mergeCorpus, type StatSession } from "../src/hub/stats.js";
import { instrumentCheck, instrumentCheckLines, pairMeetings, transcriberRates } from "../src/real/instruments.js";

const MIN = 60_000;
const T = Date.UTC(2026, 9, 19, 17, 30);
// A session whose lines are spoken `everyMs` apart from its start (spokenAt), or untimed.
const session = (id: string, kind: StatSession["kind"], startMs: number, texts: string[], o: { everyMs?: number; endMs?: number; durationMin?: number } = {}): StatSession => ({
  id,
  kind,
  startMs,
  ...(o.endMs != null ? { endMs: o.endMs } : {}),
  lines: texts.map((text, i) => ({ key: `${id}:${i}`, text, dom: "en", uncertain: false, spokenAt: o.everyMs != null ? startMs + i * o.everyMs : null })),
  ...(o.durationMin != null ? { timeline: { session: id, durationMin: o.durationMin, speakers: 4, highlightLinesSkipped: 0, steps: [] } } : {}),
});
const ids = (ss: StatSession[]) => pairMeetings(ss).pairs.map((p) => [p.meeting, p.bee, p.match]);

describe("instrument check", () => {
  it("counts every compared habit with the hub's habit rules, with 95% intervals", () => {
    const lines = ["Um I guess it was like done, you know.", "Uh maybe we ship it.", "I I think so."].map((text) => ({ text }));
    const r = transcriberRates(lines);
    const h = habitRates([session("s", "conversation", 0, lines.map((l) => l.text))]);
    expect(r.words).toBe(h.words);
    expect(r.habits.hedges.count).toBe(h.hedges.count);
    expect(r.habits.fillers.count).toBe(h.fillers.count);
    expect(r.habits["filler:like"].count).toBe(h.fillers.breakdown.like ?? 0);
    expect(r.habits["um-uh"].count).toBe(2);
    expect(r.habits["filler:you know"].count).toBe(1);
    // the control habit (starting over) is compared too
    expect(r.habits.restart.count).toBe(h.restarts.count);
    expect(r.habits.restart.count).toBeGreaterThan(0);
    expect(r.habits.hedges.ci95[0]).toBeLessThan(r.habits.hedges.per100);
    expect(r.habits.hedges.ci95[1]).toBeGreaterThan(r.habits.hedges.per100);
  });

  it("does not pair a Bee conversation that ended before the meeting started", () => {
    const pairs = ids([
      session("meet-x", "meeting", T, ["I guess we ship it.", "Fine."], { everyMs: 5 * MIN, durationMin: 30 }),
      session("bee-hall", "conversation", T - 40 * MIN, ["Um hallway talk.", "Um more of it."], { everyMs: 5 * MIN, endMs: T - 20 * MIN }),
    ]);
    expect(pairs).toEqual([]);
    expect(pairMeetings([session("meet-x", "meeting", T, ["Hi."], { durationMin: 30 }), session("bee-hall", "conversation", T - 40 * MIN, ["Um."], { endMs: T - 20 * MIN })]).skipped).toEqual([{ meeting: "meet-x", reason: "not-heard-by-bee", bee: [] }]);
  });

  it("uses every Bee conversation that covers a meeting Bee split in two", () => {
    const r = pairMeetings([
      session("meet-s", "meeting", T, ["a b c d", "e f g h"], { everyMs: 30 * MIN, durationMin: 60 }),
      session("bee-1", "conversation", T + MIN, ["Um one two."], { everyMs: MIN, endMs: T + 30 * MIN }),
      session("bee-2", "conversation", T + 35 * MIN, ["Uh three four."], { everyMs: MIN, endMs: T + 60 * MIN }),
    ]);
    expect(r.pairs.map((p) => [p.meeting, p.bee, p.match])).toEqual([["meet-s", ["bee-1", "bee-2"], "overlap"]]);
    expect(transcriberRates(r.pairs[0]!.beeLines).habits["um-uh"].count).toBe(2);
  });

  it("cuts Bee's lines to the meeting's time", () => {
    const [p] = pairMeetings([
      session("meet-c", "meeting", T, ["I guess so."], { durationMin: 25 }),
      // one Bee recording: 10 min of chat before, the meeting, 10 min after (one line every 10 min)
      session("bee-long", "conversation", T - 10 * MIN, ["Um before.", "I guess so.", "Fine.", "Done.", "Um um after."], { everyMs: 10 * MIN }),
    ]).pairs;
    expect(p!.beeLines.map((l) => l.text)).toEqual(["I guess so.", "Fine.", "Done."]);
  });

  it("never lets two meetings share Bee's lines", () => {
    const r = pairMeetings([
      session("meet-a", "meeting", T, ["First meeting."], { durationMin: 25 }),
      // starts before the first one ends: Bee's line at +20 min falls in both windows
      session("meet-b", "meeting", T + 20 * MIN, ["Second meeting."], { durationMin: 25 }),
      session("bee-both", "conversation", T, ["one", "two", "three", "four", "five", "six"], { everyMs: 10 * MIN }),
    ]);
    const [a, b] = r.pairs;
    expect([a!.meeting, b!.meeting]).toEqual(["meet-a", "meet-b"]);
    const keysA = new Set(a!.beeLines.map((l) => l.key));
    expect(b!.beeLines.some((l) => keysA.has(l.key))).toBe(false);
    expect(a!.beeLines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(b!.beeLines.map((l) => l.text)).toEqual(["four", "five"]);
  });

  it("falls back to the nearest start (weaker) only when an end time is missing, and takes a conversation once", () => {
    const r = pairMeetings([
      session("meet-a", "meeting", T, ["I guess we ship it."]),
      session("meet-a2", "meeting", T + 10 * MIN, ["Second call."]),
      session("bee-far", "conversation", T - 3 * 3600_000, ["Something else entirely."]),
      session("bee-near", "conversation", T + 4 * MIN, ["Um I guess we ship it."]),
      session("meet-b", "meeting", T + 2 * 86400_000, ["No Bee recording for this one."]),
    ]);
    expect(r.pairs.map((p) => [p.meeting, p.bee, p.match])).toEqual([["meet-a", ["bee-near"], "nearest-start"]]);
    expect(r.skipped.map((s) => s.meeting)).toEqual(["meet-a2", "meet-b"]);
  });

  it("skips a meeting when either side has no English lines of the wearer, and says why", () => {
    const noCaptions = session("meet-z", "meeting", T, [], { durationMin: 30 });
    const bee = session("bee-z", "conversation", T + MIN, ["Um I guess so."], { everyMs: MIN, endMs: T + 20 * MIN });
    let r = pairMeetings([noCaptions, bee]);
    expect(r.pairs).toEqual([]);
    expect(r.skipped).toEqual([{ meeting: "meet-z", reason: "no-caption-lines", bee: ["bee-z"] }]);
    const out = instrumentCheckLines(instrumentCheck([noCaptions, bee]), habitTitle).join("\n");
    expect(out).toContain("meet-z: skipped: the captions have no English lines of yours");
    expect(out).not.toContain("captions: count");
    const french = session("bee-fr", "conversation", T + MIN, ["Je pense que oui."], { everyMs: MIN, endMs: T + 20 * MIN });
    french.lines[0]!.dom = "fr";
    r = pairMeetings([session("meet-y", "meeting", T, ["I guess."], { durationMin: 30 }), french]);
    expect(r.skipped).toEqual([{ meeting: "meet-y", reason: "no-bee-lines", bee: ["bee-fr"] }]);
  });

  it("leaves out uncertain and French lines", () => {
    const m = session("meet-c", "meeting", T, ["Like, I guess so."], { durationMin: 10 });
    const b = session("bee-c", "conversation", T, ["Like, I guess so."], { endMs: T + 5 * MIN });
    b.lines.push({ key: "x", text: "Um um um um.", dom: "en", uncertain: true }, { key: "y", text: "Je pense que oui.", dom: "fr", uncertain: false });
    const c = instrumentCheck([m, b]);
    expect(c.pairs[0]!.beeRates).toEqual(c.pairs[0]!.captions);
  });

  it("prints counts and 95% intervals and says how each pair was matched, no line text", () => {
    const c = instrumentCheck([session("meet-p", "meeting", T, ["Um I guess the export is done."], { durationMin: 10 }), session("bee-p", "conversation", T, ["Um I guess the export is done."], { endMs: T + 5 * MIN })]);
    const out = instrumentCheckLines(c, habitTitle).join("\n");
    expect(out).toContain("matched by time");
    expect(out).toContain("Starting over");
    expect(out).toContain("Unsure words");
    expect(out).toMatch(/\d+\.\d\d-\d+\.\d\d/);
    expect(out).not.toContain("export");
    expect(JSON.stringify(c)).not.toContain("export");
  });

  it("source=all counts a meeting Bee also heard once, from Bee", () => {
    const m = session("meet-d", "meeting", T, ["Um I guess so."], { durationMin: 30 });
    const b = session("bee-d", "conversation", T + MIN, ["Um I guess so."], { endMs: T + 20 * MIN });
    const other = session("meet-e", "meeting", T + 86400_000, ["A meeting Bee missed."], { durationMin: 30 });
    expect(fromSource([m, b, other], "all").map((s) => s.id)).toEqual(["bee-d", "meet-e"]);
    expect(fromSource([m, b, other], "bee").map((s) => s.id)).toEqual(["bee-d"]);
    expect(habitRates(fromSource([m, b, other], "all")).words).toBe(4 + 4);
  });

  it("keeps Bee's end time from the corpus", () => {
    const byId = new Map<string, StatSession>();
    mergeCorpus(byId, { generatedAt: "", wearer: {} as never, sessions: [{ id: "c1", kind: "conversation", state: "COMPLETED", startMs: T, endMs: T + 5 * MIN, totalLines: 0, wearerLines: 0, uncertainLines: 0, wearerShare: 0 }], lines: [] });
    expect(byId.get("c1")!.endMs).toBe(T + 5 * MIN);
  });
});

describe("source=all: a meeting Bee heard only part of", () => {
  const PLAIN = "The billing export finished on Monday and the totals match the ledger today";
  const m0 = Date.UTC(2026, 9, 21, 14, 0);
  const meeting = session("meet-x", "meeting", m0, Array.from({ length: 120 }, () => PLAIN), { everyMs: 30_000, durationMin: 60 });
  it("keeps the captions and leaves out Bee's lines inside the meeting when the watch stopped two minutes in", () => {
    const bee = session("456", "conversation", m0 - 3 * MIN, ["Morning everyone I can hear you fine", "Before we start, coffee anyone"], { everyMs: 30_000, endMs: m0 + 2 * MIN });
    bee.lines[0]!.spokenAt = m0 - 2 * MIN; // said before the meeting began: stays counted
    bee.lines[1]!.spokenAt = m0 + 30_000;
    const all = fromSource([meeting, bee], "all");
    expect(all.map((s) => s.id).sort()).toEqual(["456", "meet-x"]);
    expect(all.find((s) => s.id === "456")!.lines.map((l) => l.text)).toEqual(["Morning everyone I can hear you fine"]);
    expect(habitRates(all).words).toBe(habitRates([meeting]).words + 7);
  });
  it("counts the meeting once, from Bee, when Bee heard most of its words", () => {
    const bee = session("789", "conversation", m0, Array.from({ length: 70 }, () => PLAIN), { everyMs: 30_000, endMs: m0 + 60 * MIN });
    expect(fromSource([meeting, bee], "all").map((s) => s.id)).toEqual(["789"]);
  });
  it("counts it from Bee when Bee's lines span most of the meeting, though captions caught more words", () => {
    const bee = session("790", "conversation", m0, Array.from({ length: 30 }, () => "Yes that works"), { everyMs: 100_000, endMs: m0 + 60 * MIN });
    expect(fromSource([meeting, bee], "all").map((s) => s.id)).toEqual(["790"]);
  });
});
