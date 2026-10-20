// The live plugin's HTTP routes on a real demo hub (pace 0.01): GET /api/live, POST
// /api/live/mode, GET /api/recaps[/<id>], GET /api/coach/now and POST /api/demo/live, with their
// errors. The demo story runs through the replayed Bee stream in about 3 s.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HubEvent } from "../src/hub/core.js";
import { PLANTED_OTHER_MARKER } from "../src/hub/live/demoScripts.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw } from "./helpers-http.js";

let s: HubServer;
const events: HubEvent[] = [];
const get = async (p: string) => {
  const r = await raw(s.port, p);
  return { status: r.status, body: JSON.parse(r.text), text: r.text };
};
const post = async (p: string, b: unknown) => {
  const r = await raw(s.port, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: JSON.parse(r.text), text: r.text };
};
const waitFor = async (pred: (e: HubEvent) => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = events.find(pred);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

beforeAll(async () => {
  s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
  s.setup.hub.on("event", (e: HubEvent) => events.push(e));
});
afterAll(async () => s.close());

describe("live routes (demo hub)", () => {
  it("health: the live plugin is ready, with its wrist and principles source", async () => {
    const h = (await get("/api/health")).body;
    expect(h.plugins.find((p: any) => p.name === "live")).toMatchObject({ owner: "packet A", status: "ready", note: expect.stringMatching(/^wrist: replay; principles: (template|local); recap phrasing: template$/) });
  });
  it("GET /api/live: off by default, the synthetic baseline, the replay wrist", async () => {
    const r = await get("/api/live");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ synthetic: true, mode: { enabled: false, reason: "default" }, conversation: null, drillActive: false, wrist: { channel: "replay", healthy: true }, lastNudge: null, recentNudges: [], recentSkips: [], lastRecapId: null });
    expect(r.body.baseline).toEqual({ source: "bee week (non-drill conversations; synthetic)", words: 1400, hedgesPer100: 1.43, likesPer100: 1.79, fillersPer100: 2.43, wpm: 140 });
  });
  it("POST /api/live/mode validates, answers with narration and publishes live.mode", async () => {
    for (const b of [{}, { enabled: "yes" }, { enabled: true, minutes: 0 }, { enabled: true, minutes: 181 }, { enabled: true, rules: { nope: true } }, { enabled: true, rules: { monologue: 1 } }]) expect((await post("/api/live/mode", b)).body.error, JSON.stringify(b)).toBe("bad_request");
    const on = await post("/api/live/mode", { enabled: true, minutes: 60, by: "alexa" });
    expect(on.status).toBe(200);
    expect(on.body.mode).toMatchObject({ enabled: true, by: "alexa", reason: "on" });
    expect(on.body.mode.expiresAt - on.body.mode.since).toBe(3_600_000);
    expect(on.body.narration).toBe("Live coaching is on for 60 minutes. I'll tap your wrist if a habit keeps coming up.");
    expect(events.at(-1)).toMatchObject({ topic: "live.mode", payload: { mode: { enabled: true } } });
  });
  it("POST /api/demo/live: bad script 400; story 202, then the events and the recap", async () => {
    expect((await post("/api/demo/live", { script: "nope" })).body).toMatchObject({ error: "bad_request" });
    const r = await post("/api/demo/live", { script: "story" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ replay: true, script: "story", pace: 0.01, conversationId: expect.stringMatching(/^demo-0000-4000-8000-\d{12}$/) });
    expect(r.body.steps.map((x: any) => x.what)).toEqual(expect.arrayContaining(["conversation.started", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready"]));
    const ready = await waitFor((e) => e.topic === "recap.ready");
    expect(ready).not.toBeNull();
    const recap = (ready!.payload as any).recap;
    const list = await get("/api/recaps?limit=1");
    expect(list.body).toMatchObject({ synthetic: true, recaps: [{ id: recap.id }] });
    expect((await get(`/api/recaps/${recap.id}`)).body).toEqual(recap);
    expect(await get("/api/recaps/rcp_nope")).toMatchObject({ status: 404, body: { error: "unknown_recap" } });
    const now = (await get("/api/coach/now")).body;
    expect(now).toMatchObject({ basis: "recap", lastRecap: { id: recap.id }, mode: { enabled: true }, drills: { dueNow: expect.any(Number) } });
    const live = (await get("/api/live")).body;
    expect(live).toMatchObject({ lastRecapId: recap.id, lastNudge: { rule: "hedge-streak" } });
    expect(live.recentSkips[0]).toMatchObject({ reason: "cooldown" });
    const all = JSON.stringify([events, list.body, now, live]);
    expect(all).not.toContain(PLANTED_OTHER_MARKER);
  });
  it("unknown paths under the prefixes fall through to not_found", async () => {
    expect((await get("/api/live/nope")).body.error).toBe("not_found");
  });
});

describe("live routes outside demo mode", () => {
  it("POST /api/demo/live answers 400 demo_only", async () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    const t = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: { ...setup, demo: null }, pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
    try {
      const r = await raw(t.port, "/api/demo/live", { method: "POST", body: "{}" });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text).error).toBe("demo_only");
    } finally {
      await t.close();
      setup.stop();
    }
  });
});
