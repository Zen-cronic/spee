// A drill line said in one go with the invocation: "Alexa, tell speech coach <line>" (or "Alexa, ask
// speech coach to try <line>"). Alexa hands the words after the invocation to the model, the
// catch-all sample "{attempt}" takes them, and the skill gets an AttemptIntent in a new session. With
// a line open it is recorded against that line (the path seen working on the Fire TV, 2026-10-22);
// with nothing open the skill opens the due line it matches, starts a drill and records it there.
// The two-step flow (quiz me, then the line) is unchanged, and nothing in the request calls a model.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlexaPlugin } from "../src/alexa/plugin.js";
import { routeRequest } from "../src/alexa/route.js";
import { handleAlexa, matchDueLine, ONE_SHOT_MATCH, SPEECH, type SkillDeps } from "../src/alexa/skill.js";
import type { AlexaRequestEnvelope, SessionAttributes } from "../src/alexa/types.js";
import type { CardView } from "../src/hub/contract.js";
import { HubClient } from "../src/mcp/hubClient.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const LINE = "So the quarterly roadmap slides go out on Thursday morning."; // synthetic, in no deck
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// An AttemptIntent as Alexa sends it: `isNew` for a one-shot (the line came with the invocation).
function attempt(value: string, opts: { isNew?: boolean; attrs?: SessionAttributes } = {}): AlexaRequestEnvelope {
  const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/attempt.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date().toISOString();
  e.request.intent!.slots!.attempt!.value = value;
  e.session!.new = opts.isNew ?? false;
  e.session!.attributes = { ...(opts.attrs ?? {}) };
  return e;
}
function howDidIDo(attrs: SessionAttributes): AlexaRequestEnvelope {
  const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/how-did-i-do.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date().toISOString();
  e.session!.attributes = { ...attrs };
  return e;
}

let s: HubServer;
let hub: HubClient;
const urls: string[] = [];
const post = (p: string, b: unknown) => fetch(s.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
const get = (p: string) => fetch(s.url + p).then((r) => r.json() as Promise<any>);

beforeAll(async () => {
  const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p));
  s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  // Every request the skill makes goes through this client: recorded, so a test can see them all.
  hub = new HubClient(s.url, { fetch: (u, init) => (urls.push(String(u)), fetch(u, init)) });
});
afterAll(async () => s.close());
// The two-step flow's attempt turn, for comparison: quiz me, then the line.
beforeAll(async () => {
  const launch = JSON.parse(readFileSync(new URL("../alexa/fixtures/launch.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
  launch.request.timestamp = new Date().toISOString();
  const l = await handleAlexa(launch, { hub, now: () => Date.now(), sleep, progressive: async () => true });
  const card = (await get("/api/session")).openCard as CardView;
  await post("/api/demo/scenario", { scenario: "bee-hears-filler" }); // a miss keeps every line due for the tests below
  const r = await handleAlexa(attempt(card.resay, { attrs: l.envelope.sessionAttributes }), { hub, now: () => Date.now(), sleep, progressive: async () => true });
  attemptTurn = sameTurn(r.envelope.response.outputSpeech?.text ?? "");
  expect(attemptTurn).toMatch(/checking with Bee/);
  expect(await verdictReady(r.envelope.sessionAttributes!.attemptId as string)).toBe(true); // Bee's replay lands before the tests start
  await post("/api/session/end", {});
});

function deps() {
  const logs: Record<string, unknown>[] = [];
  const d: SkillDeps = { hub, now: () => Date.now(), sleep, progressive: async () => true, log: (event, data) => void logs.push({ event, ...data }), pollEveryMs: 100 };
  return { deps: d, logs };
}
const text = (r: { envelope: { response: { outputSpeech?: { text?: string } } } }) => r.envelope.response.outputSpeech?.text ?? "";
// The attempt turn's words ("Got it, checking with Bee..."), from the two-step flow's own answer.
let attemptTurn = "";
const sameTurn = (t: string) => t.replace(/\d+/g, "N");
async function verdictReady(id: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await get(`/api/attempts/${id}`)).verdictReady) return true;
    await sleep(25);
  }
  return false;
}
// A due line other than the one quiz me would open, so a match is visibly the line said.
async function dueLineNotNext(): Promise<CardView> {
  const deck = await get("/api/deck");
  const next = (await get("/api/deck/next")).card;
  const c = (deck.cards as CardView[]).find((x) => x.dueNow && x.lang === "en" && x.id !== next?.id);
  if (!c) throw new Error("the demo deck has no second due line");
  return c;
}

