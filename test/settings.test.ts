// Conversation settings (src/hub/settings.ts): the automatic tag, the wearer's correction over
// HTTP, the per-setting view, the recap's "usual for that setting", and the guarantee that the
// pre-registered transfer check does not move. Synthetic data only.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationDetail } from "../src/bee/schemas.js";
import { conversationLines } from "../src/real/corpus.js";
import { CoachHub } from "../src/hub/core.js";
import { buildPrereg, DEMO_TZ } from "../src/hub/demoData.js";
import type { Baseline } from "../src/hub/live/baseline.js";
import { composeRecap } from "../src/hub/live/recap.js";
import { DEFAULT_THRESHOLDS } from "../src/hub/live/principles.js";
import { windowThresholds } from "../src/hub/live/rules.js";
import { ConversationWindow } from "../src/hub/live/window.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { autoSetting, localClock, nextSetting, parseWorkHours, rewordRecapSetting, SettingsBook } from "../src/hub/settings.js";
import { demoSetup } from "../src/hub/setup.js";
import { mergeCorpus, type StatSession } from "../src/hub/stats.js";
import { raw } from "./helpers-http.js";

const TZ = "America/Toronto";
const at = (iso: string) => Date.parse(iso);
const o = { tz: TZ };

describe("automatic setting (deterministic, counts only)", () => {
  it("meeting: captions, a captions session that matches by time, or a calendar event", () => {
    expect(autoSetting({ kind: "meeting", startMs: at("2026-10-17T15:00:00-04:00") }, o)).toEqual({ setting: "meeting", source: "auto", confidence: "high", reasons: ["captions"] });
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-19T10:00:00-04:00"), speakers: 3, pairedWithCaptions: true }, o).reasons).toEqual(["paired-captions"]);
    const cal = [{ startsAt: at("2026-10-20T14:00:00-04:00") }];
    // starts 5 min before the event (10 min of slack), inside it, and after its assumed 30 min
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T13:55:00-04:00"), speakers: 1 }, { ...o, calendar: cal }).setting).toBe("meeting");
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T14:20:00-04:00"), speakers: 1 }, { ...o, calendar: cal }).reasons).toEqual(["calendar"]);
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T14:40:00-04:00"), speakers: 1 }, { ...o, calendar: cal }).setting).not.toBe("meeting");
    // an event's end, when the brief gives one, wins over the assumed 30 min
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T14:40:00-04:00"), speakers: 1 }, { ...o, calendar: [{ ...cal[0]!, endsAt: at("2026-10-20T15:00:00-04:00") }] }).setting).toBe("meeting");
    // a live conversation that started earlier but ran into the event
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T13:20:00-04:00"), endMs: at("2026-10-20T13:52:00-04:00"), speakers: 2 }, { ...o, calendar: cal }).setting).toBe("meeting");
  });

  it("work: a weekday in work hours with 2 to 4 speakers; casual otherwise, low confidence when unsure", () => {
    const tue10 = at("2026-10-20T10:00:00-04:00");
    expect(autoSetting({ kind: "conversation", startMs: tue10, speakers: 2 }, o)).toEqual({ setting: "work", source: "auto", confidence: "high", reasons: ["work-hours", "speakers"] });
    expect(autoSetting({ kind: "conversation", startMs: tue10, speakers: 4 }, o).setting).toBe("work");
    expect(autoSetting({ kind: "conversation", startMs: tue10, speakers: 1 }, o)).toEqual({ setting: "casual", source: "auto", confidence: "low", reasons: ["speakers-out-of-range"] });
    expect(autoSetting({ kind: "conversation", startMs: tue10, speakers: 6 }, o).confidence).toBe("low");
    expect(autoSetting({ kind: "conversation", startMs: tue10 }, o)).toEqual({ setting: "casual", source: "auto", confidence: "low", reasons: ["speakers-unknown"] });
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-17T10:00:00-04:00"), speakers: 3 }, o)).toEqual({ setting: "casual", source: "auto", confidence: "high", reasons: ["weekend"] });
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T18:00:00-04:00"), speakers: 3 }, o).reasons).toEqual(["outside-work-hours"]);
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T08:59:00-04:00"), speakers: 3 }, o).reasons).toEqual(["outside-work-hours"]);
    // the hub's time zone decides: 13:30 UTC is 09:30 in Toronto, 06:30 in Vancouver
    const utc = at("2026-10-20T13:30:00Z");
    expect(autoSetting({ kind: "conversation", startMs: utc, speakers: 2 }, { tz: TZ }).setting).toBe("work");
    expect(autoSetting({ kind: "conversation", startMs: utc, speakers: 2 }, { tz: "America/Vancouver" }).setting).toBe("casual");
  });

  it("work hours are configurable; a bad value keeps 09:00-18:00", () => {
    const wh = parseWorkHours("08:00-16:30");
    expect(wh).toMatchObject({ startMin: 480, endMin: 990 });
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T08:15:00-04:00"), speakers: 2 }, { tz: TZ, workHours: wh }).setting).toBe("work");
    expect(autoSetting({ kind: "conversation", startMs: at("2026-10-20T17:00:00-04:00"), speakers: 2 }, { tz: TZ, workHours: wh }).setting).toBe("casual");
    expect(parseWorkHours("nine to five")).toMatchObject({ startMin: 540, endMin: 1080 });
    expect(parseWorkHours("18:00-09:00")).toMatchObject({ startMin: 540, endMin: 1080 });
    expect(localClock(at("2026-10-18T23:59:00-04:00"), TZ)).toEqual({ day: 0, min: 23 * 60 + 59 });
    expect(nextSetting("meeting")).toBe("work");
    expect(nextSetting("casual")).toBe("meeting");
  });

  it("speaker counts come from the session's counts; other speakers' words are never kept", () => {
    const u = (id: number, speaker: string, text: string) => ({ id, realtime: false, start: id, end: id + 1, spoken_at: at("2026-10-20T10:00:00-04:00") + id * 1000, text, speaker, created_at: 0 });
    const c: ConversationDetail = {
      id: 77,
      start_time: at("2026-10-20T10:00:00-04:00"),
      end_time: null,
      device_type: "watch",
      summary: null,
      short_summary: null,
      state: "COMPLETED",
      created_at: 0,
      updated_at: 0,
      transcriptions: [{ id: 1, realtime: false, utterances: [u(1, "Ada", "The export is ready for review today."), u(2, "Unknown", "zebra orchid colleague words"), u(3, "Speaker 3", "zebra orchid other words"), u(4, "Ada", "We ship it on Friday.")] }],
      suggested_links: [],
      primary_location: null,
    };
    const { sessions, lines } = conversationLines([c], { labels: ["Ada"], method: "env", counts: {} });
    expect(sessions[0]!.speakers).toBe(3);
    expect(JSON.stringify({ sessions, lines })).not.toContain("zebra orchid");
    const byId = new Map<string, StatSession>();
    mergeCorpus(byId, { generatedAt: "", wearer: { labels: ["Ada"], method: "env", counts: {} }, sessions, lines });
    expect(byId.get("77")!.speakers).toBe(3);
    // an older file without the count: someone else was heard, so at least 2
    const old = new Map<string, StatSession>();
    mergeCorpus(old, { generatedAt: "", wearer: { labels: [], method: "none", counts: {} }, sessions: [{ ...sessions[0]!, speakers: undefined }], lines });
    expect(old.get("77")!.speakers).toBe(2);
  });
});

