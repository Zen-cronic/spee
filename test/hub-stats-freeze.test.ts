// COACH_STATS_UNTIL freezes the measurement: the stats, the transfer, the instrument check, the
// settings view and "how am I doing?" count only the conversations that started by then and the
// drills made by then, and say so (asOf). Drills, live coaching and the deck stay live. Unset, the
// hub answers exactly as before.
//
// fixtures/synthetic/stats-freeze-snapshot-b.json is SYNTHETIC: per-session counts shaped like the
// hub's transfer at snapshot B (21 conversations through Oct 21, a "like" drill on Oct 19, the first
// hedges drill and two more conversations after the 09:39 freeze). Its `expected` block is that
// snapshot's numbers. This test writes neutral sentences to match the counts; no real speech.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleAlexa, type SkillDeps } from "../src/alexa/skill.js";
import type { AlexaRequestEnvelope } from "../src/alexa/types.js";
import type { HubCard } from "../src/hub/cards.js";
import { CoachHub, type Attempt } from "../src/hub/core.js";
import { buildPrereg } from "../src/hub/demoData.js";
import { computeBaseline } from "../src/hub/live/baseline.js";
import { composeGoal } from "../src/hub/live/facts.js";
import type { HubDeck } from "../src/hub/scheduler.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import type { Setup } from "../src/hub/setup.js";
import { asOfAt, NO_DROP_YET_HEADLINE, parseStatsUntil, transfer, type StatSession } from "../src/hub/stats.js";
import { HubClient } from "../src/mcp/hubClient.js";

interface FxSession {
  id: string;
  start: string;
  words: number;
  like: number;
  restart: number;
  hedges: number;
}
interface FxPeriod {
  sessions: number;
  words: number;
  count: number;
  per100: number;
  from: string | null;
  to: string | null;
}
interface Fx {
  statsUntil: string;
  now: string;
  tz: string;
  drills: { at: string; habit: "filler:like" | "hedges" }[];
  sessions: FxSession[];
  expected: {
    claim: string;
    headline: string;
    sources: { conversation: { sessions: number; words: number; from: string; to: string } };
    habits: { habit: string; role: string; firstDrillAt: number | null; cutoverAt: number | null; verdict: string; before: FxPeriod; after: FxPeriod }[];
    firstSignal: { habit: string; status: string; firstDrillAt: number; before: number; after: number }[];
  };
}
const FX = JSON.parse(readFileSync(new URL("../fixtures/synthetic/stats-freeze-snapshot-b.json", import.meta.url), "utf8")) as Fx;
const UNTIL = Date.parse(FX.statsUntil);
const NOW = Date.parse(FX.now);

// Neutral sentences, five words each, with one of a habit: the session's counts, then plain words.
const LIKE = "so, like, we went home";
const RESTART = "the the plan was fine";
const HEDGE = "I guess we went home";
const PLAIN = "we went to the shop and it was fine".split(" ");
function session(s: FxSession): StatSession {
  const texts = [...Array<string>(s.like).fill(LIKE), ...Array<string>(s.restart).fill(RESTART), ...Array<string>(s.hedges).fill(HEDGE)];
  for (let left = s.words - texts.length * 5; left > 0; left -= PLAIN.length) texts.push(PLAIN.slice(0, Math.min(PLAIN.length, left)).join(" "));
  return { id: s.id, kind: "conversation", startMs: Date.parse(s.start), lines: texts.map((text, i) => ({ key: `u:${s.id}-${i}`, text, dom: "en", uncertain: false })), synthetic: true };
}

const card = (id: string, habit: HubCard["habit"]): HubCard => ({
  id,
  kind: habit!.kind === "filler" ? "filler" : "error",
  lang: "en",
  type: habit!.kind === "filler" ? "EN_FILLER" : "EN_HEDGE_STACK",
  key: `u:${id}`,
  session: "syn-01",
  said: "invented",
  fix: "invented",
  resay: "The export is ready for review today.",
  line: "invented",
  why: "Say it plainly.",
  score: 4,
  box: 1,
  due: "2026-10-22",
  added: "2026-10-15",
  relapses: 0,
  lastSeenSession: "syn-01",
  habit,
  synthetic: true,
});
const CARDS = { "filler:like": card("c:like", { kind: "filler", targets: ["like"], label: 'fillers: "like"' }), hedges: card("c:hedge", { kind: "hedge", targets: ["i guess"], label: 'hedges: "i guess"' }) };
// A counted drill (Bee passed it). No Bee text or span: no line is taken out as a drill line.
const attempt = (d: Fx["drills"][number], i: number) => ({ id: `a${i}`, cardId: CARDS[d.habit].id, sessionId: null, status: "graded", counted: true, createdAt: Date.parse(d.at), settledAt: Date.parse(d.at), provisional: null, bee: null, final: null, agreement: null, reason: "synthetic", box: null, synthetic: true }) as unknown as Attempt;

