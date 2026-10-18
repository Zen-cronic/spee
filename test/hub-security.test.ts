// Regression tests for the 2026-10-16 review: C1 (wildcard CORS let any web page read and drive the
// hub), C2 (a cross-site WebSocket joined /ws and read PAIR_TOKEN from welcome.joinUrl), H2 (trust
// decided from client headers only), H4b/C3/C4 (a malformed upgrade, hello or frame killed the hub)
// and the bridge hardening around them.
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { addressKind, isPublicRequest, originPolicy } from "../src/hub/gate.js";
import { checkFrame } from "../src/hub/bridgeGuard.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw, wsOutcome } from "./helpers-http.js";

const PAIR = "pair-token-for-security-01";
const MCP = "mcp-token-for-security-001";
const EVIL = "https://evil.example";
let s: HubServer;

beforeAll(async () => {
  s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: "https://bee-coach.example.app", allowedOrigins: [] });
});
afterAll(async () => s.close());

const alive = async () => expect((await raw(s.port, "/api/health")).status).toBe(200);

// A raw WebSocket session: resolves with every frame received until `ms` passes or the socket closes.
function session(frames: (string | Buffer)[], o: { query?: string; headers?: Record<string, string>; ms?: number } = {}): Promise<{ opened: boolean; msgs: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws${o.query ?? ""}`, { headers: o.headers });
    const msgs: any[] = [];
    let opened = false;
    const done = () => (clearTimeout(t), ws.terminate(), resolve({ opened, msgs }));
    const t = setTimeout(done, o.ms ?? 400);
    ws.on("open", () => {
      opened = true;
      for (const f of frames) ws.send(f);
    });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    ws.on("error", () => undefined);
    ws.on("close", done);
  });
}

describe("C1: no wildcard CORS; a foreign Origin cannot read or drive the hub", () => {
  it("a foreign Origin gets 403 forbidden_origin on /api/*, SSE and state-changing routes, even from loopback", async () => {
    for (const [method, path] of [
      ["GET", "/api/attempts?limit=200"],
      ["GET", "/api/events"],
      ["GET", "/api/health"],
      ["POST", "/api/attempt"],
      ["POST", "/api/session/start"],
      ["POST", "/api/live/mode"],
      ["OPTIONS", "/api/attempt"],
      ["POST", "/mcp"],
      ["POST", "/alexa"],
    ] as const) {
      const r = await raw(s.port, path, { method, headers: { origin: EVIL, "content-type": "text/plain" }, body: method === "POST" ? '{"text":"x"}' : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(r.text).error, `${method} ${path}`).toBe("forbidden_origin");
      expect(r.headers["access-control-allow-origin"], `${method} ${path}`).toBeUndefined();
    }
    for (const o of ["null", "http://127.0.0.1.evil.example:8791", `http://127.0.0.1:${s.port + 1}`, "file://", "chrome-extension://abc"]) {
      expect((await raw(s.port, "/api/attempts", { headers: { origin: o } })).status, o).toBe(403);
    }
  });
  it("no response carries access-control-allow-origin: *", async () => {
    for (const p of ["/api/health", "/api/attempts", "/api/state", "/api/nope"]) {
      const r = await raw(s.port, p);
      expect(r.headers["access-control-allow-origin"], p).toBeUndefined();
    }
    const o = await raw(s.port, "/api/attempt", { method: "OPTIONS" });
    expect(o.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("allowed origins (the hub itself, the Vite dev servers, PUBLIC_BASE_URL) are echoed, with vary: origin", async () => {
    for (const o of [`http://127.0.0.1:${s.port}`, `http://localhost:${s.port}`, "http://localhost:5183", "http://127.0.0.1:5184", "http://localhost:5175", "https://bee-coach.example.app"]) {
      const r = await raw(s.port, "/api/health", { headers: { origin: o } });
      expect(r.status, o).toBe(200);
      expect(r.headers["access-control-allow-origin"], o).toBe(o);
      expect(String(r.headers.vary), o).toContain("origin");
    }
    // same origin as a LAN Host the page was loaded from
    expect((await raw(s.port, "/api/health", { headers: { host: "192.168.1.20:8791", origin: "http://192.168.1.20:8791" } })).status).toBe(200);
    expect((await raw(s.port, "/api/health", { headers: { host: "192.168.1.20:8791", origin: "http://192.168.1.21:8791" } })).status).toBe(403);
  });
  it("SSE from an allowed Origin streams; non-browser clients (no Origin) keep working", async () => {
    const r = await raw(s.port, "/api/health");
    expect(r.status).toBe(200);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.port}/api/events`, { headers: { origin: "http://localhost:5183" }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5183");
    ac.abort();
  });
  it("static page loads are not blocked by a foreign Origin (they hold no wearer data)", async () => {
    expect((await raw(s.port, "/p/", { headers: { origin: EVIL } })).status).not.toBe(403);
  });
  it("a foreign Origin with the MCP bearer token may call /mcp (it holds the secret)", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = await raw(s.port, "/mcp", { method: "POST", headers: { origin: EVIL, authorization: `Bearer ${MCP}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe(EVIL);
  });
});

