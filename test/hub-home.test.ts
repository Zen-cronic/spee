// The hub's home page (src/hub/home.ts, web/hub/index.html): served on loopback, never through a
// tunnel or to another site's page, and its status blob carries no token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOME_SLOT, renderHome } from "../src/hub/home.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw } from "./helpers-http.js";

const PAIR = "pair-token-for-home-0001";
const MCP = "mcp-token-for-home-00001";
const NGROK = { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" };
const PUBLIC = "abc123.ngrok-free.app";
let s: HubServer;

beforeAll(async () => {
  s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: PAIR, mcpToken: MCP, publicBaseUrl: null });
});
afterAll(async () => s.close());

const statusOf = (html: string) => JSON.parse(/<script id="hub-status" type="application\/json">([^<]*)<\/script>/.exec(html)![1]!);

describe("hub home page", () => {
  it("GET / on loopback serves the page with a plain status and no token", async () => {
    const r = await raw(s.port, "/", { headers: { host: `127.0.0.1:${s.port}` } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.text).toContain("Speaking Mirror");
    expect(r.text).toContain('href="/tv/"');
    expect(r.text).toContain('href="/sim/"');
    expect(r.text).not.toContain(PAIR);
    expect(r.text).not.toContain(MCP);
    const st = statusOf(r.text);
    expect(st).toMatchObject({ demo: true, bee: "replay", phones: 0, screens: 0, pairCode: null });
    expect(typeof st.drillsDue).toBe("number");
    expect(st.dataLabel).toMatch(/SYNTHETIC/);
  });
  it("HEAD / answers 200 with no body", async () => {
    const r = await raw(s.port, "/", { method: "HEAD", headers: { host: `127.0.0.1:${s.port}` } });
    expect(r.status).toBe(200);
    expect(r.text).toBe("");
  });
  it("is not reachable through a public tunnel", async () => {
    const r = await raw(s.port, "/", { headers: { ...NGROK, host: PUBLIC } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe("forbidden");
  });
  it("refuses another site's page (foreign Origin)", async () => {
    const r = await raw(s.port, "/", { headers: { host: `127.0.0.1:${s.port}`, origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe("forbidden_origin");
  });
  it("escapes < in the status blob so no value closes the script element", () => {
    const html = renderHome(`<body>${HOME_SLOT}</body>`, { demo: true, dataLabel: "</script><script>alert(1)</script>", bee: "replay", pairCode: null, screens: 0, phones: 0, drillsDue: 0 });
    expect(html).not.toContain("</script><script>alert");
    expect(statusOf(html).dataLabel).toBe("</script><script>alert(1)</script>");
  });
  it("writes a value with $&, $' or $` as it is, not as a replacement pattern", () => {
    const label = "SYNTHETIC $' $& $` $$ label";
    const html = renderHome(`<body>${HOME_SLOT}<p>after</p></body>`, { demo: true, dataLabel: label, bee: "replay", pairCode: null, screens: 0, phones: 0, drillsDue: 0 });
    expect(statusOf(html).dataLabel).toBe(label);
    expect(html.match(/<p>after<\/p>/g)).toHaveLength(1);
  });
});
