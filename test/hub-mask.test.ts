// On-screen masking of private terms (src/hub/mask.ts), with SYNTHETIC terms only ("Acme",
// "Jordan Lee", "export"): masked in every output path (HTTP JSON, SSE, the bridge WebSocket, the
// home page, Alexa speech, MCP tool text, the wrist), unmasked in grading and in persisted files,
// whole words only, and never in a log line or in health.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAlexaPlugin, progressiveSender } from "../src/alexa/plugin.js";
import { ReplayWrist } from "../src/hub/live/wrist.js";
import { createLivePlugin } from "../src/hub/live/plugin.js";
import { loadMaskTerms, maskDeep, maskOut, maskRegex, maskStatus, parseMaskTerms, setMaskTerms, MASK_SCREEN, MASK_SPEECH } from "../src/hub/mask.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { HubClient } from "../src/mcp/hubClient.js";
import { raw } from "./helpers-http.js";

const TERMS = ["Acme", "Jordan Lee", "export"];
const TERM_RE = /acme|jordan\s+lee|\bexport\b/i;
const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("maskOut (unit)", () => {
  afterAll(() => setMaskTerms([]));
  it("whole words, case-insensitive, multi-word phrases across spaces, longest first", () => {
    setMaskTerms(["Acme", "Jordan Lee", "Jordan"]);
    expect(maskOut("Jordan Lee from ACME and acme's team", "screen")).toBe(`${MASK_SCREEN} from ${MASK_SCREEN} and ${MASK_SCREEN}'s team`);
    expect(maskOut("Jordan  Lee called Jordan", "speech")).toBe(`${MASK_SPEECH} called ${MASK_SPEECH}`);
    expect(maskOut("Acmeville and Acme2 and preacme stay", "screen")).toBe("Acmeville and Acme2 and preacme stay");
    expect(maskOut("Acme-based, (Acme).", "screen")).toBe(`${MASK_SCREEN}-based, (${MASK_SCREEN}).`);
  });
  it("Acmeville is masked only when it is listed itself", () => {
    setMaskTerms(["Acme", "Acmeville"]);
    expect(maskOut("Acmeville and Acme", "screen")).toBe(`${MASK_SCREEN} and ${MASK_SCREEN}`);
  });
  it("parses comment lines, blanks and duplicates; too-short terms are ignored; regex characters are literal", () => {
    expect(parseMaskTerms("# names\nAcme\n\n  acme  \nJordan   Lee\nab\n#Hidden\n")).toEqual(["Acme", "Jordan Lee"]);
    setMaskTerms(["C++ Team", "a.b.c"]);
    expect(maskOut("the C++ Team and axbxc and a.b.c", "screen")).toBe(`the ${MASK_SCREEN} and axbxc and ${MASK_SCREEN}`);
    expect(maskRegex([])).toBeNull();
  });
  it("maskDeep masks wording, never ids, keys or links, and does not change its input", () => {
    setMaskTerms(["Acme"]);
    const v = { id: "acme-1", cardId: "Acme", joinUrl: "http://x/acme", said: "Acme said", nested: { session: { narration: "for Acme" } }, list: ["Acme", 2], breakdown: { acme: 1 } };
    const m = maskDeep(v, "screen");
    expect(m).toEqual({ id: "acme-1", cardId: "Acme", joinUrl: "http://x/acme", said: `${MASK_SCREEN} said`, nested: { session: { narration: `for ${MASK_SCREEN}` } }, list: [MASK_SCREEN, 2], breakdown: { acme: 1 } });
    expect(v.said).toBe("Acme said");
  });
  it("status shows a count only; off without terms", () => {
    setMaskTerms(TERMS);
    expect(maskStatus()).toBe("on (3 terms)");
    setMaskTerms([]);
    expect(maskStatus()).toBe("off");
    expect(maskOut("Acme", "screen")).toBe("Acme");
  });
  it("loads both gitignored files from a directory, either may be missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-"));
    expect(loadMaskTerms(dir)).toEqual([]);
    writeFileSync(join(dir, "private-terms.local.txt"), "# banned\nAcme\n");
    expect(loadMaskTerms(dir)).toEqual(["Acme"]);
    writeFileSync(join(dir, "mask-terms.local.txt"), "Jordan Lee\nacme\n");
    expect(loadMaskTerms(dir)).toEqual(["Acme", "Jordan Lee"]);
  });
});