// A small synthetic hub: one work session either side of a drill, and short casual ones.
function smallHub() {
  const words = (n: number, hedge: number) => Array.from({ length: n }, (_, i) => ({ key: `u:x${n}${hedge}${i}`, text: i < hedge ? "I guess the export is ready for the team today." : "The export is ready for the team today and works.", dom: "en" as const, uncertain: false }));
  const s = (id: string, iso: string, n: number, hedge: number, speakers: number): StatSession => ({ id, kind: "conversation", startMs: at(iso), lines: words(n, hedge), speakers, synthetic: true });
  const sessions = [
    s("w1", "2026-10-13T10:00:00-04:00", 50, 10, 3), // work, before
    s("c1", "2026-10-17T20:00:00-04:00", 4, 1, 2), // casual, too little speech
    s("w2", "2026-10-19T10:00:00-04:00", 50, 2, 3), // work, after
  ];
  const now = at("2026-10-20T13:30:00-04:00");
  const prereg = buildPrereg();
  const hub = new CoachHub({ mode: "demo", clock: () => now, tz: DEMO_TZ, deck: { cards: [] }, deckPath: null, attemptsPath: null, sessions, prereg, preregPath: "test", wearer: { minScore: 0.5 } as never, attempts: [], dataLabel: "SYNTHETIC" });
  // drills at Oct 15: the cutover for both drilled habits
  hub.drillEvents = () => [{ at: at("2026-10-15T12:00:00-04:00"), habitKeys: ["hedges", "filler:like"] }];
  return hub;
}

