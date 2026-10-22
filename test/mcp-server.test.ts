// The MCP server at /mcp (packet C) over real HTTP against an in-process demo hub in fixture mode:
// initialize, tools/list = MCP_TOOLS, every tool calls exactly its contract route and returns
// narration + structuredContent, errors come back as isError, and the gate/CORS behaviour.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOLS, type McpToolName } from "../src/hub/contract.js";
import { matchRoute } from "../src/hub/plugin.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { HubClient } from "../src/mcp/hubClient.js";
import { createMcpPlugin } from "../src/mcp/plugin.js";
import { summaryText } from "../src/mcp/tools.js";
import { raw } from "./helpers-http.js";

const MCP = "mcp-token-for-tests-00001";
let s: HubServer;
const hits: string[] = []; // "METHOD /path?query" the MCP tools sent to the hub
let client: Client;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  const recording: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    hits.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    return fetch(input, init);
  };
  let base = "";
  const plugins = createPlugins().map((p) => (p.name === "mcp" ? createMcpPlugin({ hub: new HubClient(() => base, { fetch: recording }) }) : p));
  s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.02, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: MCP, publicBaseUrl: null });
  base = s.url;
  client = new Client({ name: "mcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
});
afterAll(async () => {
  await client.close();
  await s.close();
});

