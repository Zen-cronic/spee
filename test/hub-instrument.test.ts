// GET /api/instrument (src/hub/instrument.ts) and the TV's secondary "including meeting captions"
// line (captionsLine in tv/web/src/mirror/format.ts). SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUMENT_MIN_WORDS, type InstrumentResponse, type TransferResponse } from "../src/hub/contract.js";
import { habitAgrees, instrumentReport, ratesAgree } from "../src/hub/instrument.js";
import { rateCi95 } from "../src/real/talk.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { sourceBreakdown, type StatSession } from "../src/hub/stats.js";
import { captionsLine } from "../tv/web/src/mirror/format.js";

const T = Date.parse("2026-10-19T11:00:00-04:00");
const TZ = "America/Toronto";
const session = (id: string, kind: StatSession["kind"], startMs: number, texts: string[]): StatSession => ({ id, kind, startMs, lines: texts.map((text, i) => ({ key: `${id}:${i}`, text, dom: "en", uncertain: false })) });
const SAY = "The export finished and I guess the totals match, like, the ledger we keep for the team.";
const many = (s: string, n: number) => new Array(n).fill(s);

describe("instrumentReport", () => {
  it("no pairs, then too little data, then similar numbers on the practised habits and a difference on um/uh", () => {
    expect(instrumentReport([session("b", "conversation", T, many(SAY, 20))], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true }).claim).toBe("no-pairs");
    const short = instrumentReport([session("m", "meeting", T, [SAY]), session("b", "conversation", T + 60_000, [SAY])], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(short.claim).toBe("too-little-data");
    expect(short.habits.every((h) => h.agree === null)).toBe(true);
    const cap = many(SAY, 60); // 1,020 words, 60 of each practised habit
    const bee = cap.map((t, i) => (i % 2 ? `Um, ${t}` : t));
    const r = instrumentReport([session("meet-1", "meeting", T, cap), session("bee-1", "conversation", T + 120_000, bee), session("bee-far", "conversation", T + 5 * 3600_000, many("Unrelated words here.", 30))], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(r.pairs).toBe(1);
    expect(r.from).toBe("2026-10-19");
    expect(r.words.captions).toBeGreaterThanOrEqual(INSTRUMENT_MIN_WORDS);
    expect(r.claim).toBe("practised-agree");
    const h = Object.fromEntries(r.habits.map((x) => [x.habit, x]));
    expect(h.hedges!.agree).toBe(true);
    expect(h["filler:like"]!.agree).toBe(true);
    expect(h["um-uh"]!.agree).toBe(false);
    expect(h.hedges!.captions).toMatchObject({ count: 60 });
    expect(h.hedges!.captions.ci95[0]).toBeLessThan(h.hedges!.captionsPer100);
    expect(h["um-uh"]!.beePer100).toBeGreaterThan(h["um-uh"]!.captionsPer100);
    // aggregates only: no line text and no session id leaves the report
    const out = JSON.stringify(r);
    for (const leak of ["ledger", "meet-1", "bee-1", "Unrelated"]) expect(out).not.toContain(leak);
  });
  it("counts only Bee's lines inside the meeting's time, and a weaker start-time match is said in the note", () => {
    const timed = (id: string, kind: StatSession["kind"], startMs: number, texts: string[], everyMs: number): StatSession => ({ ...session(id, kind, startMs, texts), lines: texts.map((text, i) => ({ key: `${id}:${i}`, text, dom: "en", uncertain: false, spokenAt: startMs + i * everyMs })) });
    const m = { ...session("meet-1", "meeting", T, many(SAY, 20)), timeline: { session: "meet-1", durationMin: 18, speakers: 4, highlightLinesSkipped: 0, steps: [] } };
    // 20 lines one minute apart inside the meeting (and its minute of clock slack), then 20 more after it ended (same recording)
    const b = timed("bee-1", "conversation", T, [...many(SAY, 20), ...many("Um um um after the call.", 20)], 60_000);
    const r = instrumentReport([m, b], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(r.words.bee).toBe(r.words.captions);
    expect(r.habits.find((h) => h.habit === "um-uh")!.beePer100).toBe(0);
    expect(r.note).not.toMatch(/start time only/);
    const weak = instrumentReport([session("m", "meeting", T, many(SAY, 20)), session("b", "conversation", T + 60_000, many(SAY, 20))], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(weak.note).toMatch(/1 of the 1 matched by start time only, a weaker match/);
  });
  it("one short meeting is too little to compare, though the point rates match (11 against 11 unsure words)", () => {
    const line = "The export finished and I guess the totals match the ledger we keep for the whole team today and tomorrow and next week too, right on time and on budget again, okay.";
    const plain = "The export finished and the totals match the ledger we keep for the whole team today and tomorrow and next week too, right on time and on budget again, okay then.";
    const texts = [...many(line, 11), ...many(plain, 9)];
    const r = instrumentReport([session("m", "meeting", T, texts), session("b", "conversation", T + 60_000, texts)], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: false });
    expect(r.words.captions).toBeGreaterThan(INSTRUMENT_MIN_WORDS);
    expect(r.words.captions).toBeLessThan(1000);
    expect(r.habits.find((h) => h.habit === "hedges")).toMatchObject({ captions: { count: 11 }, bee: { count: 11 }, agree: null });
    expect(r.claim).toBe("too-little-data");
  });
  it("captions copied from Bee's own lines (the synthetic demo) are never compared", () => {
    const cap = { ...session("meet-1", "meeting", T, many(SAY, 60)), copyOf: "bee-1" };
    const r = instrumentReport([cap, session("bee-1", "conversation", T + 120_000, many(SAY, 60))], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(r.habits.every((h) => h.agree === null)).toBe(true);
    expect(r.claim).toBe("too-little-data");
    expect(r.note).toMatch(/copied from Bee's own lines/);
  });
  it("a handful of a habit is never compared, even on 1,000 words a side; enough on one side is", () => {
    const r = (count: number, words: number) => ({ count, per100: Math.round((count / words) * 10000) / 100, ci95: rateCi95(count, words) });
    for (const [c, b] of [[3, 0], [4, 1], [0, 0], [19, 19]]) expect(habitAgrees(r(c!, 1000), 1000, r(b!, 1000), 1000)).toBeNull();
    expect(habitAgrees(r(25, 1000), 1000, r(0, 1000), 1000)).toBe(false); // one side heard plenty, the other none: a real difference
    expect(habitAgrees(r(22, 1000), 1000, r(20, 1000), 1000)).toBe(true);
    expect(habitAgrees(r(25, 500), 500, r(5, 500), 500)).toBeNull(); // under 1,000 words both sides need the floor
  });
  it("tolerance: an absolute floor for small rates and a share of the higher rate", () => {
    expect(ratesAgree(1.62, 1.57)).toBe(true);
    expect(ratesAgree(5.47, 5.44)).toBe(true);
    expect(ratesAgree(4.73, 6.72)).toBe(false);
    expect(ratesAgree(0, 0.3)).toBe(true);
    expect(ratesAgree(0, 0.4)).toBe(false);
  });
  it("sourceBreakdown gives each source's first and last local date", () => {
    const b = sourceBreakdown([session("m1", "meeting", Date.parse("2026-09-22T10:00:00-04:00"), [SAY]), session("m2", "meeting", T, [SAY]), session("c", "conversation", T, [SAY])], TZ);
    expect(b.meeting).toMatchObject({ sessions: 2, from: "2026-09-22", to: "2026-10-19" });
    expect(b.conversation).toMatchObject({ sessions: 1, from: "2026-10-19", to: "2026-10-19" });
  });
});

describe("captionsLine (TV)", () => {
  const habit = (h: string, role: "drilled" | "control", b: number, a: number, afterWords = 900) => ({ habit: h, label: h, role, verdict: "dropped", before: { per100: b, words: 900 }, after: { per100: a, words: afterWords } });
  const all = (meetings: number) =>
    ({ source: "all", minWordsPerPeriod: 400, sources: { conversation: { sessions: 6, words: 1700, label: "", from: "2026-10-13" }, ...(meetings ? { meeting: { sessions: meetings, words: 900, label: "", from: "2026-09-22" } } : {}) }, habits: [habit("hedges", "drilled", 2.34, 0.51), habit("filler:like", "drilled", 3, 0.85), habit("restart", "control", 0.75, 0.85)] }) as unknown as TransferResponse;
  const inst = (claim: InstrumentResponse["claim"], restartAgree: boolean | null = true) => ({ pairs: 1, claim, habits: [{ habit: "restart", agree: restartAgree }] }) as unknown as InstrumentResponse;
  it("hidden without a caption session or without source=all", () => {
    expect(captionsLine(all(0), inst("practised-agree"))).toBeNull();
    expect(captionsLine({ ...all(4), source: "bee" } as TransferResponse, null)).toBeNull();
    expect(captionsLine(null, null)).toBeNull();
  });
  it("labels the count and the earliest date from the data, and never as the pre-registered check", () => {
    const l = captionsLine(all(4), inst("practised-agree"))!;
    expect(l.label).toBe("4 captioned meetings since Sep 22 · not the pre-registered check");
    expect(l.habits.map((h) => [h.title, h.before, h.after, h.unchecked])).toEqual([
      ["Unsure words", "2.3", "0.5", false],
      ["Filler “like”", "3.0", "0.9", false],
      ["Starting over", "0.8", "0.9", false],
    ]);
    expect(l.agree).toBe("On 1 meeting both heard, captions and Bee gave similar numbers for unsure words and filler “like”");
    expect(JSON.stringify(l)).not.toMatch(/filler words|“um”|uh/i);
  });
  it("a period without the minimum words is a dash, never 0.0 (as on the cards)", () => {
    const t = all(1);
    t.habits[0] = habit("hedges", "drilled", 2.34, 0, 0) as never;
    t.habits[1] = habit("filler:like", "drilled", 3, 0, 120) as never;
    const l = captionsLine(t, null)!;
    expect(l.habits.map((h) => [h.before, h.after])).toEqual([["2.3", "—"], ["3.0", "—"], ["0.8", "0.9"]]);
  });
  it("says similar numbers only when the instrument check finds it, too little data when so; an unchecked control is marked", () => {
    for (const c of ["practised-differ", "no-pairs"] as const) expect(captionsLine(all(1), inst(c))!.agree).toBeNull();
    expect(captionsLine(all(1), inst("too-little-data"))!.agree).toBe("Captions and Bee: too little data to compare yet (1 meeting both heard)");
    expect(captionsLine(all(1), null)!.agree).toBeNull();
    expect(captionsLine(all(1), inst("practised-agree", null))!.habits.find((h) => h.habit === "restart")!.unchecked).toBe(true);
    expect(captionsLine(all(1), null)!.label).toBe("1 captioned meeting since Sep 22 · not the pre-registered check");
  });
});

describe("GET /api/instrument on the demo hub", () => {
  let s: HubServer;
  beforeAll(async () => {
    s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), maskTerms: [] });
  });
  afterAll(async () => s.close());
  it("leaves a drill sentence said during a captioned meeting out of Bee's side, as every other view does", async () => {
    const setup = demoSetup({ pace: 0.05, stateDir: null });
    const t = Date.parse("2026-10-19T11:00:00-04:00");
    const DRILL = "We will ship the export on Friday after the demo with no hedging at all.";
    const timedLines = (id: string, texts: string[]) => texts.map((text, i) => ({ key: `${id}:${i}`, text, dom: "en" as const, uncertain: false, spokenAt: t + 5_000 + i * 20_000 }));
    const meeting: StatSession = { id: "meet-x", kind: "meeting", startMs: t, endMs: t + 30 * 60_000, lines: timedLines("meet-x", many(SAY, 40)) };
    const beeLines = timedLines("bee-x", many(SAY, 40));
    beeLines.push({ key: "u:7777", text: DRILL, dom: "en", uncertain: false, spokenAt: t + 10 * 60_000 });
    const bee: StatSession = { id: "bee-x", kind: "conversation", startMs: t, endMs: t + 30 * 60_000, lines: beeLines, speakers: 4 };
    setup.hub.sessions = [meeting, bee];
    setup.hub.attempts = [
      {
        id: "att-x", cardId: "c1", sessionId: null, status: "graded", counted: true, createdAt: t + 10 * 60_000 + 9_000, settledAt: t + 10 * 60_000 + 10_000, provisional: null,
        bee: { text: DRILL, utteranceIds: [9001], speakerScore: 0.9, via: "stream", latencyMs: 8000, coverage: null, replay: false, spokenFromMs: t + 10 * 60_000 - 2_000, spokenToMs: t + 10 * 60_000 + 2_000, conversationId: "bee-x" },
        final: { source: "bee", pass: true, grade: {} as never }, agreement: null, reason: "", box: null,
      },
    ];
    const srv = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup, maskTerms: [] });
    try {
      const r = (await (await fetch(`${srv.url}/api/instrument`)).json()) as InstrumentResponse;
      expect(r.pairs).toBe(1);
      expect(r.words.bee).toBe(r.words.captions); // the drill sentence is not Bee's everyday speech
      expect(instrumentReport(setup.hub.sessions, { nowMs: t, tz: TZ, dataLabel: "x", synthetic: true }).words.bee).toBeGreaterThan(r.words.captions);
    } finally {
      await srv.close();
    }
  });
  it("pairs the synthetic stand-up's captions with its Bee conversation, aggregates only; the Bee-only transfer is unchanged", async () => {
    const r = (await (await fetch(`${s.url}/api/instrument`)).json()) as InstrumentResponse;
    // the demo's captions are copies of Bee's lines: never shown as agreeing
    expect(r).toMatchObject({ synthetic: true, pairs: 1, from: "2026-10-13", claim: "too-little-data" });
    expect(r.dataLabel).toMatch(/SYNTHETIC/);
    expect(JSON.stringify(r)).not.toMatch(/demo-(bee|meet)-/);
    const bee = (await (await fetch(`${s.url}/api/transfer`)).json()) as TransferResponse;
    expect(bee.source).toBe("bee");
    expect(bee.sources.meeting).toBeUndefined();
    expect(bee.claim).toBe("all-dropped-control-flat");
    const withCaptions = (await (await fetch(`${s.url}/api/transfer?source=all`)).json()) as TransferResponse;
    // The Oct 13 stand-up was heard by Bee too, all of it: it counts once, from Bee, so two caption sessions remain.
    expect(withCaptions.sources.meeting).toMatchObject({ sessions: 2, from: "2026-10-14", to: "2026-10-19" });
    expect(withCaptions.sources.conversation!.words).toBe(bee.sources.conversation!.words);
    expect(captionsLine(withCaptions, r)!.label).toBe("2 captioned meetings since Oct 14 · not the pre-registered check");
  });
});