describe("a recap re-worded after a setting change", () => {
  const habits = [
    { key: "hedges", label: "", count: 5, per100: 2.4, baselinePer100: 1.4, verdict: "worse" as const },
    { key: "filler:like", label: "", count: 0, per100: 0, baselinePer100: 0.8, verdict: "better" as const },
  ];
  const recap = {
    headline: "Unsure words ran high: 2.4 per 100 words against your usual 1.4 at work.",
    narration: 'That conversation ran about 12 minutes. You used 5 unsure words, 2.4 out of every 100 words you said against your usual 1.4 at work. Try it without the unsure words: "I am at work on the export until five, 1.4 at work."',
    moment: { text: "I guess I am at work on the export until five, 1.4 at work.", rephrase: "I am at work on the export until five, 1.4 at work." },
    setting: { setting: "meeting" as const, source: "you" as const, confidence: "high" as const, reasons: ["you" as const] },
    metrics: { baselineSetting: "work" as const, habits },
  };
  it("re-words only the comparison, never the wearer's quoted moment", () => {
    const out = rewordRecapSetting(recap);
    expect(out.headline).toBe("Unsure words ran high: 2.4 per 100 words against your usual 1.4 from work talk.");
    expect(out.narration).toContain("against your usual 1.4 from work talk.");
    expect(out.narration).toContain('"I am at work on the export until five, 1.4 at work."');
  });
  it("words that are not a usual of this recap stay as written; the same setting changes nothing", () => {
    const other = { ...recap, headline: "No filler \"like\" this time (usually 0.8 per 100 words at work). You were at work early.", narration: "Back at work: 2.0 at work." };
    const out = rewordRecapSetting(other);
    expect(out.headline).toBe("No filler \"like\" this time (usually 0.8 per 100 words from work talk). You were at work early.");
    expect(out.narration).toBe("Back at work: 2.0 at work.");
    expect(rewordRecapSetting({ ...recap, setting: { ...recap.setting, setting: "work" as const } })).toEqual({ ...recap, setting: { ...recap.setting, setting: "work" } });
  });
});

describe("per-setting view", () => {
  it("rates and before/after per setting, with 'too little speech' instead of a number", () => {
    const hub = smallHub();
    const r = new SettingsBook({ hub, stateDir: null }).report();
    expect(r.rates.map((x) => [x.setting, x.enough])).toEqual([
      ["work", true],
      ["casual", false],
    ]);
    expect(r.rates.find((x) => x.setting === "casual")!.per100).toEqual({ hedges: null, "filler:like": null, vague: null, restart: null });
    const hedges = r.practised.find((p) => p.habit === "hedges")!;
    const work = hedges.bySetting.find((b) => b.setting === "work")!;
    expect(work).toMatchObject({ enough: true, before: { sessions: 1, words: 500 }, after: { sessions: 1, words: 500 } });
    expect(work.deltaPer100).toBeCloseTo(work.after.per100 - work.before.per100, 5);
    expect(hedges.bySetting.find((b) => b.setting === "casual")).toMatchObject({ enough: false, deltaPer100: null });
    expect(r.line).toBe("By setting · Unsure words: work talk 2.0 → 0.4 · casual: too little speech");
  });

  it("hidden (null) when no setting has enough speech on both sides", () => {
    const hub = smallHub();
    hub.sessions = hub.sessions.filter((s) => s.id !== "w2");
    expect(new SettingsBook({ hub, stateDir: null }).report().line).toBeNull();
  });

  it("the wearer's choice wins, and is matched by time from a live conversation id to the stats session", () => {
    const hub = smallHub();
    const book = new SettingsBook({ hub, stateDir: null });
    expect(book.tagSession("w2")!.setting).toBe("work");
    // a recap's conversation (the stream's uuid) that is the stats session "w2" (Bee's id)
    book.set("uuid-of-w2", "meeting", { startMs: at("2026-10-19T09:59:30-04:00"), endMs: at("2026-10-19T10:20:00-04:00") });
    expect(book.tagSession("w2")).toEqual({ setting: "meeting", source: "you", confidence: "high", reasons: ["you"] });
    expect(book.tagSession("w1")!.setting).toBe("work");
    // set again under the stats id: replaces the uuid one; null clears it
    book.set("w2", "casual");
    expect(book.tagSession("w2")!.setting).toBe("casual");
    book.set("w2", null);
    expect(book.tagSession("w2")).toMatchObject({ setting: "work", source: "auto" });
  });

  it("a stats session is tagged with its end too, as its live recap is (calendar overlap)", () => {
    const hub = smallHub();
    // Bee joined desk talk and a calendar meeting into one conversation, 13:30-14:40; event 14:00-14:30
    const s0 = at("2026-10-20T13:30:00-04:00");
    const e0 = at("2026-10-20T14:40:00-04:00");
    hub.sessions = [...hub.sessions, { id: "j1", kind: "conversation", startMs: s0, endMs: e0, lines: [], speakers: 2, synthetic: true }];
    const book = new SettingsBook({ hub, stateDir: null });
    book.noteCalendar([{ startsAt: at("2026-10-20T14:00:00-04:00"), endsAt: at("2026-10-20T14:30:00-04:00") }]);
    const live = book.tagConversation({ conversationId: "uuid-j1", startedAt: s0, endedAt: e0, otherLines: 3 });
    expect(live.setting).toBe("meeting");
    expect(book.tagSession("j1")).toMatchObject({ setting: "meeting", reasons: ["calendar"] });
  });

  it("the pre-registered transfer is identical with and without settings data", () => {
    const hub = smallHub();
    const before = JSON.stringify(hub.transfer());
    const book = new SettingsBook({ hub, stateDir: null });
    book.set("w1", "casual");
    book.set("w2", "meeting");
    book.report();
    expect(JSON.stringify(hub.transfer())).toBe(before);
    // and with the speaker counts gone entirely
    hub.sessions = hub.sessions.map(({ speakers: _s, ...x }) => x);
    expect(JSON.stringify(hub.transfer())).toBe(before);
  });
});