type Res = { content: { type: string; text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
async function call(name: McpToolName, args: Record<string, unknown> = {}): Promise<{ r: Res; hit: string[] }> {
  const n = hits.length;
  const r = (await client.callTool({ name, arguments: args })) as unknown as Res;
  return { r, hit: hits.slice(n) };
}
// The route a hit matches, in MCP_TOOLS notation ("GET /api/attempts/<id>", "GET /api/recaps?limit=1").
const asRoute = (hit: string, pattern: string) => {
  const [m, pq] = hit.split(" ") as [string, string];
  const [path, query] = pq.split("?") as [string, string | undefined];
  const [pm, ppq] = pattern.split(" ") as [string, string];
  const [ppath, pquery] = ppq.split("?") as [string, string | undefined];
  return !!matchRoute(`${pm} ${ppath}`, m, path) && (!pquery || query === pquery);
};

describe("MCP over Streamable HTTP (stateless)", () => {
  it("initialize: server info, instructions, tools capability", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "bee-speech-coach", version: "contract-v2" });
    expect(client.getInstructions()).toMatch(/two turns/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });
  it("tools/list is MCP_TOOLS, in order, with input schemas", async () => {
    const t = await client.listTools();
    expect(t.tools.map((x) => x.name)).toEqual(MCP_TOOLS.map((x) => x.name));
    const byName = Object.fromEntries(t.tools.map((x) => [x.name, x]));
    expect(byName.submit_attempt!.inputSchema.required).toEqual(["text"]);
    expect(byName.get_verdict!.inputSchema.required).toEqual(["attempt_id"]);
    expect(byName.live_coach!.inputSchema.required).toEqual(["enabled"]);
    expect(Object.keys(byName.habit_stats!.inputSchema.properties ?? {})).toEqual(["range", "source"]);
  });

  it("every tool calls exactly its contract route and returns narration + structuredContent", async () => {
    const route = (n: McpToolName) => MCP_TOOLS.find((t) => t.name === n)!.route;
    const expectHit = (n: McpToolName, hit: string[]) => {
      expect(hit, n).toHaveLength(1);
      expect(asRoute(hit[0]!, route(n)), `${n}: ${hit[0]} vs ${route(n)}`).toBe(true);
    };
    const seen = new Set<McpToolName>();
    const run = async (n: McpToolName, args: Record<string, unknown> = {}) => {
      const out = await call(n, args);
      expectHit(n, out.hit);
      expect(out.r.isError, `${n}: ${out.r.content[0]?.text}`).toBeFalsy();
      expect(out.r.content[0]?.type).toBe("text");
      expect(out.r.content[0]!.text.length, n).toBeGreaterThan(0);
      expect(out.r.structuredContent, n).toBeTypeOf("object");
      seen.add(n);
      return out.r;
    };

    const start = await run("start_drill", { size: 3 });
    expect(start.structuredContent!.session.by).toBe("mcp"); // never "alexa": the skill ends only its own sessions
    expect(start.content[0]!.text).toBe(`Say this: "${start.structuredContent!.card.resay}"`);
    const status = await run("drill_status");
    expect(status.structuredContent!.state).toBe("card_open");
    await fetch(`${s.url}/api/demo/scenario`, { method: "POST", body: JSON.stringify({ scenario: "verified" }) });
    const sub = await run("submit_attempt", { text: start.structuredContent!.card.resay });
    expect(sub.structuredContent!.attempt).toMatchObject({ status: "pending_bee", provisional: { source: "mcp" } });
    expect(sub.content[0]!.text).toMatch(/checking with Bee/);
    const id = sub.structuredContent!.attempt.id as string;
    const early = await run("get_verdict", { attempt_id: id });
    expect(early.structuredContent!.verdictReady).toBe(false);
    let v = early;
    for (let i = 0; i < 100 && !v.structuredContent!.verdictReady; i++) {
      await sleep(30);
      v = (await call("get_verdict", { attempt_id: id })).r;
    }
    expect(v.structuredContent).toMatchObject({ status: "graded", verdictReady: true, attempt: { counted: true, final: { source: "bee", pass: true } } });
    expect(v.content[0]!.text).toBe("Nice, Bee heard it. That's a pass.");
    const next = await run("next_card");
    expect(next.structuredContent!.done).toBe(false);
    const end = await run("end_drill");
    // the second line was opened and never said: each line once, as the TV's Round over counts it
    expect(end.content[0]!.text).toBe("Practice done: 1 of 2 lines passed, checked by Bee (1 not tried).");
    const how = await run("how_am_i_doing");
    expect(how.structuredContent!.basis).toBe("recap");
    expect(how.content[0]!.text).toBe(how.structuredContent!.narration);
    const stats = await run("habit_stats", { range: "week", source: "bee" });
    expect(stats.content[0]!.text).toMatch(/^This week, over \d+ words: unsure words [\d.]+/);
    const tr = await run("did_it_transfer");
    expect(tr.content[0]!.text).toBe(tr.structuredContent!.headline);
    const one = await run("did_it_transfer", { habit: "hedges" });
    expect(one.content[0]!.text).toMatch(/^Unsure words \(practised\): dropped, /);
    const brief = await run("pre_meeting_brief");
    expect(brief.content[0]!.text).toBe(brief.structuredContent!.nudge);
    const on = await run("live_coach", { enabled: true, minutes: 30 });
    expect(on.structuredContent!.mode.enabled).toBe(true);
    expect(hits.at(-1)).toBe("POST /api/live/mode");
    await run("live_coach", { enabled: false });
    const recap = await run("last_recap");
    expect(recap.content[0]!.text).toBe(recap.structuredContent!.recaps[0].narration);
    expect([...seen].sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });

  it("a route answering >= 400 comes back as isError with the route's error body", async () => {
    const bad = await call("get_verdict", { attempt_id: "att_nope" });
    expect(bad.r.isError).toBe(true);
    expect(bad.r.structuredContent).toMatchObject({ error: "unknown_attempt" });
    expect(bad.r.content[0]!.text).toMatch(/unknown_attempt/);
    await fetch(`${s.url}/api/session/end`, { method: "POST" });
    const noCard = await call("submit_attempt", { text: "hello there" });
    expect(noCard.r).toMatchObject({ isError: true, structuredContent: { error: "no_open_card" } });
    expect((await call("habit_stats", { range: "decade" })).r).toMatchObject({ isError: true, structuredContent: { error: "bad_range" } });
    expect((await call("did_it_transfer", { habit: "vague" })).r).toMatchObject({ isError: true, structuredContent: { error: "not_preregistered" } });
  });
  it("invalid arguments are rejected by the input schema before any hub call", async () => {
    const n = hits.length;
    const r = (await client.callTool({ name: "get_verdict", arguments: {} })) as unknown as Res;
    expect(r.isError).toBe(true);
    const l = (await client.callTool({ name: "live_coach", arguments: { enabled: true, minutes: 999 } })) as unknown as Res;
    expect(l.isError).toBe(true);
    expect(hits.length).toBe(n);
  });
});

describe("start_drill adopts a card that is already open", () => {
  it("the card the TV opened stays the drill's first card (not replaced by the next due one)", async () => {
    await call("end_drill");
    const opened = await (await fetch(`${s.url}/api/card/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "demo:filler-like", by: "tv" }) })).json();
    expect(opened.card.id).toBe("demo:filler-like");
    const { r } = await call("start_drill");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ card: { id: "demo:filler-like" }, session: { cardIds: ["demo:filler-like"] } });
    expect(r.content[0]!.text).toContain(opened.card.resay);
    await call("end_drill");
  });
});

describe("/mcp HTTP behaviour", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  it("GET and DELETE are 405; OPTIONS is 204 with CORS exposing mcp-session-id", async () => {
    expect((await raw(s.port, "/mcp")).status).toBe(405);
    expect((await raw(s.port, "/mcp", { method: "DELETE" })).status).toBe(405);
    const o = await raw(s.port, "/mcp", { method: "OPTIONS", headers: { origin: "http://localhost:5175" } });
    expect(o.status).toBe(204);
    expect(o.headers["access-control-allow-origin"]).toBe("http://localhost:5175");
    expect(String(o.headers["access-control-expose-headers"])).toContain("mcp-session-id");
    expect(String(o.headers["access-control-allow-headers"])).toContain("authorization");
  });
  it("POST answers JSON with CORS and no session id (stateless)", async () => {
    const r = await raw(s.port, "/mcp", { method: "POST", headers: h, body });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined(); // no Origin: a non-browser client
    const same = await raw(s.port, "/mcp", { method: "POST", headers: { ...h, origin: `http://127.0.0.1:${s.port}` }, body });
    expect(same.status).toBe(200);
    expect(same.headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${s.port}`);
    const foreign = await raw(s.port, "/mcp", { method: "POST", headers: { ...h, origin: "https://evil.example" }, body });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text).error).toBe("forbidden_origin");
    // a browser client on another origin that holds MCP_TOKEN: the preflight (no Authorization) passes
    // and echoes its Origin; the request itself needs the bearer
    const pre = await raw(s.port, "/mcp", { method: "OPTIONS", headers: { origin: "https://assistant.example", "access-control-request-headers": "authorization, content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://assistant.example");
    const withBearer = await raw(s.port, "/mcp", { method: "POST", headers: { ...h, origin: "https://assistant.example", authorization: `Bearer ${MCP}` }, body });
    expect(withBearer.status).toBe(200);
    expect(withBearer.headers["access-control-allow-origin"]).toBe("https://assistant.example");
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(r.text).result.tools).toHaveLength(MCP_TOOLS.length);
  });
  it("through a tunnel it needs Authorization: Bearer $MCP_TOKEN", async () => {
    const pub = { ...h, "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" };
    expect((await raw(s.port, "/mcp", { method: "POST", headers: pub, body })).status).toBe(403);
    expect((await raw(s.port, "/mcp", { method: "POST", headers: { ...pub, authorization: "Bearer nope" }, body })).status).toBe(403);
    const ok = await raw(s.port, "/mcp", { method: "POST", headers: { ...pub, authorization: `Bearer ${MCP}` }, body });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(MCP);
    expect((await raw(s.port, "/mcp", { method: "OPTIONS", headers: pub })).status).toBe(204);
  });
  it("an SDK client with the bearer header works through the tunnel path", async () => {
    const c = new Client({ name: "tunnel", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${MCP}`, "x-forwarded-for": "203.0.113.9", "ngrok-skip-browser-warning": "1" } } }));
    const r = (await c.callTool({ name: "how_am_i_doing", arguments: {} })) as unknown as Res;
    expect(r.isError).toBeFalsy();
    await c.close();
  });
  it("health reports the mcp plugin ready", async () => {
    const hh = JSON.parse((await raw(s.port, "/api/health")).text);
    expect(hh.plugins.find((p: any) => p.name === "mcp")).toMatchObject({ owner: "MCP server", status: "ready", routes: ["POST /mcp", "GET /mcp", "DELETE /mcp"] });
  });
});

