// The mirror plugin (src/hub/mirror.ts) on an in-process demo hub: practice.meters reach the
// mic's room's screens only (never SSE, /api/events/recent, a mic or another room), frames are
// rebuilt from the contract fields, practice.summary and mirror.focus are sequenced with
// hub-stamped fields, and POST /api/demo/mirror plays a synthetic take metered by the phone's
// prosody engine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createMirrorPlugin, demoTake, sanitizeMeters } from "../src/hub/mirror.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { loadFixtureV2 } from "../src/hub/fixtureV2.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fx = loadFixtureV2();
const FRAME = fx["practice-meters.json"].frames[3] as Record<string, unknown>;
const SUMMARY = (fx["events-practice.json"].events as any[])[1].payload.summary as Record<string, unknown>;

function client(port: number, role: "screen" | "mic", clientId: string, code?: string, name?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [];
  const welcome = new Promise<any>((resolve) =>
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      frames.push(m);
      if (m.type === "welcome") resolve(m);
    }),
  );
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role, clientId, ...(code ? { code } : {}), ...(name ? { name } : {}) })));
  const app = (topic: string, payload: unknown, utteranceId?: string) => ws.send(JSON.stringify({ type: "app", topic, payload, ...(utteranceId ? { utteranceId, hops: [] } : {}) }));
  const got = (topic: string) => frames.filter((f) => f.type === "app" && f.topic === topic);
  const intent = (utteranceId: string) => frames.find((f) => f.type === "intent" && f.utteranceId === utteranceId);
  return { ws, frames, welcome, app, got, intent };
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
const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await sleep(20);
  return pred();
};