describe("masking on a demo hub (synthetic terms)", () => {
  let s: HubServer;
  let stateDir: string;
  const logs: string[] = [];
  const wrists: ReplayWrist[] = [];
  const sse: string[] = [];
  const ws: any[] = [];
  let sock: WebSocket;
  let sseAbort: AbortController;
  const get = async (p: string, headers: Record<string, string> = {}) => {
    const r = await raw(s.port, p, { headers });
    return { status: r.status, text: r.text, body: r.text.startsWith("{") ? JSON.parse(r.text) : null };
  };
  const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
    const r = await raw(s.port, p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    return { status: r.status, text: r.text, body: JSON.parse(r.text) };
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-terms-"));
    writeFileSync(join(dir, "private-terms.local.txt"), "# synthetic banned terms\nAcme\n");
    writeFileSync(join(dir, "mask-terms.local.txt"), "Jordan Lee\nexport\n");
    stateDir = mkdtempSync(join(tmpdir(), "mask-hub-"));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const plugins = createPlugins().map((p) =>
      p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p.name === "live" ? createLivePlugin({ wrist: (ctx) => {
        const w = new ReplayWrist({ clock: ctx.hub.clock, pace: ctx.pace });
        wrists.push(w);
        return w;
      } }) : p,
    );
    s = await startHubServer({ port: 0, host: "127.0.0.1", setup: demoSetup({ pace: 0.01, stateDir }), plugins, maskDir: dir, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
    // a TV on the bridge and an SSE client, recording what they are sent
    sock = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    await new Promise<void>((r) => sock.on("open", () => r()));
    sock.on("message", (d) => ws.push(JSON.parse(String(d))));
    sock.send(JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: "mask-tv" }));
    sseAbort = new AbortController();
    void fetch(`${s.url}/api/events`, { signal: sseAbort.signal }).then(async (r) => {
      const rd = r.body!.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        sse.push(Buffer.from(value).toString("utf8"));
      }
    }).catch(() => undefined);
    for (let i = 0; i < 100 && !ws.some((m) => m.type === "welcome"); i++) await sleep(10);
  });
  afterAll(async () => {
    sseAbort.abort();
    sock.close();
    await s.close();
    setMaskTerms([]);
    vi.restoreAllMocks();
  });

  it("health says on and the count, never a term", async () => {
    const h = await get("/api/health");
    expect(h.body.masking).toBe("on (3 terms)");
    expect(h.text).not.toMatch(TERM_RE);
  });

  it("card text is masked on screens; the deck and grading keep the real words", async () => {
    const deck = await get("/api/deck");
    const card = deck.body.cards.find((c: any) => c.id === "demo:hedge-i-guess");
    expect(card.said).toBe(`I guess the billing ${MASK_SCREEN} is ready`);
    expect(card.resay).toContain(`billing ${MASK_SCREEN}`);
    expect(deck.text).not.toMatch(TERM_RE);
    expect(s.setup.hub.card("demo:hedge-i-guess")!.resay).toBe("The billing export is ready for review today.");
  });

  it("an attempt naming Acme and Jordan Lee: masked in HTTP, SSE and WS; graded and persisted unmasked", async () => {
    await post("/api/card/open", { cardId: "demo:hedge-i-guess" });
    await post("/api/demo/scenario", { scenario: "verified" });
    const said = "The billing export is ready for review today, Jordan Lee from Acme says.";
    const a = await post("/api/attempt", { text: said, source: "typed" });
    expect(a.status).toBe(202);
    expect(a.text).not.toMatch(TERM_RE);
    expect(a.body.attempt.provisional.text).toBe(`The billing ${MASK_SCREEN} is ready for review today, ${MASK_SCREEN} from ${MASK_SCREEN} says.`);
    const id = a.body.attempt.id;
    for (let i = 0; i < 200 && !(await get(`/api/attempts/${id}`)).body.verdictReady; i++) await sleep(20);
    const v = await get(`/api/attempts/${id}`);
    expect(v.body.attempt.bee.text).toContain(MASK_SCREEN);
    expect(v.text).not.toMatch(TERM_RE);
    // grading ran on what was said, not on the mask: the content rule matched the real sentence
    const inner = s.setup.hub.attempts.find((x) => x.id === id)!;
    expect(inner.provisional!.text).toBe(said);
    expect(inner.bee!.text).toContain("Jordan Lee from Acme");
    expect(inner.final?.grade.pass).toBe(true);
    // persistence is private and keeps the real text
    expect(readFileSync(join(stateDir, "attempts.json"), "utf8")).toContain("Jordan Lee from Acme");
    // everything a screen was sent
    for (const p of ["/api/attempts?limit=50", "/api/session", "/api/events/recent", "/api/stats", "/api/brief", "/api/deck/next"]) expect((await get(p)).text, p).not.toMatch(TERM_RE);
    await sleep(100);
    const wsText = JSON.stringify(ws);
    expect(wsText).toContain(MASK_SCREEN);
    expect(wsText).not.toMatch(TERM_RE);
    const sseText = sse.join("");
    expect(sseText).toContain(MASK_SCREEN);
    expect(sseText).not.toMatch(TERM_RE);
  });

  it("the home page status is masked too", async () => {
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.text).not.toMatch(TERM_RE);
  });

  it("speech: the loopback client (Alexa, MCP) gets 'name', never the block characters", async () => {
    const hc = new HubClient(s.url);
    const st = await hc.session();
    expect(JSON.stringify(st.body)).not.toMatch(TERM_RE);
    expect(JSON.stringify(st.body)).not.toContain(MASK_SCREEN);
    const n = await hc.call<any>("GET", "/api/deck");
    expect(n.body.cards.find((c: any) => c.id === "demo:hedge-i-guess").resay).toBe(`The billing ${MASK_SPEECH} is ready for review today.`);
  });

  it("Alexa: the skill's spoken answer and the progressive directive say 'name'", async () => {
    const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/launch.json", import.meta.url), "utf8")).request;
    e.request.timestamp = new Date().toISOString();
    await post("/api/card/open", { cardId: "demo:hedge-i-guess" });
    const r = await post("/alexa", e);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`billing ${MASK_SPEECH}`);
    expect(r.text).not.toMatch(TERM_RE);
    expect(r.text).not.toContain(MASK_SCREEN);
    const bodies: string[] = [];
    const send = progressiveSender({ allowed: () => true, fetch: (async (_u: unknown, init: any) => (bodies.push(init.body), new Response(null, { status: 204 }))) as typeof fetch });
    await send({ ...e, context: { System: { apiEndpoint: "https://api.amazonalexa.com", apiAccessToken: "t" } } } as any, "Checking with Bee for Jordan Lee.");
    expect(bodies[0]).toContain(`for ${MASK_SPEECH}`);
    expect(bodies[0]).not.toMatch(TERM_RE);
  });

  it("MCP: tool text and structured content say 'name'", async () => {
    const c = new Client({ name: "mask-test", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
    try {
      const r = (await c.callTool({ name: "submit_attempt", arguments: { text: "The billing export is ready for review today, Jordan Lee from Acme says.", card_id: "demo:hedge-i-guess" } })) as any;
      const out = JSON.stringify(r);
      expect(out).toContain(`${MASK_SPEECH} from ${MASK_SPEECH} says`);
      expect(out).not.toMatch(TERM_RE);
      expect(out).not.toContain(MASK_SCREEN);
    } finally {
      await c.close();
    }
  });

  it("live coach: recap text, coach narration and the wrist are masked; the engine keeps the real words", async () => {
    await post("/api/live/mode", { enabled: true, minutes: 30, by: "test" });
    const before = ws.length;
    expect((await post("/api/demo/live", { script: "story" })).status).toBe(202);
    let recaps: any = null;
    for (let i = 0; i < 400; i++) {
      recaps = (await get("/api/recaps?limit=1")).body;
      if (recaps?.recaps?.length) break;
      await sleep(25);
    }
    expect(recaps.recaps.length).toBe(1);
    await sleep(200);
    const recapText = JSON.stringify(recaps);
    expect(recapText).not.toMatch(TERM_RE);
    expect((await get("/api/coach/now")).text).not.toMatch(TERM_RE);
    expect((await get("/api/live")).text).not.toMatch(TERM_RE);
    expect(JSON.stringify(ws.slice(before))).not.toMatch(TERM_RE);
    // the story's moment is the wearer's own line about the export: masked out, kept inside
    const persisted = readdirSync(join(stateDir, "live")).map((f) => readFileSync(join(stateDir, "live", f), "utf8")).join("\n");
    expect(recapText).toContain(MASK_SCREEN);
    expect(persisted).toMatch(/\bexport\b/);
    const sent = wrists.flatMap((w) => w.sent.map((x) => x.text));
    expect(sent.length).toBeGreaterThan(0);
    for (const t of sent) expect(t).not.toMatch(TERM_RE);
  });

  it("no log line carries a term", () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('"masking":"on (3 terms)"'))).toBe(true);
    for (const l of logs) expect(l).not.toMatch(TERM_RE);
  });
});