describe("recap against the usual for its setting", () => {
  const T0 = Date.parse("2026-10-20T17:30:00Z");
  const BASE: Baseline = { source: "test", words: 1400, hedgesPer100: 1.43, likesPer100: 1.79, fillersPer100: 2.43, wpm: 140, vaguePer100: 0.64, restartsPer100: 0.86 };
  const conv = () => {
    const w = new ConversationWindow("c", T0, true);
    let t = 0;
    let id = 1;
    for (const s of ["I guess we could maybe ship the export on Friday.", "I think the retry logic is kind of ready for the team.", "Probably the alerting is the last piece, and I think it is small.", "The search page loads in two seconds on the staging server.", "We moved the release of the mobile build to Friday afternoon.", "The billing export finished on Monday and the totals match."]) {
      const d = (s.split(" ").length / 140) * 60;
      w.upsert({ utteranceId: id++, conversationUuid: "c", speaker: "wearer", text: s, words: s.split(" ").length, spokenAt: T0 + t * 1000, durMs: d * 1000, startS: t, endS: t + d, receivedAt: T0 + (t + d) * 1000 + 5400, resolvedAt: T0 + (t + d) * 1000 + 5900, score: 0.8, drill: false });
      t += d + 1;
    }
    return w;
  };
  const input = (o: { usualWhere?: string } = {}) => {
    const w = conv();
    return { id: "rcp_t", win: w, a: w.analyze(T0 + 400_000, windowThresholds(DEFAULT_THRESHOLDS), BASE), baseline: BASE, endedAt: T0 + 120_000, createdAt: T0 + 121_000, pace: 1, dataLabel: "SYNTHETIC", synthetic: true, delivery: { wrist: "replay" as const, todoId: null }, ...o };
  };

  it("says 'in meetings' after the usual; the numbers and their slots are unchanged", () => {
    const plain = composeRecap(input());
    const met = composeRecap(input({ usualWhere: "in meetings" }));
    expect(plain.recap.headline).toMatch(/against your usual 1\.4\./);
    expect(met.recap.headline).toMatch(/^Unsure words ran high: \d\.\d per 100 words against your usual 1\.4 in meetings\./);
    expect(met.recap.narration).toContain("against your usual 1.4 in meetings");
    expect(met.slots.values).toEqual(plain.slots.values);
    expect(met.slots.template.headline).toContain("{hedges_usual} in meetings");
    expect(met.recap.wristText).toBe(plain.recap.wristText);
  });
});

