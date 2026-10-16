// The hub server in-process, in demo mode (synthetic fixtures, Bee replay at 1% pace).
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";

const SECRET = "OTHER SPEAKER SECRET PHRASE";
let s: HubServer;
let stateDir: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => {
  const r = await fetch(s.url + p);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: string, b: unknown = {}) => {
  const r = await fetch(s.url + p, { method: "POST", body: JSON.stringify(b) });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "hub-"));
  s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir }) });
});
afterAll(async () => s.close());

describe("hub server (demo)", () => {
  it("rejects what the contract does not allow", async () => {
    expect((await get("/api/nope")).status).toBe(404);
    expect((await get("/api/stats?range=month")).body.error).toBe("bad_range");
    expect((await get("/api/stats?source=meetings")).body.error).toBe("bad_source");
    expect((await post("/api/attempt", { text: "hello" })).status).toBe(409);
    expect((await post("/api/attempt", { text: "hello", source: "bee" })).status).toBe(400);
    expect((await post("/api/attempt", { text: "hello", cardId: "nope" })).status).toBe(404);
    expect((await post("/api/card/open", { cardId: "nope" })).status).toBe(404);
    expect((await post("/api/demo/scenario", { scenario: "magic" })).status).toBe(400);
    const r = await get("/api/transfer?habit=vague");
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("not_preregistered");
  });
  it("labels demo data as synthetic everywhere", async () => {
    for (const p of ["/api/health", "/api/stats", "/api/transfer", "/api/brief", "/api/deck"]) expect((await get(p)).body.dataLabel).toMatch(/SYNTHETIC/);
  });
  it("a provisional attempt never moves the schedule; an unverified one never counts", async () => {
    const card = (await post("/api/card/open", { cardId: "demo:vague-status" })).body.card;
    await post("/api/demo/scenario", { scenario: "untagged" });
    const a = (await post("/api/attempt", { text: card.resay, source: "typed" })).body.attempt;
    expect(a.status).toBe("pending_bee");
    const boxBefore = (await get("/api/deck")).body.cards.find((c: any) => c.id === card.id).box;
    for (let i = 0; i < 50 && (await get("/api/session")).body.state !== "unverified"; i++) await sleep(50);
    const st = (await get("/api/session")).body;
    expect(st.state).toBe("unverified");
    expect(st.lastAttempt.counted).toBe(false);
    expect((await get("/api/deck")).body.cards.find((c: any) => c.id === card.id).box).toBe(boxBefore);
  });
  it("text from other speakers or untagged Bee lines never reaches disk or events", async () => {
    await post("/api/card/open", { cardId: "demo:hedge-stack" });
    const now = s.setup.hub.clock();
    s.setup.hub.ingestBee({ type: "new-utterance", conversation_uuid: "c", utterance: { id: 777, text: SECRET, start: 0, end: 2, spoken_at: new Date(now - 2000).toISOString() } });
    s.setup.hub.ingestBee({ type: "tagged-utterance", utterance_id: 777, person_id: 2, person_first_name: "Sam", speaker_score: 0.9 });
    s.setup.hub.ingestBee({ type: "new-utterance", conversation_uuid: "c", utterance: { id: 778, text: `${SECRET} again`, start: 0, end: 2, spoken_at: new Date(now - 1000).toISOString() } });
    await post("/api/attempt", { text: "The release is blocked on the API key from finance.", source: "typed" });
    await sleep(800);
    for (const f of readdirSync(stateDir)) expect(readFileSync(join(stateDir, f), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify((await get("/api/events/recent")).body)).not.toContain(SECRET);
    expect(JSON.stringify((await get("/api/attempts?limit=50")).body)).not.toContain(SECRET);
  });
  it("persists deck and attempts to the state dir", async () => {
    expect(readdirSync(stateDir).sort()).toEqual(["attempts.json", "deck.json"]);
  });
});

describe("demo Bee replay scenarios", () => {
  it("the asr-slip and filler scenarios change Bee's text as described, and the grader handles them", async () => {
    const { DemoDirector } = await import("../src/hub/setup.js");
    const { buildDeck } = await import("../src/hub/demoData.js");
    const { grade } = await import("../src/hub/grade.js");
    expect(DemoDirector.beeText("Open the drill card on the Rack Board screen.", "asr-slip")).toBe("Open the drill car on the rec board screen.");
    for (const c of buildDeck().cards.filter((x) => x.lang === "en")) {
      const g = (t: string) => grade({ lang: c.lang, resay: c.resay, habit: c.habit!, mustSay: c.mustSay }, t);
      const slip = DemoDirector.beeText(c.resay, "asr-slip");
      expect(slip).not.toBe(c.resay);
      expect(g(slip).pass).toBe(true);
      expect(g(DemoDirector.beeText(c.resay, "bee-hears-filler")).fillers).toEqual(["um"]);
    }
  });
});