describe("why the one-shot works with the current interaction model", () => {
  const models = ["en-CA", "en-US"].map((l) => [l, JSON.parse(readFileSync(new URL(`../alexa/skill-package/interactionModels/custom/${l}.json`, import.meta.url), "utf8"))] as const);
  it.each(models)("%s: AttemptIntent's only sample is the catch-all {attempt} (custom type ATTEMPT_TEXT), so any line after the invocation lands there", (_l, m) => {
    const intent = m.interactionModel.languageModel.intents.find((i: { name: string }) => i.name === "AttemptIntent");
    expect(intent.samples).toEqual(["{attempt}"]);
    expect(intent.slots).toEqual([{ name: "attempt", type: "ATTEMPT_TEXT" }]);
  });
  it.each([
    [LINE, LINE],
    // "ask speech coach to try <line>": Alexa drops "to", so the carrier "try" rides in the slot
    [`try ${LINE}`, `try ${LINE}`],
    ["the next release ships friday", "the next release ships friday"],
  ])("the router keeps %j an attempt, words intact", (slot, want) => {
    const r = routeRequest(attempt(slot, { isNew: true }));
    expect(r).toEqual({ intent: "AttemptIntent", text: want, minutes: null, rescuedFrom: null });
  });
});

describe("one-shot attempt", () => {
  it("with a drill open: recorded against the open line in one hub call, and the session stays open for how did I do", async () => {
    const started = await post("/api/session/start", { by: "tv" });
    const card: CardView = started.card;
    await post("/api/demo/scenario", { scenario: "bee-hears-filler" });
    const r = await handleAlexa(attempt(card.resay, { isNew: true }), deps().deps);
    expect(r.hubCalls).toEqual(["POST /api/attempt 202"]);
    expect(sameTurn(text(r))).toBe(attemptTurn);
    expect(r.envelope.response.shouldEndSession).toBe(false);
    expect(r.envelope.response.reprompt?.outputSpeech.text).toBe(SPEECH.askHowDidIDo);
    const attrs = r.envelope.sessionAttributes!;
    expect(attrs).toEqual({ attemptId: expect.stringMatching(/^att_/), cardId: card.id }); // no drillSessionId: the TV's drill is not this skill session's
    const a = await get(`/api/attempts/${attrs.attemptId}`);
    expect(a.attempt).toMatchObject({ cardId: card.id, sessionId: started.session.id, provisional: { source: "alexa", text: card.resay } });

    expect(await verdictReady(attrs.attemptId as string)).toBe(true);
    const v = await handleAlexa(howDidIDo(attrs), deps().deps);
    expect(text(v)).toMatch(/^Not yet: Bee heard a filler word/); // Bee's grade of the open line
    await post("/api/session/end", {});
  });

  it("a line that is not the open one is still recorded against the open line (the hub's rule), never moved", async () => {
    const started = await post("/api/session/start", { by: "tv" });
    const other = (await get("/api/deck")).cards.find((x: CardView) => x.id !== started.card.id && x.lang === "en");
    const r = await handleAlexa(attempt(other.resay, { isNew: true }), deps().deps);
    expect(r.hubCalls).toEqual(["POST /api/attempt 202"]);
    expect(r.envelope.sessionAttributes!.cardId).toBe(started.card.id);
    await post("/api/session/end", {});
  });

  it("with nothing open: opens the due line it matches, starts this skill session's drill, records it, and how did I do answers", async () => {
    await post("/api/session/end", {});
    expect((await get("/api/session")).openCard).toBeNull();
    const card = await dueLineNotNext();
    await post("/api/demo/scenario", { scenario: "verified" });
    const { deps: d, logs } = deps();
    const r = await handleAlexa(attempt(card.resay, { isNew: true }), d);
    expect(r.hubCalls).toEqual(["POST /api/attempt 409", "GET /api/deck 200", "POST /api/card/open 200", "POST /api/session/start 200", "POST /api/attempt 202"]);
    expect(sameTurn(text(r))).toBe(attemptTurn);
    expect(r.envelope.response.shouldEndSession).toBe(false);
    const st = await get("/api/session");
    expect(st.session).toMatchObject({ by: "alexa", cardIds: [card.id] }); // the drill adopted the matched line, nothing else opened
    const attrs = r.envelope.sessionAttributes!;
    expect(attrs).toEqual({ attemptId: expect.stringMatching(/^att_/), cardId: card.id, drillSessionId: st.session.id });
    const a = await get(`/api/attempts/${attrs.attemptId}`);
    expect(a.attempt).toMatchObject({ cardId: card.id, sessionId: st.session.id, provisional: { source: "alexa" } });
    // the log says whether it matched and how well, never the words
    expect(logs).toContainEqual(expect.objectContaining({ event: "alexa.one-shot", matched: true, score: 1 }));
    expect(JSON.stringify(logs)).not.toContain(card.resay.slice(0, 15));

    expect(await verdictReady(attrs.attemptId as string)).toBe(true);
    const v = await handleAlexa(howDidIDo(attrs), deps().deps);
    expect(text(v)).toMatch(/^Nice, Bee heard it\./);
    // the drill is this skill session's: Alexa closing the session ends it, as after quiz me
    const end = JSON.parse(readFileSync(new URL("../alexa/fixtures/session-ended.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
    end.request.timestamp = new Date().toISOString();
    end.session!.attributes = v.envelope.sessionAttributes;
    if ((await get("/api/session")).session) {
      await handleAlexa(end, deps().deps);
      expect((await get("/api/session")).session).toBeNull();
    }
  });

  it('"ask speech coach to try <line>": the carrier word does not stop the match', async () => {
    await post("/api/session/end", {});
    const card = await dueLineNotNext();
    const r = await handleAlexa(attempt(`try ${card.resay}`, { isNew: true }), deps().deps);
    expect(r.hubCalls).toContain("POST /api/card/open 200");
    expect(r.envelope.sessionAttributes!.cardId).toBe(card.id);
    await post("/api/session/end", {});
  });

  it("with nothing open and words that match no due line: the next due line opens, as quiz me would, and the attempt is recorded there", async () => {
    await post("/api/session/end", {});
    const next = (await get("/api/deck/next")).card as CardView;
    const r = await handleAlexa(attempt("what time is it in vancouver", { isNew: true }), deps().deps);
    expect(r.hubCalls).toEqual(["POST /api/attempt 409", "GET /api/deck 200", "POST /api/session/start 200", "POST /api/attempt 202"]);
    expect(r.envelope.sessionAttributes!.cardId).toBe(next.id);
    await post("/api/session/end", {});
  });

  it("an unreachable hub is the short apology", async () => {
    const down = { ...deps().deps, hub: new HubClient("http://127.0.0.1:9", { timeoutMs: 500 }) };
    expect(text(await handleAlexa(attempt(LINE, { isNew: true }), down))).toBe(SPEECH.hubDown);
  });
});

describe("the two-step flow is unchanged", () => {
  it("quiz me, then the line: one hub call per turn, as before", async () => {
    await post("/api/session/end", {});
    const launch = JSON.parse(readFileSync(new URL("../alexa/fixtures/launch.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
    launch.request.timestamp = new Date().toISOString();
    const l = await handleAlexa(launch, deps().deps);
    expect(l.hubCalls).toEqual(["POST /api/session/start 200"]);
    const card = (await get("/api/session")).openCard as CardView;
    const r = await handleAlexa(attempt(card.resay, { attrs: l.envelope.sessionAttributes }), deps().deps);
    expect(r.hubCalls).toEqual(["POST /api/attempt 202"]);
    expect(r.envelope.sessionAttributes).toEqual({ ...l.envelope.sessionAttributes, attemptId: expect.stringMatching(/^att_/), cardId: card.id });
    await post("/api/session/end", {});
  });
  it("a line said mid-session with nothing open still gets the short guidance, and opens nothing", async () => {
    await post("/api/session/end", {});
    const r = await handleAlexa(attempt("the report is ready for review"), deps().deps);
    expect(text(r)).toBe(SPEECH.noCard);
    expect(r.hubCalls).toEqual(["POST /api/attempt 409"]);
    expect((await get("/api/session")).openCard).toBeNull();
  });
});

describe("matchDueLine", () => {
  const card = (id: string, resay: string, dueNow = true) => ({ id, resay, dueNow, lang: "en" }) as CardView;
  const cards = [card("a", "The billing export is ready for review today."), card("b", "The release is blocked on the API key from finance."), card("c", LINE, false)];
  it("picks the closest due line, skips lines not due, and refuses a weak match", () => {
    expect(matchDueLine("the release is blocked on the api key from finance", cards)?.card.id).toBe("b");
    expect(matchDueLine("the release is blocked", cards)?.card.id).toBe("b"); // a near miss of the right line
    expect(matchDueLine(LINE, cards)).toBeNull(); // c is not due
    expect(matchDueLine("what time is it", cards)).toBeNull();
    expect(ONE_SHOT_MATCH).toBe(0.5);
  });
});

describe("no model in the request path", () => {
  it("every request the skill made in these tests went to the hub's own /api routes", () => {
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) expect(u.startsWith(`${s.url}/api/`) || u.startsWith("http://127.0.0.1:9/api/"), u).toBe(true);
  });
  it("nothing the Alexa handler imports reaches src/llm or a model SDK", () => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2]!;
        expect(spec, `${f} imports ${spec}`).not.toMatch(/bedrock|anthropic|openai|@google\/genai|\/llm\//);
        if (spec.startsWith(".")) walk(resolve(dirname(f), spec.replace(/\.js$/, ".ts")));
      }
    };
    walk(join(process.cwd(), "src/alexa/skill.ts"));
    walk(join(process.cwd(), "src/alexa/route.ts"));
    expect([...seen].some((f) => f.endsWith("src/hub/fuzzy.ts"))).toBe(true);
    expect([...seen].filter((f) => f.includes("/src/llm/"))).toEqual([]);
  });
});
