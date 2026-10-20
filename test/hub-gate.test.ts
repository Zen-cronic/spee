// The public-access gate (src/hub/gate.ts): a tunnel must expose only /alexa, the static phone and
// simulator pages, /mcp with the bearer token and /ws with the pair token.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { WS_PROTOCOL } from "../src/hub/contract.js";
import { bearerOk, hostIsLocal, isPublicRequest, mustAuthenticate, protocolToken, resolveTokens, tokenEquals, tunnelWarning } from "../src/hub/gate.js";
import { wsProtocols } from "../web/phone/src/take.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw, wsOutcome } from "./helpers-http.js";

const PAIR = "pair-token-for-tests-0001";
const MCP = "mcp-token-for-tests-00001";
const NGROK = { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" };
const PUBLIC = "abc123.ngrok-free.app";
let s: HubServer;

beforeAll(async () => {
  s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: null });
});
afterAll(async () => s.close());

describe("gate: what counts as public", () => {
  it("loopback and LAN hosts are local; tunnel hosts and missing hosts are not", () => {
    for (const h of ["localhost:8791", "127.0.0.1:8791", "[::1]:8791", "192.168.1.20:8791", "10.0.0.5", "172.20.1.1:8791", "mybox.local", "169.254.3.4", "[fd12::1]:8791"]) expect(hostIsLocal(h), h).toBe(true);
    for (const h of [PUBLIC, "example.com", "8.8.8.8:8791", "172.32.0.1", "100.64.0.1", "", undefined]) expect(hostIsLocal(h), String(h)).toBe(false);
  });
  it("an x-forwarded-for from ngrok makes a loopback-Host request public", () => {
    expect(isPublicRequest({ headers: { host: "127.0.0.1:8791" } })).toBe(false);
    expect(isPublicRequest({ headers: { host: "127.0.0.1:8791", ...NGROK } })).toBe(true);
    expect(isPublicRequest({ headers: { host: "localhost:8791", forwarded: "for=203.0.113.7" } })).toBe(true);
    expect(isPublicRequest({ headers: { host: PUBLIC } })).toBe(true);
  });
  it("tokens: compared in constant time; bearer parsing", () => {
    expect(tokenEquals(PAIR, PAIR)).toBe(true);
    expect(tokenEquals("nope", PAIR)).toBe(false);
    expect(tokenEquals("", PAIR)).toBe(false);
    expect(tokenEquals(null, PAIR)).toBe(false);
    expect(bearerOk(`Bearer ${MCP}`, MCP)).toBe(true);
    expect(bearerOk(`bearer ${MCP}`, MCP)).toBe(true);
    expect(bearerOk(MCP, MCP)).toBe(false);
    expect(bearerOk(undefined, MCP)).toBe(false);
  });
  it("unset tokens are generated; the pair token is printed once, the MCP token only by its last 4; set ones are never printed", () => {
    const lines: string[] = [];
    const t = resolveTokens({}, (l) => lines.push(l));
    expect(t.source).toEqual({ pair: "generated", mcp: "generated" });
    expect(t.pairToken.length).toBeGreaterThanOrEqual(20);
    expect(lines.filter((l) => l.includes(t.pairToken))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(t.mcpToken);
    expect(lines.filter((l) => l.includes(`MCP_TOKEN is unset; generated: …${t.mcpToken.slice(-4)}`))).toHaveLength(1);
    const kept: string[] = [];
    const k = resolveTokens({ PAIR_TOKEN: PAIR, MCP_TOKEN: MCP }, (l) => kept.push(l));
    expect(k).toMatchObject({ pairToken: PAIR, mcpToken: MCP, source: { pair: "env", mcp: "env" } });
    expect(kept.join("\n")).not.toContain(PAIR);
  });
  it("a generated token is saved (0600) and reused on the next start, so paired phones survive a restart (review M40)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-tokens-"));
    const path = join(dir, "state", "tokens.json");
    try {
      const first = resolveTokens({}, () => {}, path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const second = resolveTokens({}, () => {}, path);
      expect(second).toEqual(first);
      // an exported token still wins, and does not overwrite the saved one
      const env = resolveTokens({ PAIR_TOKEN: PAIR }, () => {}, path);
      expect(env.pairToken).toBe(PAIR);
      expect(env.mcpToken).toBe(first.mcpToken);
      expect(JSON.parse(readFileSync(path, "utf8")).PAIR_TOKEN).toBe(first.pairToken);
      // reuse prints only the last 4 characters (review L54)
      const lines: string[] = [];
      resolveTokens({}, (l) => lines.push(l), path);
      expect(lines.join("\n")).not.toContain(first.pairToken);
      expect(lines.join("\n")).toContain(`…${first.pairToken.slice(-4)}`);
      // a broken file never locks phones out: the last good copy is used (review L56)
      writeFileSync(path, "{nope");
      expect(resolveTokens({}, () => {}, path).pairToken).toBe(first.pairToken);
      expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
      // --rotate-tokens makes new ones and saves them, and deletes every old copy (.bak, .corrupt-*)
      expect(readdirSync(join(dir, "state")).some((f) => f.includes(".corrupt-"))).toBe(true);
      const rotated = resolveTokens({}, () => {}, path, { rotate: true });
      expect(rotated.pairToken).not.toBe(first.pairToken);
      expect(readdirSync(join(dir, "state"))).toEqual(["tokens.json"]);
      expect(resolveTokens({}, () => {}, path).pairToken).toBe(rotated.pairToken);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // a damaged file after the rotation never brings a leaked token back
      writeFileSync(path, "{nope");
      const after = resolveTokens({}, () => {}, path);
      expect([after.pairToken, after.mcpToken]).not.toContain(first.pairToken);
      expect(after.pairToken).toBe(rotated.pairToken); // the backup taken since the rotation
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate: the hub server", () => {
  it("LAN requests reach /api/*", async () => {
    expect((await raw(s.port, "/api/health", { headers: { host: `127.0.0.1:${s.port}` } })).status).toBe(200);
    expect((await raw(s.port, "/api/stats", { headers: { host: `192.168.1.20:${s.port}` } })).status).toBe(200);
  });
  it("a public /api/* request is blocked with 403 forbidden", async () => {
    for (const [p, h] of [
      ["/api/health", { ...NGROK, host: `127.0.0.1:${s.port}` }],
      ["/api/stats", { host: PUBLIC }],
      ["/api/events/recent", { ...NGROK, host: PUBLIC }],
      ["/api/events", { ...NGROK, host: PUBLIC }],
      ["/api/live", { ...NGROK, host: PUBLIC }],
      ["/tv/", { ...NGROK, host: PUBLIC }],
    ] as [string, Record<string, string>][]) {
      const r = await raw(s.port, p, { headers: h });
      expect(r.status, p).toBe(403);
      expect(JSON.parse(r.text).error).toBe("forbidden");
    }
    expect((await raw(s.port, "/p/../api/health", { headers: { ...NGROK, host: PUBLIC } })).status).toBe(403);
  });
  it("public POST /alexa and GET /p/, /sim/ pass the gate", async () => {
    const a = await raw(s.port, "/alexa", { method: "POST", headers: { ...NGROK, host: PUBLIC, "content-type": "application/json" }, body: "{}" });
    expect(a.status).not.toBe(403);
    expect((await raw(s.port, "/alexa", { headers: { ...NGROK, host: PUBLIC } })).status).toBe(403);
    expect((await raw(s.port, "/p/HJ3H?k=x", { headers: { ...NGROK, host: PUBLIC } })).status).not.toBe(403);
    expect((await raw(s.port, "/sim/", { headers: { ...NGROK, host: PUBLIC } })).status).not.toBe(403);
  });
  it("public /mcp needs Authorization: Bearer $MCP_TOKEN (preflight excepted)", async () => {
    const h = { ...NGROK, host: PUBLIC, "content-type": "application/json" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await raw(s.port, "/mcp", { method: "POST", headers: h, body })).status).toBe(403);
    expect((await raw(s.port, "/mcp", { method: "POST", headers: { ...h, authorization: "Bearer wrong" }, body })).status).toBe(403);
    expect((await raw(s.port, "/mcp", { method: "POST", headers: { ...h, authorization: `Bearer ${MCP}` }, body })).status).not.toBe(403);
    expect((await raw(s.port, "/mcp", { method: "OPTIONS", headers: h })).status).not.toBe(403);
    expect((await raw(s.port, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body })).status).not.toBe(403); // LAN
  });
  it("public /ws needs k=$PAIR_TOKEN; LAN /ws does not", async () => {
    expect((await wsOutcome(s.port, "", NGROK)).result).toBe("rejected");
    expect((await wsOutcome(s.port, "?k=wrong", NGROK)).result).toBe("rejected");
    expect((await wsOutcome(s.port, "", { host: PUBLIC })).result).toBe("rejected");
    expect((await wsOutcome(s.port, `?k=${PAIR}`, NGROK)).result).toBe("welcome");
    // the phone page's form: the token as a subprotocol, out of the URL; the hub never echoes it
    const sub = (k: string) =>
      new Promise<{ result: string; protocol: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, wsProtocols(k), { headers: NGROK });
        const done = (result: string) => (ws.terminate(), resolve({ result, protocol: ws.protocol }));
        ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: `t-${Math.random()}` })));
        ws.on("message", (d) => JSON.parse(String(d)).type === "welcome" && done("welcome"));
        ws.on("unexpected-response", () => done("rejected"));
        ws.on("error", () => done("rejected"));
      });
    expect(await sub(PAIR)).toEqual({ result: "welcome", protocol: WS_PROTOCOL });
    // Whatever order a client offers them in, or the token alone: the response never carries the token.
    const tokenProto = wsProtocols(PAIR)![1]!;
    const answered = (offered: string[]) =>
      new Promise<string | undefined>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, offered, { headers: NGROK });
        ws.on("upgrade", (res) => resolve(res.headers["sec-websocket-protocol"] as string | undefined));
        ws.on("error", () => undefined);
        ws.on("close", () => resolve("closed before upgrade"));
        setTimeout(() => ws.terminate(), 500);
      });
    expect(await answered([tokenProto, WS_PROTOCOL])).toBe(WS_PROTOCOL);
    expect(await answered([tokenProto])).toBeUndefined();
    expect((await sub("wrong-token-wrong")).result).toBe("rejected");
    expect(protocolToken(wsProtocols("tök en/+=")!.join(", "))).toBe("tök en/+=");
    const lan = await wsOutcome(s.port, "");
    expect(lan.result).toBe("welcome");
    expect(lan.welcome.joinUrl).toMatch(new RegExp(`/p/${lan.welcome.code}#k=${PAIR}$`));
    expect((await raw(s.port, "/api/health")).status).toBe(200); // the server survives refused upgrades
  });
  it("never puts a token in a response", async () => {
    for (const p of ["/api/health", "/api/live", "/api/state", "/api/nope"]) {
      const r = await raw(s.port, p);
      expect(r.text, p).not.toContain(PAIR);
      expect(r.text, p).not.toContain(MCP);
    }
    const h = JSON.parse((await raw(s.port, "/api/health")).text);
    expect(h.gate).toEqual({ publicRoutes: expect.any(Array), pairToken: "env", mcpToken: "env" });
  });
});

