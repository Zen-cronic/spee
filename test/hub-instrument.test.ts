// GET /api/instrument (src/hub/instrument.ts) and the TV's secondary "including meeting captions"
// line (captionsLine in tv/web/src/mirror/format.ts). SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUMENT_MIN_WORDS, type InstrumentResponse, type TransferResponse } from "../src/hub/contract.js";
import { instrumentReport, ratesAgree } from "../src/hub/instrument.js";
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
  it("no pairs, then too little data, then agreement on the practised habits and a difference on um/uh", () => {
    expect(instrumentReport([session("b", "conversation", T, many(SAY, 20))], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true }).claim).toBe("no-pairs");
    const short = instrumentReport([session("m", "meeting", T, [SAY]), session("b", "conversation", T + 60_000, [SAY])], { nowMs: T, tz: TZ, dataLabel: "x", synthetic: true });
    expect(short.claim).toBe("too-little-data");
    expect(short.habits.every((h) => h.agree === null)).toBe(true);
    const cap = many(SAY, 20);
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
  const habit = (h: string, role: "drilled" | "control", b: number, a: number) => ({ habit: h, label: h, role, before: { per100: b }, after: { per100: a } });
  const all = (meetings: number) =>
    ({ source: "all", sources: { conversation: { sessions: 6, words: 1700, label: "", from: "2026-10-13" }, ...(meetings ? { meeting: { sessions: meetings, words: 900, label: "", from: "2026-09-22" } } : {}) }, habits: [habit("hedges", "drilled", 2.34, 0.51), habit("filler:like", "drilled", 3, 0.85), habit("restart", "control", 0.75, 0.85)] }) as unknown as TransferResponse;
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
    expect(l.agree).toBe("Captions and Bee agree on unsure words and filler “like” (1 meeting both heard)");
    expect(JSON.stringify(l)).not.toMatch(/filler words|“um”|uh/i);
  });
  it("says agreement only when the instrument check finds it; an unchecked control is marked", () => {
    for (const c of ["practised-differ", "too-little-data", "no-pairs"] as const) expect(captionsLine(all(1), inst(c))!.agree).toBeNull();
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
  it("pairs the synthetic stand-up's captions with its Bee conversation, aggregates only; the Bee-only transfer is unchanged", async () => {
    const r = (await (await fetch(`${s.url}/api/instrument`)).json()) as InstrumentResponse;
    expect(r).toMatchObject({ synthetic: true, pairs: 1, from: "2026-10-13", claim: "practised-agree" });
    expect(r.dataLabel).toMatch(/SYNTHETIC/);
    expect(JSON.stringify(r)).not.toMatch(/demo-(bee|meet)-/);
    const bee = (await (await fetch(`${s.url}/api/transfer`)).json()) as TransferResponse;
    expect(bee.source).toBe("bee");
    expect(bee.sources.meeting).toBeUndefined();
    expect(bee.claim).toBe("all-dropped-control-flat");
    const withCaptions = (await (await fetch(`${s.url}/api/transfer?source=all`)).json()) as TransferResponse;
    expect(withCaptions.sources.meeting).toMatchObject({ sessions: 3, from: "2026-10-13", to: "2026-10-19" });
    expect(captionsLine(withCaptions, r)!.label).toBe("3 captioned meetings since Oct 13 · not the pre-registered check");
  });
});