function makeHub(statsUntil?: number | null) {
  return new CoachHub({
    mode: "live",
    clock: () => NOW,
    tz: FX.tz,
    deck: { cards: Object.values(CARDS) } as unknown as HubDeck,
    deckPath: null,
    attempts: FX.drills.map(attempt),
    attemptsPath: null,
    sessions: FX.sessions.map(session),
    prereg: buildPrereg(),
    preregPath: "prereg/transfer.json",
    wearer: { minScore: 0.5 } as never,
    replay: false,
    dataLabel: "SYNTHETIC",
    ...(statsUntil === undefined ? {} : { statsUntil }),
  });
}

// The snapshot's shape: what the expected block pins, nothing else (no ids, no intervals).
const period = (p: FxPeriod) => ({ sessions: p.sessions, words: p.words, count: p.count, per100: p.per100, from: p.from, to: p.to });
function shape(t: NonNullable<ReturnType<CoachHub["transfer"]>>) {
  const c = t.sources.conversation as unknown as { sessions: number; words: number; from: string; to: string };
  return {
    claim: t.claim,
    headline: t.headline,
    sources: { conversation: { sessions: c.sessions, words: c.words, from: c.from, to: c.to } },
    habits: t.habits.map((h) => ({ habit: h.habit, role: h.role, firstDrillAt: h.firstDrillAt, cutoverAt: h.cutoverAt, verdict: h.verdict, before: period(h.before), after: period(h.after) })),
    firstSignal: t.firstSignal.map((f) => ({ habit: f.habit, status: f.status, firstDrillAt: f.firstDrillAt, before: f.before!.per100, after: f.after!.per100 })),
  };
}

describe("COACH_STATS_UNTIL", () => {
  it("unset or blank is not frozen; an ISO time with a zone is; anything else is refused", () => {
    expect(parseStatsUntil(undefined)).toBeNull();
    expect(parseStatsUntil("")).toBeNull();
    expect(parseStatsUntil("  ")).toBeNull();
    expect(parseStatsUntil("2026-10-22T09:39:00-04:00")).toBe(Date.parse("2026-10-22T13:39:00Z"));
    expect(parseStatsUntil("2026-10-22T13:39:00Z")).toBe(Date.parse("2026-10-22T13:39:00Z"));
    expect(() => parseStatsUntil("2026-10-22T09:39")).toThrow(/with a zone/); // no zone: whose 09:39?
    expect(() => parseStatsUntil("2026-10-22")).toThrow(/with a zone/);
    expect(() => parseStatsUntil("this morning")).toThrow(/COACH_STATS_UNTIL/);
  });

  it("asOf: a label for the screen and a few words for speech, in the hub's time zone", () => {
    expect(asOfAt(UNTIL, NOW, FX.tz)).toEqual({ at: "2026-10-22T13:39:00.000Z", label: "Oct 22, 9:39 am", spoken: "As of this morning" });
    expect(asOfAt(Date.parse("2026-10-22T14:05:00-04:00"), NOW, FX.tz)).toMatchObject({ label: "Oct 22, 2:05 pm", spoken: "As of this afternoon" });
    expect(asOfAt(Date.parse("2026-10-22T18:00:00-04:00"), Date.parse("2026-10-22T20:00:00-04:00"), FX.tz).spoken).toBe("As of this evening");
    expect(asOfAt(UNTIL, Date.parse("2026-10-23T08:00:00-04:00"), FX.tz).spoken).toBe("As of yesterday");
    expect(asOfAt(UNTIL, Date.parse("2026-10-25T08:00:00-04:00"), FX.tz).spoken).toBe("As of Oct 22");
  });
});

