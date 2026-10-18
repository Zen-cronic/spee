// The Alexa skill against an in-process demo hub in fixture mode (packet C): the two-turn drill
// (Launch -> Attempt answered < 1 s -> early HowDidIDo with a progressive response, < 7 s on a fake
// clock -> the verdict after the Bee replay), the fail and unverified verdicts, every other intent,
// and POST /alexa over HTTP (skill id and timestamp rejected, gate).
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlexaPlugin, progressiveSender } from "../src/alexa/plugin.js";
import { handleAlexa, SPEECH, type SkillDeps } from "../src/alexa/skill.js";
import { clip } from "../src/alexa/speech.js";
import type { AlexaRequestEnvelope, SessionAttributes } from "../src/alexa/types.js";
import { HubClient } from "../src/mcp/hubClient.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw } from "./helpers-http.js";

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const contractFx = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/contract-v2/${f}`, import.meta.url), "utf8"));
function env(name: string, opts: { attrs?: SessionAttributes; slot?: string; now?: number } = {}): AlexaRequestEnvelope {
  const e = JSON.parse(readFileSync(new URL(`../alexa/fixtures/${name}.json`, import.meta.url), "utf8")).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date(opts.now ?? Date.now()).toISOString();
  if (opts.attrs) e.session!.attributes = { ...opts.attrs };
  if (opts.slot !== undefined) e.request.intent!.slots!.attempt!.value = opts.slot;
  return e;
}

let s: HubServer;
let hub: HubClient;
const post = (p: string, b: unknown) => fetch(s.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
const get = (p: string) => fetch(s.url + p).then((r) => r.json() as Promise<any>);

beforeAll(async () => {
  const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p));
  s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  hub = new HubClient(s.url);
});
afterAll(async () => s.close());

// A fake clock: sleep() advances it instantly (yielding to the event loop once).
function fake() {
  let t = 0;
  const spoken: string[] = [];
  const logs: unknown[] = [];
  const deps: SkillDeps = {
    hub,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    progressive: async (_e, speech) => (spoken.push(speech), true),
    log: (event, data) => void logs.push({ event, ...data }),
  };
  return { deps, spoken, logs, elapsed: () => t };
}
const real = (pollEveryMs = 100) => {
  const spoken: string[] = [];
  const deps: SkillDeps = { hub, now: () => Date.now(), sleep, progressive: async (_e, sp) => (spoken.push(sp), true), pollEveryMs };
  return { deps, spoken };
};
const text = (r: { envelope: { response: { outputSpeech?: { text?: string } } } }) => r.envelope.response.outputSpeech?.text ?? "";
async function verdictReady(id: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await get(`/api/attempts/${id}`)).verdictReady) return true;
    await sleep(25);
  }
  return false;
}

describe("two-turn drill", () => {
  it("Launch -> Attempt (< 1 s) -> early HowDidIDo (progressive, < 7 s fake) -> verdict after the Bee replay -> next card", async () => {
    const f = fake();
    const launch = await handleAlexa(env("launch"), f.deps);
    const state = await get("/api/session");
    const resay: string = state.openCard.resay;
    expect(state.session.by).toBe("alexa");
    expect(text(launch)).toBe(`Speech coach. Say this: "${resay}"`);
    expect(launch.envelope.response.shouldEndSession).toBe(false);
    expect(launch.envelope.sessionAttributes).toEqual({ cardId: state.openCard.id });
    expect(launch.hubCalls).toEqual(["POST /api/session/start 200"]);

    await post("/api/demo/scenario", { scenario: "verified" });
    const t0 = Date.now();
    const att = await handleAlexa(env("attempt", { attrs: launch.envelope.sessionAttributes, slot: resay }), f.deps);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(text(att)).toMatch(/^Got it, checking with Bee\. Ask me how you did in about \d+ seconds\.$/);
    expect(att.envelope.response.reprompt?.outputSpeech.text).toBe(SPEECH.askHowDidIDo);
    expect(att.envelope.response.shouldEndSession).toBe(false);
    const attemptId = att.envelope.sessionAttributes!.attemptId as string;
    expect(attemptId).toMatch(/^att_/);
    const pending = await get(`/api/attempts/${attemptId}`);
    expect(pending.attempt.provisional.source).toBe("alexa");
    expect(pending.verdictReady).toBe(false);

    const early = fake();
    const how = await handleAlexa(env("how-did-i-do", { attrs: att.envelope.sessionAttributes }), early.deps);
    expect(early.spoken).toEqual([SPEECH.checking]);
    expect(early.elapsed()).toBeLessThanOrEqual(6500);
    expect(early.elapsed()).toBeGreaterThan(5000); // it used the budget polling
    expect(how.hubCalls.length).toBeGreaterThan(5);
    expect(text(how)).toBe("Bee hasn't sent that line yet. Ask me again in a few seconds.");
    expect(how.envelope.sessionAttributes!.attemptId).toBe(attemptId);
    expect(how.envelope.response.shouldEndSession).toBe(false);

    expect(await verdictReady(attemptId)).toBe(true);
    const later = fake();
    const verdict = await handleAlexa(env("how-did-i-do", { attrs: how.envelope.sessionAttributes }), later.deps);
    expect(later.spoken).toEqual([]);
    const next = (await get("/api/session")).openCard;
    expect(text(verdict)).toBe(`Bee heard it: a pass. Next, say: "${next.resay}"`);
    expect(verdict.hubCalls).toEqual(["GET /api/attempts/<id> 200", "POST /api/session/next 200"]);
    expect(verdict.envelope.sessionAttributes).toEqual({ cardId: next.id });
    const graded = await get(`/api/attempts/${attemptId}`);
    expect(graded.attempt).toMatchObject({ status: "graded", counted: true, final: { source: "bee", pass: true } });
    // logs carry intent names and timings, never what was said
    expect(JSON.stringify([...f.logs, ...early.logs, ...later.logs])).not.toContain(resay.slice(0, 20));
  });

  it("an early HowDidIDo sends one progressive response and speaks the verdict once Bee lands (real clock, < 7 s)", async () => {
    const card = (await get("/api/session")).openCard;
    await post("/api/demo/scenario", { scenario: "verified" });
    const att = await handleAlexa(env("attempt", { attrs: { cardId: card.id }, slot: card.resay }), fake().deps);
    const r = real();
    const t0 = Date.now();
    const v = await handleAlexa(env("how-did-i-do", { attrs: att.envelope.sessionAttributes }), r.deps);
    expect(Date.now() - t0).toBeLessThan(7000);
    expect(r.spoken).toEqual([SPEECH.checking]);
    expect(text(v)).toMatch(/^Bee heard it: a pass\. (Next, say: ".+"|That's the drill: \d+ of \d+ Bee-graded attempts passed\.)$/);
  });

  it("a fail names the rule Bee's line broke and asks again; HowDidIDo from the catch-all finds the attempt itself", async () => {
    let card = (await get("/api/session")).openCard;
    if (!card) card = (await post("/api/session/start", { by: "alexa" })).card;
    await post("/api/demo/scenario", { scenario: "bee-hears-filler" });
    const att = await handleAlexa(env("attempt", { attrs: { cardId: card.id }, slot: card.resay }), fake().deps);
    expect(await verdictReady(att.envelope.sessionAttributes!.attemptId as string)).toBe(true);
    const v = await handleAlexa(env("how-did-i-do-in-catch-all", { attrs: {} }), fake().deps); // no attemptId: the session's last attempt
    expect(v.routed).toMatchObject({ intent: "HowDidIDoIntent", rescuedFrom: "AttemptIntent" });
    expect(text(v)).toBe(`Not yet: Bee heard a filler, "um". Say it again: "${card.resay}"`);
    expect(v.envelope.response.reprompt?.outputSpeech.text).toBe(`Say: "${card.resay}"`);
    expect(v.envelope.sessionAttributes).toEqual({ cardId: card.id });
  });

  it("an attempt Bee never confirms does not count", async () => {
    const card = (await get("/api/session")).openCard;
    await post("/api/demo/scenario", { scenario: "untagged" });
    const att = await handleAlexa(env("attempt", { attrs: { cardId: card.id }, slot: card.resay }), fake().deps);
    expect(await verdictReady(att.envelope.sessionAttributes!.attemptId as string, 6000)).toBe(true);
    const v = await handleAlexa(env("how-did-i-do", { attrs: att.envelope.sessionAttributes }), fake().deps);
    expect(text(v)).toBe(`Bee didn't confirm that one, so it doesn't count. Say it again: "${card.resay}"`);
  });

  it("no open card, no attempt: short guidance instead of an error", async () => {
    await post("/api/session/end", {});
    const a = await handleAlexa(env("attempt", { slot: "the report is ready for review" }), fake().deps);
    expect(text(a)).toBe(SPEECH.noCard);
    expect(a.envelope.sessionAttributes).toEqual({});
    const n = await handleAlexa(env("next"), fake().deps);
    expect(text(n)).toBe(SPEECH.noDrill);
  });
});

describe("other intents", () => {
  it("HowAmIDoing speaks GET /api/coach/now exactly as the contract fixture shows", async () => {
    const fx = contractFx("alexa-how-am-i-doing.json");
    const e = { ...fx.request, request: { ...fx.request.request, timestamp: new Date().toISOString() } };
    const r = await handleAlexa(e, fake().deps);
    expect(r.envelope).toEqual(fx.response);
    expect(r.hubCalls).toEqual(["GET /api/coach/now 200"]);
  });
  it("live coaching on and off speak /api/live/mode; a one-shot ends the session", async () => {
    const on = await handleAlexa(env("live-coach-on"), fake().deps);
    expect(text(on)).toBe(clip(contractFx("live-mode-on.json").narration));
    expect(on.envelope.response.shouldEndSession).toBe(true);
    expect(on.hubCalls).toEqual(["POST /api/live/mode 200"]);
    const off = await handleAlexa(env("live-coach-off"), fake().deps);
    expect(text(off)).toBe(clip(contractFx("live-mode-off.json").narration));
  });
  it("did it transfer speaks the transfer headline", async () => {
    const t = await get("/api/transfer");
    const r = await handleAlexa(env("did-it-transfer"), fake().deps);
    expect(text(r)).toBe(clip(t.headline));
    expect(r.envelope.response.shouldEndSession).toBe(false);
  });
  it("next, stop, help, fallback and session end", async () => {
    await post("/api/session/start", { by: "alexa", size: 3 });
    const n = await handleAlexa(env("next"), fake().deps);
    const open = (await get("/api/session")).openCard;
    expect(text(n)).toBe(`Next, say: "${open.resay}"`);
    expect(n.envelope.sessionAttributes).toEqual({ cardId: open.id });
    const fb = await handleAlexa(env("fallback", { attrs: { cardId: open.id } }), fake().deps);
    expect(text(fb)).toBe(SPEECH.fallbackCard);
    expect(text(await handleAlexa(env("fallback"), fake().deps))).toBe(SPEECH.fallbackIdle);
    expect(text(await handleAlexa(env("help"), fake().deps))).toBe(SPEECH.help);
    const stop = await handleAlexa(env("stop", { attrs: { cardId: open.id, attemptId: "att_x" } }), fake().deps);
    expect(stop.envelope.response.shouldEndSession).toBe(true);
    expect(stop.envelope.sessionAttributes).toEqual({});
    expect(stop.hubCalls).toEqual(["GET /api/session 200", "POST /api/session/end 200"]);
    expect((await get("/api/session")).session).toBeNull();
    const end = await handleAlexa(env("session-ended"), fake().deps);
    expect(end.envelope).toEqual({ version: "1.0", response: {} });
    expect(end.hubCalls).toEqual([]);
  });
  it("an unreachable hub is a short apology, not a crash", async () => {
    const down = { ...fake().deps, hub: new HubClient("http://127.0.0.1:9", { timeoutMs: 500 }) };
    const r = await handleAlexa(env("how-am-i-doing"), down);
    expect(text(r)).toBe(SPEECH.hubDown);
  });
});

describe("POST /alexa over HTTP", () => {
  const send = (body: unknown, headers: Record<string, string> = {}) => raw(s.port, "/alexa", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  it("answers a valid request with an Alexa envelope", async () => {
    const r = await send(env("help"));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ version: "1.0", response: { outputSpeech: { type: "PlainText", text: SPEECH.help }, shouldEndSession: false } });
  });
  it("rejects a wrong skill id and a stale timestamp with 400 alexa_rejected", async () => {
    const wrong = env("help");
    wrong.session!.application!.applicationId = "amzn1.ask.skill.someone-else";
    wrong.context!.System!.application!.applicationId = "amzn1.ask.skill.someone-else";
    const a = await send(wrong);
    expect(a.status).toBe(400);
    expect(JSON.parse(a.text)).toEqual({ error: "alexa_rejected", message: "wrong skill id" });
    const b = await send(env("help", { now: Date.now() - 200_000 }));
    expect(b.status).toBe(400);
    expect(JSON.parse(b.text)).toEqual({ error: "alexa_rejected", message: "timestamp outside the 150 s window" });
    expect((await send({})).status).toBe(400);
  });
  it("is reachable through a tunnel (the gate passes POST /alexa only), where an unsigned request is refused; GET is 405 on the LAN", async () => {
    const ngrok = { "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" };
    const r = await send(env("help"), ngrok);
    expect(r.status).toBe(400); // signature verification is on by default for public requests
    expect(JSON.parse(r.text)).toEqual({ error: "alexa_rejected", message: "bad SignatureCertChainUrl" });
    expect((await raw(s.port, "/alexa", { headers: ngrok })).status).toBe(403);
    expect((await raw(s.port, "/alexa")).status).toBe(405);
  });
  it("health reports the alexa plugin ready", async () => {
    const h = await get("/api/health");
    expect(h.plugins.find((p: any) => p.name === "alexa")).toMatchObject({ owner: "packet C", status: "ready", routes: ["POST /alexa"] });
  });
});

describe("progressive response sender", () => {
  let srv: Server;
  let base = "";
  const got: { auth?: string; path?: string; body?: any }[] = [];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        got.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(b) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it("POSTs VoicePlayer.Speak (SSML) to {apiEndpoint}/v1/directives with the request id and token", async () => {
    const e = env("how-did-i-do");
    e.context!.System!.apiEndpoint = base;
    expect(await progressiveSender({ allowed: () => true })(e, "Checking with Bee & co.")).toBe(true);
    expect(got.at(-1)).toEqual({
      auth: "Bearer DEMO.ACCESS.TOKEN",
      path: "/v1/directives",
      body: { header: { requestId: e.request.requestId }, directive: { type: "VoicePlayer.Speak", speech: "<speak>Checking with Bee &amp; co.</speak>" } },
    });
  });
  it("never POSTs to a host that is not Alexa's API (default allow-list)", async () => {
    const n = got.length;
    const e = env("how-did-i-do");
    e.context!.System!.apiEndpoint = base;
    expect(await progressiveSender()(e, "x")).toBe(false);
    delete e.context!.System!.apiAccessToken;
    expect(await progressiveSender({ allowed: () => true })(e, "x")).toBe(false);
    expect(got.length).toBe(n);
  });
});
