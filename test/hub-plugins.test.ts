// Plugins (src/hub/plugin.ts, plugins.ts): the fixed registry, stubs, routing order, onApp fall-
// through, room-scoped broadcast, the publish guard, the live.window throttle and fixture mode.
import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CONTRACT_VERSION, LIVE_WINDOW_MIN_INTERVAL_MS, SEQUENCED_TOPICS } from "../src/hub/contract.js";
import { liveWindows } from "./helpers-contract.js";
import { matchRoute, underPrefix, type HubPlugin, type PluginCtx } from "../src/hub/plugin.js";
import { createPlugins, PLUGIN_MODULES, PLUGIN_NAMES } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import type { HubEvent } from "../src/hub/core.js";
import { raw } from "./helpers-http.js";
import { FIXTURE_V2_FILES } from "../src/hub/fixtureV2.js";
import { contractV2Fixtures } from "../src/hub/contractExamples.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function client(port: number, role: "screen" | "mic", clientId: string, code?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [];
  const welcome = new Promise<any>((resolve) =>
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      frames.push(m);
      if (m.type === "welcome") resolve(m);
    }),
  );
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role, clientId, ...(code ? { code } : {}) })));
  return { ws, frames, welcome };
}
function sse(url: string) {
  const events: { topic: string; data: any }[] = [];
  const ac = new AbortController();
  void (async () => {
    try {
      const r = await fetch(url, { signal: ac.signal });
      let buf = "";
      for await (const chunk of r.body as any) {
        buf += new TextDecoder().decode(chunk);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const f = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const topic = /^event: (.+)$/m.exec(f)?.[1];
          const data = /^data: (.+)$/m.exec(f)?.[1];
          if (topic && data) events.push({ topic, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, stop: () => ac.abort() };
}

describe("registry", () => {
  it("has the five plugins in order, each from its module file, with disjoint prefixes", () => {
    const ps = createPlugins();
    expect(ps.map((p) => p.name)).toEqual(["live", "mirror", "static", "alexa", "mcp"]);
    expect(PLUGIN_NAMES).toEqual(["live", "mirror", "static", "alexa", "mcp"]);
    for (const n of PLUGIN_NAMES) expect(existsSync(PLUGIN_MODULES[n].file), PLUGIN_MODULES[n].file).toBe(true);
    const all = ps.flatMap((p) => p.prefixes.map((x) => ({ p: p.name, x })));
    for (const a of all) for (const b of all) if (a !== b) expect(underPrefix(a.x, b.x) && a.p !== b.p, `${a.p} ${a.x} vs ${b.p} ${b.x}`).toBe(false);
  });
  it("no plugin prefix shadows a v1 core route", () => {
    const core = ["/api/health", "/api/state", "/api/session", "/api/deck", "/api/deck/next", "/api/card/open", "/api/attempt", "/api/attempts", "/api/attempts/att_1", "/api/session/start", "/api/session/next", "/api/session/end", "/api/stats", "/api/transfer", "/api/brief", "/api/events", "/api/events/recent", "/api/demo/scenario", "/api/demo/bee", "/ws"];
    for (const p of createPlugins()) for (const x of p.prefixes) for (const c of core) expect(underPrefix(c, x), `${p.name} ${x} shadows ${c}`).toBe(false);
  });
  it("matchRoute and underPrefix", () => {
    expect(matchRoute("GET /api/recaps/<id>", "GET", "/api/recaps/rcp_demo_0001")).toEqual({ id: "rcp_demo_0001" });
    expect(matchRoute("GET /api/recaps/<id>", "POST", "/api/recaps/x")).toBeNull();
    expect(matchRoute("GET /api/recaps", "GET", "/api/recaps/x")).toBeNull();
    expect(underPrefix("/api/live/mode", "/api/live")).toBe(true);
    expect(underPrefix("/api/lively", "/api/live")).toBe(false);
    expect(underPrefix("/tv", "/tv/")).toBe(true);
  });
});

describe("hub server with the stub plugins", () => {
  let s: HubServer;
  let ctx: PluginCtx | null = null;
  const probe: HubPlugin = {
    name: "probe",
    prefixes: ["/api/probe"],
    attach: (c) => void (ctx = c),
    route: async (req, res, url, c) => {
      if (req.method === "OPTIONS") return res.writeHead(204, { "x-probe": "preflight" }), res.end(), true;
      if (url.pathname === "/api/probe/throw") throw new Error("boom");
      if (url.pathname === "/api/probe/pass") return false;
      return c.json(res, 200, { probe: true }), true;
    },
    onApp: (_room, msg) => (msg.topic === "probe.ping" ? { name: "probe.pong", ok: true, payload: { got: msg.payload } } : undefined),
  };
  beforeAll(async () => {
    s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), plugins: [...createPlugins(), probe], pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
  });
  afterAll(async () => s.close());

  it("health: contract v2 and every plugin's status, never a token", async () => {
    const r = await raw(s.port, "/api/health");
    const h = JSON.parse(r.text);
    expect(h.contractVersion).toBe(CONTRACT_VERSION);
    expect(h.contractVersion).toBe(2);
    expect(h.plugins.map((p: any) => p.name)).toEqual(["live", "mirror", "static", "alexa", "mcp", "probe"]);
    expect(h.plugins.find((p: any) => p.name === "live")).toMatchObject({ owner: "packet A", status: "stub", routes: expect.arrayContaining(["GET /api/coach/now"]) });
    expect(h.plugins.find((p: any) => p.name === "static")).toMatchObject({ owner: "lead", status: "ready" });
    expect(h.fixtureV2).toBe(false);
    expect(r.text).not.toContain("p".repeat(20));
    expect(r.text).not.toContain("m".repeat(20));
  });
  it("every planned v2 route answers 501 not_implemented from its owner's stub", async () => {
    const want: [string, string, string][] = [
      ["GET", "/api/live", "live"],
      ["POST", "/api/live/mode", "live"],
      ["GET", "/api/recaps", "live"],
      ["GET", "/api/recaps/rcp_x", "live"],
      ["GET", "/api/coach/now", "live"],
      ["POST", "/api/demo/live", "live"],
      ["POST", "/api/demo/mirror", "mirror"],
      ["POST", "/alexa", "alexa"],
      ["POST", "/mcp", "mcp"],
      ["GET", "/mcp", "mcp"],
      ["DELETE", "/mcp", "mcp"],
    ];
    for (const [m, p, owner] of want) {
      const r = await raw(s.port, p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect(r.status, `${m} ${p}`).toBe(501);
      expect(JSON.parse(r.text)).toMatchObject({ error: "not_implemented", plugin: owner });
    }
    expect(JSON.parse((await raw(s.port, "/api/live/nope")).text).error).toBe("not_found"); // a stub falls through off its routes
  });
  it("plugins route before the core and get OPTIONS for their prefixes; errors are 500 plugin_error", async () => {
    expect(JSON.parse((await raw(s.port, "/api/probe")).text)).toEqual({ probe: true });
    expect((await raw(s.port, "/api/probe", { method: "OPTIONS" })).headers["x-probe"]).toBe("preflight");
    const generic = await raw(s.port, "/api/stats", { method: "OPTIONS" });
    expect(generic.status).toBe(204);
    expect(String(generic.headers["access-control-allow-headers"])).toContain("authorization");
    expect(JSON.parse((await raw(s.port, "/api/probe/throw")).text).error).toBe("plugin_error");
    expect(JSON.parse((await raw(s.port, "/api/probe/pass")).text).error).toBe("not_found");
  });
  it("bridge app topics the core does not handle fall through to the plugins' onApp", async () => {
    const tv = client(s.port, "screen", "tv-1");
    const w = await tv.welcome;
    tv.ws.send(JSON.stringify({ type: "app", topic: "probe.ping", utteranceId: "u1", payload: { n: 1 } }));
    tv.ws.send(JSON.stringify({ type: "app", topic: "practice.meters", utteranceId: "u2", payload: { frame: 0 } }));
    await sleep(150);
    expect(tv.frames.find((f) => f.type === "intent" && f.utteranceId === "u1")).toMatchObject({ name: "probe.pong", ok: true, payload: { got: { n: 1 } } });
    expect(tv.frames.some((f) => f.type === "intent" && f.utteranceId === "u2")).toBe(false); // the mirror stub ignores meters
    expect(w.code).toMatch(/^[A-Z0-9]{4}$/);
    tv.ws.close();
  });
  it("publish refuses room topics and unknown topics", () => {
    expect(() => s.setup.hub.publish("practice.meters" as any, {})).toThrow(/room-scoped/);
    expect(() => s.setup.hub.publish("made.up" as any, {})).toThrow(/not a contract topic/);
    expect(SEQUENCED_TOPICS).not.toContain("practice.meters");
  });
  it("broadcastToScreens reaches one room's screens only: never a mic, another room, SSE or recent", async () => {
    const feed = sse(`${s.url}/api/events`);
    const tvA = client(s.port, "screen", "tv-a");
    const codeA = (await tvA.welcome).code;
    const phoneA = client(s.port, "mic", "phone-a", codeA);
    await phoneA.welcome;
    const tvB = client(s.port, "screen", "tv-b");
    await tvB.welcome;
    await sleep(100);
    const sent = ctx!.broadcastToScreens(codeA, "practice.meters", { takeId: "take_room_test", frame: 1 });
    expect(sent).toBe(1);
    expect(ctx!.broadcastToScreens(codeA, "practice.meters", { takeId: "take_room_test", frame: 2 })).toBe(0); // <= 20 Hz per room
    await sleep(150);
    const got = (c: { frames: any[] }) => c.frames.filter((f) => f.type === "app" && f.topic === "practice.meters");
    expect(got(tvA)).toHaveLength(1);
    expect(got(tvA)[0].payload).toEqual({ takeId: "take_room_test", frame: 1 });
    expect(got(phoneA)).toHaveLength(0);
    expect(got(tvB)).toHaveLength(0);
    expect(feed.events.some((e) => e.topic === "practice.meters")).toBe(false);
    expect(JSON.stringify(s.setup.hub.recent)).not.toContain("take_room_test");
    expect(() => ctx!.broadcastToScreens(codeA, "live.window" as any, {})).toThrow();
    feed.stop();
    for (const c of [tvA, phoneA, tvB]) c.ws.close();
  });
});

describe("live.window throttle (core helper)", () => {
  afterEach(() => vi.useRealTimers());
  it("publishes at most one live.window per 3 s per conversation, holding the newest", () => {
    vi.useFakeTimers();
    const setup = demoSetup({ pace: 1, stateDir: null });
    const hub = setup.hub;
    const got: HubEvent[] = [];
    hub.on("event", (e: HubEvent) => e.topic === "live.window" && got.push(e));
    const [w1, w2, w3, w4] = liveWindows("conv-a", 4);
    const other = liveWindows("conv-b", 1)[0]!;
    expect(hub.publishLiveWindow(w1!)).toBe("sent");
    vi.advanceTimersByTime(1000);
    expect(hub.publishLiveWindow(w2!)).toBe("held");
    expect(hub.publishLiveWindow(other)).toBe("sent"); // another conversation is independent
    vi.advanceTimersByTime(1000);
    expect(hub.publishLiveWindow(w3!)).toBe("held"); // replaces w2
    vi.advanceTimersByTime(999);
    expect(got).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(got.map((e) => (e.payload.window as { updatedAt: number }).updatedAt)).toEqual([w1!.updatedAt, other.updatedAt, w3!.updatedAt]);
    expect(hub.publishLiveWindow(w4!)).toBe("held");
    hub.cancelLiveWindow("conv-a");
    vi.advanceTimersByTime(10_000);
    expect(got).toHaveLength(3); // the held w4 was dropped
    const convA = got.filter((e) => (e.payload.window as { conversationId: string }).conversationId === "conv-a").map((e) => e.payload.at);
    for (let i = 1; i < convA.length; i++) expect(convA[i]! - convA[i - 1]!).toBeGreaterThanOrEqual(LIVE_WINDOW_MIN_INTERVAL_MS);
    hub.dispose();
    setup.stop();
  });
});

describe("fixture mode (--demo --fixture-v2)", () => {
  let s: HubServer;
  const fx = (f: string) => JSON.parse(readFileSync(`fixtures/contract-v2/${f}`, "utf8"));
  beforeAll(async () => {
    s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.001, stateDir: null }), fixtureV2: true, pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
  });
  afterAll(async () => s.close());
  it("serves every fixture file the examples define", () => {
    expect([...FIXTURE_V2_FILES].sort()).toEqual(Object.keys(contractV2Fixtures()).sort());
  });
  it("needs demo mode", async () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    await expect(startHubServer({ port: 0, quiet: true, setup: { ...setup, demo: null }, fixtureV2: true })).rejects.toThrow(/--demo/);
    setup.stop();
  });
  it("answers the live routes from fixtures/contract-v2/", async () => {
    const j = async (p: string) => JSON.parse((await raw(s.port, p)).text);
    expect(await j("/api/live")).toEqual(fx("live.json"));
    expect(await j("/api/coach/now")).toEqual(fx("coach-now.json"));
    expect(await j("/api/recaps")).toEqual(fx("recaps.json"));
    expect(await j(`/api/recaps/${fx("recap.json").id}`)).toEqual(fx("recap.json"));
    expect((await raw(s.port, "/api/recaps/rcp_nope")).status).toBe(404);
    const off = await raw(s.port, "/api/live/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(JSON.parse(off.text)).toEqual(fx("live-mode-off.json"));
    expect((await raw(s.port, "/api/live/mode", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await j("/api/health")).fixtureV2).toBe(true);
  });
  it("POST /api/demo/live replays the fixture events in order", async () => {
    const before = s.setup.hub.recent.length;
    const r = await raw(s.port, "/api/demo/live", { method: "POST", body: "{}" });
    expect(r.status).toBe(202);
    const want = fx("events-live.json").events.map((e: any) => e.topic);
    for (let i = 0; i < 100 && s.setup.hub.recent.length - before < want.length; i++) await sleep(20);
    expect(s.setup.hub.recent.slice(before).map((e) => e.topic)).toEqual(want);
  });
});