describe("the frozen measurement (synthetic, shaped like snapshot B)", () => {
  it("the transfer is snapshot B: 21 conversations through Oct 21, and the drill after the freeze is ignored", () => {
    const t = makeHub(UNTIL).transfer()!;
    expect(shape(t)).toEqual(FX.expected);
    expect(t.asOf).toEqual({ at: "2026-10-22T13:39:00.000Z", label: "Oct 22, 9:39 am", spoken: "As of this morning" });
  });

  it("unset is the hub as before: every conversation and drill, and no asOf anywhere", () => {
    const live = makeHub();
    const t = live.transfer()!;
    expect(t).not.toHaveProperty("asOf");
    expect(t.sources.conversation!.sessions).toBe(23);
    expect(t.habits.find((h) => h.habit === "hedges")!.firstDrillAt).toBe(Date.parse("2026-10-22T10:05:00-04:00"));
    expect(JSON.stringify(t)).toBe(JSON.stringify(makeHub(null).transfer()));
    // the same as the transfer computed straight from every session and drill
    expect(t.headline).toBe(transfer({ sessions: live.sessionsFor("bee"), selected: true, prereg: buildPrereg(), preregPath: "prereg/transfer.json", drills: live.drillEvents(), nowMs: NOW, tz: FX.tz }).headline);
    expect(live.stats({ kind: "week" })).not.toHaveProperty("asOf");
    expect(live.asOf()).toBeNull();
  });

  it("this week's stats count only the conversations that started by the freeze", () => {
    const frozen = makeHub(UNTIL).stats({ kind: "week" });
    const live = makeHub().stats({ kind: "week" });
    expect(frozen.asOf?.label).toBe("Oct 22, 9:39 am");
    expect(frozen.sessions.every((s) => s.date <= "2026-10-21")).toBe(true);
    expect(live.sessions.filter((s) => s.date === "2026-10-22")).toHaveLength(2);
    expect(live.habits.words - frozen.habits.words).toBe(600);
    // the next-session glance ignores the hedges drill made after the freeze
    expect(frozen.drilledVsNextSession.map((d) => d.habit)).not.toContain("hedges");
    expect(live.drilledVsNextSession.map((d) => d.habit)).toContain("hedges");
  });

  it("drills, the live baseline and wrist cues stay live; one conversation asked for by id is still found", () => {
    const frozen = makeHub(UNTIL);
    const live = makeHub();
    expect(frozen.drillEvents()).toHaveLength(1);
    expect(frozen.drillEvents({ live: true })).toEqual(live.drillEvents());
    expect(computeBaseline(frozen, { wpm: 140, synthetic: true })).toEqual(computeBaseline(live, { wpm: 140, synthetic: true }));
    expect(frozen.transfer("bee", { live: true })).toEqual(live.transfer());
    expect(frozen.stats({ kind: "session", id: "syn-23" }).sessions.map((s) => s.id)).toEqual(["syn-23"]);
    expect(frozen.deckSummary()).toEqual(live.deckSummary());
    // the goal fact Bee keeps (COACH_FACTS=1) outlives the film: it is never the frozen measurement
    expect(composeGoal(frozen)).toEqual(composeGoal(live));
  });
});

describe("over HTTP and Alexa (synthetic, frozen)", () => {
  let s: HubServer;
  const get = (p: string) => fetch(s.url + p).then((r) => r.json() as Promise<any>);
  beforeAll(async () => {
    const hub = makeHub(UNTIL);
    const setup: Setup = { hub, calendar: async () => ({ events: [], source: "none (test)" }), stream: null, demo: null, stateDir: null, pace: 1, describe: { mode: "test" }, stop: () => {} };
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  });
  afterAll(async () => s.close());

  it("every measurement route carries asOf; the transfer is snapshot B", async () => {
    const want = { at: "2026-10-22T13:39:00.000Z", label: "Oct 22, 9:39 am", spoken: "As of this morning" };
    const t = await get("/api/transfer");
    expect(t.asOf).toEqual(want);
    expect(t.sources.conversation).toMatchObject(FX.expected.sources.conversation);
    expect(t.claim).toBe("partly-started");
    for (const p of ["/api/stats?range=week", "/api/instrument", "/api/settings", "/api/coach/now"]) expect((await get(p)).asOf, p).toEqual(want);
    expect((await get("/api/coach/now")).transferHeadline).toBe(FX.expected.headline);
  });

  it("Alexa's answer says it is frozen", async () => {
    const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/did-it-transfer.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
    e.request.timestamp = new Date().toISOString();
    const deps: SkillDeps = { hub: new HubClient(s.url), now: () => 0, sleep: async () => {}, progressive: async () => true };
    const r = await handleAlexa(e, deps);
    expect(r.envelope.response.outputSpeech?.text).toBe('As of this morning, counting from your first practice: filler "like" since Oct 19; unsure words not practised yet');
  });
});

describe("the no-drop-yet headline", () => {
  it("says no clear change and why, in two sentences", () => {
    expect(NO_DROP_YET_HEADLINE).toBe("No clear change yet in the habits you practised. It takes a few more conversations.");
  });
});