describe("C2: /ws checks Origin; the pair token goes only to authenticated peers", () => {
  it("a cross-site WebSocket from loopback is refused and learns nothing", async () => {
    const r = await wsOutcome(s.port, "", { origin: EVIL });
    expect(r.result).toBe("rejected");
    expect(JSON.stringify(r.welcome ?? {})).not.toContain(PAIR);
    await alive();
  });
  it("a cross-site WebSocket that presents the pair token is accepted (it already holds it)", async () => {
    const r = await wsOutcome(s.port, `?k=${PAIR}`, { origin: EVIL });
    expect(r.result).toBe("welcome");
  });
  it("no Origin (the Vega app, Node clients) and allowed origins join and get joinUrl with ?k=", async () => {
    for (const headers of [{}, { origin: `http://127.0.0.1:${s.port}` }, { origin: "http://localhost:5183" }] as Record<string, string>[]) {
      const r = await wsOutcome(s.port, "", headers);
      expect(r.result, JSON.stringify(headers)).toBe("welcome");
      expect(r.welcome.joinUrl).toBe(`https://bee-coach.example.app/p/${r.welcome.code}?k=${PAIR}`);
    }
  });
  it("public /ws still needs ?k=, also with an allowed Origin", async () => {
    expect((await wsOutcome(s.port, "", { "x-forwarded-for": "203.0.113.7", origin: "https://bee-coach.example.app" })).result).toBe("rejected");
    expect((await wsOutcome(s.port, `?k=${PAIR}`, { "x-forwarded-for": "203.0.113.7", origin: "https://bee-coach.example.app" })).result).toBe("welcome");
  });
  it("an upgrade on another path is refused, and the hub survives", async () => {
    const r = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/other`);
      ws.on("open", () => (ws.terminate(), resolve("open")));
      ws.on("error", () => resolve("rejected"));
    });
    expect(r).toBe("rejected");
    await alive();
  });
});

describe("trust: decided from the socket address too (H2, H3)", () => {
  it("addressKind", () => {
    expect(addressKind("127.0.0.1")).toBe("loopback");
    expect(addressKind("::1")).toBe("loopback");
    expect(addressKind("::ffff:127.0.0.1")).toBe("loopback");
    expect(addressKind("192.168.1.5")).toBe("lan");
    expect(addressKind("::ffff:10.1.2.3")).toBe("lan");
    expect(addressKind("fd00::5")).toBe("lan");
    expect(addressKind("203.0.113.9")).toBe("public");
    expect(addressKind(undefined)).toBe("public");
  });
  it("a LAN socket is public unless LAN trust is on; a public socket is public even with Host: localhost", () => {
    const req = (addr: string | undefined) => ({ headers: { host: "localhost:8791" }, socket: { remoteAddress: addr } });
    expect(isPublicRequest(req("127.0.0.1"))).toBe(false);
    expect(isPublicRequest(req("192.168.1.50"))).toBe(true);
    expect(isPublicRequest(req("192.168.1.50"), { trustLan: true })).toBe(false);
    expect(isPublicRequest(req("203.0.113.9"), { trustLan: true })).toBe(true);
    expect(isPublicRequest(req(undefined))).toBe(true);
  });
  it("originPolicy refuses malformed and look-alike origins", () => {
    const p = originPolicy({ port: () => 8791, publicBaseUrl: "https://x.ngrok-free.app/", lanHosts: () => ["192.168.1.20"], extra: ["http://studio.local:3000"] });
    for (const o of ["http://127.0.0.1:8791", "http://localhost:5183", "http://192.168.1.20:5184", "https://x.ngrok-free.app", "http://studio.local:3000", "HTTP://LOCALHOST:8791"]) expect(p.allowed(o), o).toBe(true);
    for (const o of ["null", "", "https://x.ngrok-free.app.evil.example", "http://localhost:9999", "ftp://localhost:8791", "https://127.0.0.1:8791"]) expect(p.allowed(o), o).toBe(false);
  });
});

describe("bridge guard: malformed input never kills the hub (C3, C4, H4b, L21, M34, H23)", () => {
  it("a hello with a non-string code or clientId is refused with bad-message", async () => {
    const r = await session([JSON.stringify({ type: "hello", v: 1, role: "mic", clientId: "x", code: 1234 }), JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: 5 })]);
    expect(r.msgs.filter((m) => m.type === "error" && m.code === "bad-message")).toHaveLength(2);
    await alive();
  });
  it("hops of the wrong shape and oversized fields are refused", async () => {
    const r = await session([
      JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: "guard-1" }),
      JSON.stringify({ type: "transcript.final", text: "hi", utteranceId: "u1", hops: [null] }),
      JSON.stringify({ type: "app", topic: 7 }),
      JSON.stringify({ type: "ping", t0: "x" }),
      JSON.stringify({ type: "transcript.partial", text: "x".repeat(5000), utteranceId: "u2" }),
    ]);
    expect(r.msgs.find((m) => m.type === "welcome")).toBeTruthy();
    expect(r.msgs.filter((m) => m.type === "error" && m.code === "bad-message")).toHaveLength(4);
    await alive();
  });
  it("a second hello on one socket is refused (no ghost peer)", async () => {
    const r = await session([JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: "guard-2" }), JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: "guard-3" })]);
    expect(r.msgs.filter((m) => m.type === "welcome")).toHaveLength(1);
    expect(r.msgs.some((m) => m.type === "error" && /one hello/.test(m.message))).toBe(true);
  });
  it("invalid UTF-8 and binary frames close that socket only", async () => {
    const bad = await new Promise<string>((resolve) => {
      const sock = connect(s.port, "127.0.0.1", () => {
        sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      sock.on("data", (d) => {
        if (!upgraded && String(d).startsWith("HTTP/1.1 101")) {
          upgraded = true;
          const mask = Buffer.from([1, 2, 3, 4]);
          const payload = Buffer.from([0xff, 0xfe, 0xfd]).map((b, i) => b ^ mask[i % 4]!);
          sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload]));
        }
      });
      sock.on("close", () => resolve(upgraded ? "closed" : "refused"));
      sock.on("error", () => undefined);
      setTimeout(() => (sock.destroy(), resolve("timeout")), 2000);
    });
    expect(bad).toBe("closed");
    const bin = await session([Buffer.from([1, 2, 3])]);
    expect(bin.msgs.some((m) => m.type === "error" && /binary/.test(m.message))).toBe(true);
    await alive();
  });
  it("an unparseable upgrade target (//[) is refused, and the hub survives", async () => {
    const r = await new Promise<string>((resolve) => {
      const sock = connect(s.port, "127.0.0.1", () => {
        sock.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let got = "";
      sock.on("data", (d) => (got += String(d)));
      sock.on("close", () => resolve(got.split("\r\n")[0] ?? ""));
      sock.on("error", () => resolve("error"));
      setTimeout(() => (sock.destroy(), resolve("timeout")), 2000);
    });
    expect(r).not.toContain("101");
    await alive();
  });
  it("checkFrame: a screen's malformed code is dropped so it gets a fresh room; a clientId held by the other role is refused", () => {
    const c = checkFrame(JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: "tv", code: "AB0C" }), { helloed: false });
    expect(c.ok && c.rewritten && JSON.parse(c.rewritten).code).toBeUndefined();
    const rooms = new Map([["HJ3H", { code: "HJ3H", createdAt: 0, peers: new Map([["tv-1", { clientId: "tv-1", role: "screen" }]]) }]]) as never;
    expect(checkFrame(JSON.stringify({ type: "hello", v: 1, role: "mic", clientId: "tv-1", code: "hj3h" }), { helloed: false }, rooms)).toMatchObject({ ok: false });
    expect(checkFrame(JSON.stringify({ type: "hello", v: 1, role: "mic", clientId: "phone-1", code: "hj3h" }), { helloed: false }, rooms)).toMatchObject({ ok: true });
  });
});