describe("the round's narration (summaryText)", () => {
  // line A missed, then passed on a retry; line B missed: three tries, two lines
  const round = { sessionId: "ses_1", by: "mcp", startedAt: 0, endedAt: 1, cards: 2, attempts: 3, counted: 3, passed: 1, failed: 2, unverified: 0, pending: 0, beeOverrules: 0, perCard: [] };
  it("counts each line once, as the TV's Round over does", () => {
    expect(summaryText({ ...round, lines: { passed: 1, failed: 1, unverified: 0, pending: 0, untried: 0 } })).toBe("Practice done: 1 of 2 lines passed, checked by Bee (1 not yet).");
    expect(summaryText({ ...round, lines: { passed: 2, failed: 0, unverified: 0, pending: 0, untried: 0 } })).toBe("Practice done: 2 of 2 lines passed, checked by Bee.");
  });
  it("an older hub sends no `lines`: it narrates the tries and says they are tries, never throws", () => {
    expect(summaryText(round)).toBe("Practice done: 1 of 2 lines passed, checked by Bee (3 tries: 1 passed, 2 not yet).");
    expect(summaryText({ ...round, cards: 1, attempts: 3, counted: 1, failed: 0, unverified: 1, pending: 1 })).toBe("Practice done: 1 of 1 line passed, checked by Bee (3 tries: 1 passed, 1 Bee didn't catch, 1 still with Bee).");
    expect(summaryText(null)).toBe("You're not practising right now.");
  });
  it("a round with no line Bee checked never says checked by Bee, and says Bee is still checking a line still with Bee (review L186)", () => {
    const none = { ...round, cards: 1, attempts: 0, counted: 0, passed: 0, failed: 0 };
    expect(summaryText({ ...none, lines: { passed: 0, failed: 0, unverified: 0, pending: 0, untried: 1 } })).toBe("Practice done: Bee didn't check any line this round (1 not tried).");
    const uncaught = { ...none, attempts: 1, unverified: 1 };
    expect(summaryText({ ...uncaught, lines: { passed: 0, failed: 0, unverified: 1, pending: 0, untried: 0 } })).toBe("Practice done: Bee didn't check any line this round (1 Bee didn't catch).");
    expect(summaryText({ ...uncaught, cards: 2, attempts: 2, pending: 1, lines: { passed: 0, failed: 0, unverified: 1, pending: 1, untried: 0 } })).toBe("Practice done: Bee is still checking 1 line (1 Bee didn't catch).");
    expect(summaryText({ ...none, attempts: 2, pending: 2, cards: 2, lines: { passed: 0, failed: 0, unverified: 0, pending: 2, untried: 0 } })).toBe("Practice done: Bee is still checking 2 lines.");
    expect(summaryText(uncaught)).toBe("Practice done: Bee didn't check any line this round (1 try: 0 passed, 1 Bee didn't catch)."); // an older hub
    expect(summaryText({ ...none, attempts: 1, pending: 1 })).toBe("Practice done: Bee is still checking 1 try."); // an older hub, still with Bee: each count once (review L198)
  });
});