describe("over HTTP (demo hub, synthetic)", () => {
  let s: HubServer;
  let dir: string;
  const get = async (p: string) => {
    const r = await raw(s.port, p);
    return { status: r.status, body: JSON.parse(r.text) };
  };
  const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
    const r = await raw(s.port, p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    return { status: r.status, body: JSON.parse(r.text) };
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "settings-"));
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: dir }), pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
  });
  afterAll(async () => s.close());

  it("GET /api/settings: work talk and casual in the synthetic week, and one plain line", async () => {
    const r = await get("/api/settings");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ synthetic: true, source: "bee", minWords: 400, workHours: { start: "09:00", end: "18:00", days: "Mon-Fri", tz: "America/Toronto" } });
    const tags = Object.fromEntries(r.body.sessions.map((x: any) => [x.id, x.tag.setting]));
    // demo-bee-1013 has synthetic meeting captions too (demo-meet-1013), so it is a meeting
    expect(tags).toMatchObject({ "demo-bee-1010": "casual", "demo-bee-1013": "meeting", "demo-bee-1014": "work", "demo-bee-1017": "casual", "demo-bee-1020": "work" });
    expect(r.body.rates.map((x: any) => x.setting)).toEqual(["meeting", "work", "casual"]);
    expect(r.body.line).toMatch(/^By setting · Unsure words: meeting: too little speech · work talk \d\.\d → \d\.\d · casual \d\.\d → \d\.\d$/);
    expect((await get("/api/settings?source=all")).body.sessions.find((x: any) => x.id === "demo-meet-1014").tag).toMatchObject({ setting: "meeting", reasons: ["captions"] });
    expect((await get("/api/settings?source=bad")).status).toBe(400);
  });

  it("POST /api/sessions/<id>/setting: the wearer's choice wins, is saved, and leaves the transfer as it was", async () => {
    const t0 = (await get("/api/transfer")).body;
    const r = await post("/api/sessions/demo-bee-1017/setting", { setting: "meeting" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "demo-bee-1017", tag: { setting: "meeting", source: "you", confidence: "high", reasons: ["you"] }, recapIds: [] });
    const after = (await get("/api/settings")).body;
    expect(after.sessions.find((x: any) => x.id === "demo-bee-1017").tag.source).toBe("you");
    expect(after.rates.map((x: any) => x.setting)).toEqual(["meeting", "work", "casual"]);
    const file = join(dir, "live", "settings.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).overrides["demo-bee-1017"]).toMatchObject({ setting: "meeting" });
    const t1 = (await get("/api/transfer")).body;
    expect(t1.headline).toBe(t0.headline);
    expect(t1.claim).toBe(t0.claim);
    expect(t1.habits).toEqual(t0.habits);
    expect(t1.firstSignal).toEqual(t0.firstSignal);
    // back to automatic
    expect((await post("/api/sessions/demo-bee-1017/setting", { setting: null })).body.tag).toMatchObject({ setting: "casual", source: "auto" });
  });

  it("refuses a bad setting, an unknown id, and a request from outside (gate)", async () => {
    expect((await post("/api/sessions/demo-bee-1017/setting", { setting: "party" })).status).toBe(400);
    expect((await post("/api/sessions/demo-bee-1017/setting", {})).status).toBe(400);
    expect((await post("/api/sessions/nope/setting", { setting: "work" })).status).toBe(404);
    expect((await post("/api/sessions/demo-bee-1017/setting", { setting: "work" }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
    expect((await post("/api/sessions/demo-bee-1017/setting", { setting: "work" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("a recap carries its setting; correcting it by the recap's conversation id shows on the recap", async () => {
    await post("/api/live/mode", { enabled: true, minutes: 60, by: "test" });
    await post("/api/demo/live", { script: "story" });
    let recap: any = null;
    for (let i = 0; i < 400 && !recap; i++) {
      await new Promise((r) => setTimeout(r, 25));
      recap = (await get("/api/recaps?limit=1")).body.recaps[0] ?? null;
    }
    expect(recap).not.toBeNull();
    // Tuesday 13:30 in the synthetic story, with a colleague: work talk, compared with work talk
    expect(recap.setting).toMatchObject({ setting: "work", source: "auto" });
    expect(recap.metrics.baselineSetting).toBe("work");
    expect(recap.headline).toMatch(/at work\./);
    const r = await post(`/api/sessions/${recap.conversationId}/setting`, { setting: "casual" });
    expect(r.body).toMatchObject({ id: recap.conversationId, tag: { setting: "casual", source: "you" }, recapIds: [recap.id] });
    const served = (await get(`/api/recaps/${recap.id}`)).body;
    expect(served.setting).toMatchObject({ setting: "casual", source: "you" });
    // its usual is still work talk's: said as where it came from, not as this conversation's setting
    expect(served.headline).not.toMatch(/at work/);
    expect(served.headline).toMatch(/from work talk\./);
    expect(served.narration).not.toMatch(/at work/);
    const now = (await get("/api/coach/now")).body;
    expect(now.lastRecap.setting).toBe("casual");
    expect(now.narration).not.toMatch(/at work/);
    expect(now.narration).toMatch(/a casual chat/);
    expect(now.narration).toMatch(/from work talk/);
    // set back to work talk: worded as first written
    await post(`/api/sessions/${recap.conversationId}/setting`, { setting: "work" });
    expect((await get(`/api/recaps/${recap.id}`)).body.headline).toBe(recap.headline);
  });
});