describe("mirror plugin on a demo hub", () => {
  let s: HubServer;
  let feed: ReturnType<typeof sse>;
  let tv: ReturnType<typeof client>;
  let phone: ReturnType<typeof client>;
  let otherTv: ReturnType<typeof client>;
  let code: string;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  beforeAll(async () => {
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), plugins: [createMirrorPlugin({ demoTakeMs: 1500 })], pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
    feed = sse(`${s.url}/api/events`);
    tv = client(s.port, "screen", "tv-mirror", undefined, "tv");
    code = (await tv.welcome).code;
    phone = client(s.port, "mic", "phone-1", code);
    await phone.welcome;
    otherTv = client(s.port, "screen", "tv-other");
    await otherTv.welcome;
    await sleep(100);
  });
  afterAll(async () => {
    feed.stop();
    for (const c of [tv, phone, otherTv]) c.ws.close();
    await s.close();
  });

  it("relays a mic's meters to its room's screens only, rebuilt from the contract fields", async () => {
    for (let i = 0; i < 10; i++) {
      phone.app("practice.meters", { ...FRAME, takeId: "take_t1", frame: i, injected: "not a contract field" });
      await sleep(100);
    }
    expect(await until(() => tv.got("practice.meters").length === 10)).toBe(true);
    const m = tv.got("practice.meters");
    expect(m.map((f) => f.payload.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(m[0].payload.from).toBe("phone-1");
    expect(m[0].payload.seq).toBeUndefined();
    expect(m[0].payload.injected).toBeUndefined();
    expect(m[0].payload.caption).toBe("So the export");
    expect(otherTv.got("practice.meters")).toHaveLength(0);
    expect(phone.got("practice.meters")).toHaveLength(0);
    expect(feed.events.some((e) => e.topic === "practice.meters")).toBe(false);
    const recent = await (await fetch(`${s.url}/api/events/recent`)).text();
    expect(recent).not.toContain("take_t1");
    expect(recent).not.toContain("practice.meters");
  });
  it("drops malformed frames and frames from a screen; a burst is held to <= 20 Hz per room", async () => {
    const before = tv.got("practice.meters").length;
    phone.app("practice.meters", { ...FRAME, takeId: "take_bad", rmsDbfs: "loud" });
    phone.app("practice.meters", { ...FRAME, takeId: "../../etc" });
    tv.app("practice.meters", { ...FRAME, takeId: "take_from_tv" });
    await sleep(200);
    expect(tv.got("practice.meters").length).toBe(before);
    for (let i = 0; i < 20; i++) phone.app("practice.meters", { ...FRAME, takeId: "take_burst", frame: i });
    await sleep(300);
    const burst = tv.got("practice.meters").filter((f) => f.payload.takeId === "take_burst").length;
    expect(burst).toBeGreaterThanOrEqual(1);
    expect(burst).toBeLessThan(5);
  });
  it("sanitizeMeters caps the caption and rejects a bad band", () => {
    const long = sanitizeMeters({ ...FRAME, caption: "x".repeat(500) }, "phone-1");
    expect(long?.caption?.length).toBe(200);
    expect(sanitizeMeters({ ...FRAME, band: "huge" }, "phone-1")).toBeNull();
    expect(sanitizeMeters({ ...FRAME, caption: "   " }, "phone-1")?.caption).toBeNull();
  });
  it("publishes a mic's practice.summary (sequenced) with the hub's room and from, and answers the intent", async () => {
    phone.app("practice.summary", { ...SUMMARY, takeId: "take_t1", room: "ZZZZ", from: "spoofed", provisional: false, flags: ["fast", "made-up"] }, "u_sum");
    expect(await until(() => feed.events.some((e) => e.topic === "practice.summary" && e.data.summary.takeId === "take_t1"))).toBe(true);
    const ev = feed.events.find((e) => e.topic === "practice.summary" && e.data.summary.takeId === "take_t1")!;
    expect(ev.data.seq).toBeGreaterThan(0);
    expect(ev.data.summary).toMatchObject({ room: code, from: "phone-1", provisional: true, flags: ["fast"], words: 89 });
    expect(await until(() => !!phone.intent("u_sum"))).toBe(true);
    expect(phone.intent("u_sum")).toMatchObject({ name: "practice.summary", ok: true, payload: { takeId: "take_t1", seq: ev.data.seq } });
    expect(await until(() => tv.got("practice.summary").length === 1)).toBe(true);
    tv.app("practice.summary", { ...SUMMARY, takeId: "take_tv" }, "u_tv_sum");
    phone.app("practice.summary", { takeId: "take_x" }, "u_bad_sum");
    expect(await until(() => !!tv.intent("u_tv_sum") && !!phone.intent("u_bad_sum"))).toBe(true);
    expect(tv.intent("u_tv_sum")).toMatchObject({ ok: false, payload: { error: "mic_only" } });
    expect(phone.intent("u_bad_sum")).toMatchObject({ ok: false, payload: { error: "bad_request" } });
    expect(feed.events.filter((e) => e.topic === "practice.summary")).toHaveLength(1);
  });
  it("publishes mirror.focus from any peer with by = its name; refuses an unknown view", async () => {
    tv.app("mirror.focus", { view: "transfer", reason: "show the transfer" }, "u_focus");
    phone.app("mirror.focus", { view: "nope" }, "u_focus_bad");
    expect(await until(() => feed.events.some((e) => e.topic === "mirror.focus" && e.data.view === "transfer"))).toBe(true);
    const f = feed.events.find((e) => e.topic === "mirror.focus" && e.data.view === "transfer")!;
    expect(f.data).toMatchObject({ view: "transfer", by: "tv", reason: "show the transfer", recapId: null, takeId: null, room: null });
    expect(await until(() => !!phone.intent("u_focus_bad"))).toBe(true);
    expect(phone.intent("u_focus_bad")).toMatchObject({ ok: false });
    // a phone's focus names its room, so another room's TV does not switch
    phone.app("mirror.focus", { view: "practice", reason: "practice take started", takeId: "take_focus" }, "u_focus_phone");
    expect(await until(() => feed.events.some((e) => e.topic === "mirror.focus" && e.data.takeId === "take_focus"))).toBe(true);
    expect(feed.events.find((e) => e.topic === "mirror.focus" && e.data.takeId === "take_focus")!.data).toMatchObject({ by: "phone-1", room: code });
  });
  it("POST /api/demo/mirror plays a metered synthetic take to the room, then the summary", async () => {
    const r = await post("/api/demo/mirror", { room: code.toLowerCase() });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ replay: true, script: "practice-take", frames: 15, hz: 10, durationMs: 1500, rooms: 1 });
    const takeId = r.body.takeId;
    expect(await until(() => feed.events.some((e) => e.topic === "practice.summary" && e.data.summary.takeId === takeId), 5000)).toBe(true);
    const meters = tv.got("practice.meters").filter((f) => f.payload.takeId === takeId);
    expect(meters).toHaveLength(15);
    expect(meters.every((m) => m.payload.from === "demo-phone")).toBe(true);
    expect(meters.filter((m) => m.payload.voiced).every((m) => m.payload.pitchHz >= 70 && m.payload.pitchHz <= 400)).toBe(true);
    expect(otherTv.got("practice.meters").some((f) => f.payload.takeId === takeId)).toBe(false);
    const mine = feed.events.filter((e) => (e.topic === "mirror.focus" || e.topic === "practice.summary") && (e.data.takeId === takeId || e.data.summary?.takeId === takeId));
    expect(mine.map((e) => e.topic)).toEqual(["mirror.focus", "practice.summary"]);
    expect(mine[1]!.data.summary).toMatchObject({ frames: 15, provisional: true, from: "demo-phone" });
    expect(feed.events.some((e) => e.topic === "practice.meters")).toBe(false);
  });
  it("POST /api/demo/mirror {script:'focus'} publishes mirror.focus; bad requests get 400", async () => {
    const r = await post("/api/demo/mirror", { script: "focus", view: "week" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ script: "focus", frames: 0, takeId: null });
    expect(await until(() => feed.events.some((e) => e.topic === "mirror.focus" && e.data.view === "week" && e.data.by === "demo"))).toBe(true);
    expect((await post("/api/demo/mirror", { script: "nope" })).body.error).toBe("bad_request");
    expect((await post("/api/demo/mirror", { script: "focus", view: "nope" })).status).toBe(400);
    // review L1: an unknown room is 404, not a 202 that publishes a summary to every peer
    expect(await post("/api/demo/mirror", { room: "QQQQ" })).toMatchObject({ status: 404, body: { error: "unknown_room" } });
  });
  it("health reports the mirror plugin ready", async () => {
    const h = await (await fetch(`${s.url}/api/health`)).json();
    expect(h.plugins.find((p: any) => p.name === "mirror")).toMatchObject({ owner: "practice mirror", status: "ready", routes: ["POST /api/demo/mirror"] });
  });
});

describe("mirror plugin outside demo mode", () => {
  it("POST /api/demo/mirror answers 400 demo_only", async () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    const s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: { ...setup, demo: null }, plugins: [createMirrorPlugin()], pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
    const r = await fetch(`${s.url}/api/demo/mirror`, { method: "POST", body: "{}" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("demo_only");
    await s.close();
  });
  it("the demo take is deterministic and plausible", () => {
    const a = demoTake(6000);
    const b = demoTake(6000);
    expect(a).toEqual(b);
    expect(a.frames).toHaveLength(60);
    expect(a.summary.pauses.count).toBe(2);
    expect(a.summary.pitch.monotone).toBe(false);
    expect(a.summary.rate.wpm).toBeGreaterThan(120);
  });
});