describe("joinUrl", () => {
  it("uses PUBLIC_BASE_URL when set and appends #k=<PAIR_TOKEN>", async () => {
    const t = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: "https://bee-coach.example.app/" });
    try {
      const w = await wsOutcome(t.port, "");
      expect(w.welcome.joinUrl).toBe(`https://bee-coach.example.app/p/${w.welcome.code}#k=${PAIR}`);
    } finally {
      await t.close();
    }
  });
});

describe("a declared tunnel (review H2)", () => {
  it("makes /mcp and /alexa authenticate loopback requests too, since a TCP tunnel looks like loopback", async () => {
    const local = { headers: { host: "localhost:8791" }, socket: { remoteAddress: "127.0.0.1" } };
    expect(isPublicRequest(local)).toBe(false);
    expect(mustAuthenticate(local)).toBe(false);
    expect(mustAuthenticate(local, { tunnel: true })).toBe(true);
    const t = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: "https://bee-coach.example.app/" });
    try {
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      const hdr = { host: `localhost:${t.port}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
      expect((await raw(t.port, "/mcp", { method: "POST", headers: hdr, body: init })).status).toBe(403);
      expect((await raw(t.port, "/mcp", { method: "POST", headers: { ...hdr, authorization: `Bearer ${MCP}` }, body: init })).status).toBe(200);
      // the rest of the loopback surface is unchanged (the TV on this machine holds no token)
      expect((await raw(t.port, "/api/health", { headers: { host: `localhost:${t.port}` } })).status).toBe(200);
    } finally {
      await t.close();
    }
  });
  it("warns at startup that only an HTTP tunnel is supported", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      const t = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: "https://bee-coach.example.app" });
      await t.close();
      const warn = lines.find((l) => l.startsWith("hub: warning: PUBLIC_BASE_URL"));
      expect(warn).toContain(`ngrok http ${t.port}`);
      expect(warn).toMatch(/TCP tunnel \(ngrok tcp, ssh -R/);
      expect(lines.join("\n")).not.toContain(PAIR);
    } finally {
      spy.mockRestore();
    }
    expect(tunnelWarning("https://x.example", 8791)).toContain("ngrok http 8791");
  });
});
