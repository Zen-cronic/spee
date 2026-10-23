// Spee answers to several invocation names, one development skill per name, all on POST /alexa
// (src/alexa/verify.ts). The hub accepts ALEXA_SKILL_ID (else alexa/skill-id.local.json, else alexa/skill-id.json), ALEXA_SKILL_IDS
// and the skills alexa:deploy recorded in alexa/skill-ids.local.json; any other id is refused exactly
// as before, on the LAN and through the gate. Ids never appear in a log line or the health note.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlexaPlugin } from "../src/alexa/plugin.js";
import type { AlexaRequestEnvelope } from "../src/alexa/types.js";
import { PLACEHOLDER_SKILL_ID, readLocalSkills, readSkillConfig, readSkillConfigWithSource, resolveSkillIds, skillIdSource, verifyAlexaRequest } from "../src/alexa/verify.js";
import type { PluginCtx } from "../src/hub/plugin.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { raw } from "./helpers-http.js";

const MAIN = "amzn1.ask.skill.11111111-1111-1111-1111-111111111111";
const COACH = "amzn1.ask.skill.22222222-2222-2222-2222-222222222222";
const ONE_WORD = "amzn1.ask.skill.33333333-3333-3333-3333-333333333333";
const LISTED = "amzn1.ask.skill.44444444-4444-4444-4444-444444444444";
const STRANGER = "amzn1.ask.skill.99999999-9999-9999-9999-999999999999";
const NOW = Date.parse("2026-10-21T15:00:00Z");

function env(skill: string, now = Date.now()): AlexaRequestEnvelope {
  const e = JSON.parse(readFileSync(new URL("../alexa/fixtures/help.json", import.meta.url), "utf8")).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date(now).toISOString();
  e.session!.application!.applicationId = skill;
  e.context!.System!.application!.applicationId = skill;
  return e;
}

let dir = "";
let config = "";
let local = "";
const writeLocal = (skills: Record<string, unknown>) => writeFileSync(local, JSON.stringify({ skills }));
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alexa-ids-"));
  config = join(dir, "skill-id.json");
  local = join(dir, "skill-ids.local.json");
  writeFileSync(config, JSON.stringify({ skillId: MAIN, stage: "development", askProfile: "default", locales: ["en-CA", "en-US"] }));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("verifyAlexaRequest with a list of skill ids", () => {
  it("accepts any listed id and refuses any other, as with one id", () => {
    for (const id of [MAIN, COACH]) expect(verifyAlexaRequest(env(id, NOW), { skillId: [MAIN, COACH], now: NOW })).toEqual({ ok: true });
    expect(verifyAlexaRequest(env(STRANGER, NOW), { skillId: [MAIN, COACH], now: NOW })).toEqual({ ok: false, reason: "wrong skill id" });
    expect(verifyAlexaRequest(env(COACH, NOW), { skillId: MAIN, now: NOW })).toEqual({ ok: false, reason: "wrong skill id" });
    expect(verifyAlexaRequest(env(MAIN, NOW), { skillId: [], now: NOW }).ok).toBe(false);
  });
  it("refuses a request whose session and context name two different skills, even two listed ones", () => {
    const e = env(MAIN, NOW);
    e.context!.System!.application!.applicationId = COACH;
    expect(verifyAlexaRequest(e, { skillId: [MAIN, COACH], now: NOW })).toEqual({ ok: false, reason: "wrong skill id" });
  });
  it("still checks the timestamp for a listed id", () => {
    expect(verifyAlexaRequest(env(COACH, NOW), { skillId: [MAIN, COACH], now: NOW + 151_000 })).toEqual({ ok: false, reason: "timestamp outside the 150 s window" });
  });
});

describe("alexa/skill-id.local.json", () => {
  it("the checked-in alexa/skill-id.json holds only the placeholder id", () => {
    const j = JSON.parse(readFileSync(new URL("../alexa/skill-id.json", import.meta.url), "utf8")) as { skillId: string };
    expect(j.skillId).toBe(PLACEHOLDER_SKILL_ID);
  });
  it("its skillId replaces the checked-in one, and ALEXA_SKILL_ID replaces both", () => {
    const d = mkdtempSync(join(tmpdir(), "alexa-cfg-"));
    try {
      const cfg = join(d, "skill-id.json");
      writeFileSync(cfg, JSON.stringify({ skillId: PLACEHOLDER_SKILL_ID, askProfile: "default", locales: ["en-CA", "en-US"] }));
      expect(readSkillConfigWithSource(cfg)).toMatchObject({ skillId: PLACEHOLDER_SKILL_ID, source: "skill-id.json" });
      writeFileSync(join(d, "skill-id.local.json"), JSON.stringify({ skillId: COACH }));
      expect(readSkillConfigWithSource(cfg)).toMatchObject({ skillId: COACH, askProfile: "default", locales: ["en-CA", "en-US"], source: "skill-id.local.json" });
      expect(resolveSkillIds({}, { config: cfg, local: join(d, "none.json") })).toMatchObject({ ids: [COACH], sources: ["skill-id.local.json"] });
      expect(resolveSkillIds({ ALEXA_SKILL_ID: MAIN }, { config: cfg, local: join(d, "none.json") })).toMatchObject({ ids: [MAIN], sources: ["ALEXA_SKILL_ID"] });
      writeFileSync(join(d, "skill-id.local.json"), JSON.stringify({ skillId: "not-an-id" }));
      expect(() => readSkillConfig(cfg)).toThrow(/skill-id\.local\.json: skillId must be/);
      writeFileSync(join(d, "skill-id.local.json"), "{");
      expect(() => readSkillConfig(cfg)).toThrow(/does not parse/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("resolveSkillIds", () => {
  it("is the one id from alexa/skill-id.json when nothing else is set", () => {
    rmSync(local, { force: true });
    const s = resolveSkillIds({}, { config, local });
    expect(s.ids).toEqual([MAIN]);
    expect(s.warnings).toEqual([]);
  });
  it("ALEXA_SKILL_ID still replaces alexa/skill-id.json", () => {
    rmSync(local, { force: true });
    expect(resolveSkillIds({ ALEXA_SKILL_ID: ` ${COACH} ` }, { config, local })).toMatchObject({ ids: [COACH], sources: ["ALEXA_SKILL_ID"] });
  });
  it("adds ALEXA_SKILL_IDS (comma-separated) and the deploy's local file, without duplicates", () => {
    writeLocal({ "speech coach": MAIN, "spee coach": COACH, spee: ONE_WORD });
    const s = resolveSkillIds({ ALEXA_SKILL_IDS: ` ${LISTED}, ,${COACH}` }, { config, local });
    expect(s.ids.sort()).toEqual([MAIN, COACH, ONE_WORD, LISTED].sort());
    expect(s.names).toEqual({ [MAIN]: "speech coach", [COACH]: "spee coach", [ONE_WORD]: "spee" });
    expect(s.sources).toHaveLength(3);
    expect(s.sources[1]).toBe("ALEXA_SKILL_IDS");
  });
  it("skips and reports an entry that is not a skill id, without printing it", () => {
    writeLocal({ "spee coach": COACH, spee: "not-an-id-SECRET" });
    const s = resolveSkillIds({ ALEXA_SKILL_IDS: `${LISTED},oops-SECRET` }, { config, local });
    expect(s.ids.sort()).toEqual([MAIN, COACH, LISTED].sort());
    expect(s.warnings).toHaveLength(2);
    expect(s.warnings.join(" ")).toContain("ALEXA_SKILL_IDS: entry 2");
    expect(s.warnings.join(" ")).toContain('"spee"');
    expect(JSON.stringify(s.sources) + JSON.stringify(s.warnings)).not.toMatch(/SECRET|amzn1\.ask\.skill\.\d/);
  });
  it("a local file that does not parse accepts none of its skills, and the main skill still works", () => {
    writeFileSync(local, "{ not json");
    const s = resolveSkillIds({}, { config, local });
    expect(s.ids).toEqual([MAIN]);
    expect(s.warnings[0]).toMatch(/does not parse/);
    expect(readLocalSkills(join(dir, "missing.json"))).toEqual({ skills: {}, warnings: [] });
  });
  it("skillIdSource reads the local file again when a deploy writes it", () => {
    rmSync(local, { force: true });
    const source = skillIdSource({}, { config, local });
    expect(source().ids).toEqual([MAIN]);
    expect(source()).toBe(source()); // unchanged file: the same answer, not a re-read
    writeLocal({ "spee coach": COACH });
    expect(source().ids).toEqual([MAIN, COACH]);
  });
});

describe("the alexa plugin logs which name was used, once per skill, never the id", () => {
  function ctx(logs: { event: string; data?: Record<string, unknown> }[]): PluginCtx {
    return {
      log: (event: string, data?: Record<string, unknown>) => void logs.push({ event, data }),
      isPublic: () => false,
      selfUrl: () => "http://127.0.0.1:1",
      json: (res: ServerResponse, status: number) => void (res.statusCode = status),
    } as unknown as PluginCtx;
  }
  async function post(plugin: ReturnType<typeof createAlexaPlugin>, c: PluginCtx, body: unknown) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: {} }) as unknown as IncomingMessage;
    const res = { statusCode: 0 } as ServerResponse;
    await plugin.route!(req, res, new URL("http://127.0.0.1/alexa"), c);
    return res.statusCode;
  }
  it("alexa.skill-ids at start and on change, alexa.skill per name", async () => {
    writeLocal({ "speech coach": MAIN, "spee coach": COACH });
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const plugin = createAlexaPlugin({ skillIds: skillIdSource({}, { config, local }), verifySignature: false });
    const c = ctx(logs);
    plugin.attach!(c);
    expect(await post(plugin, c, env(COACH))).toBe(200);
    expect(await post(plugin, c, env(COACH))).toBe(200);
    expect(await post(plugin, c, env(MAIN))).toBe(200);
    expect(await post(plugin, c, env(STRANGER))).toBe(400);
    expect(logs.filter((l) => l.event === "alexa.skill").map((l) => l.data)).toEqual([{ name: "spee coach" }, { name: "speech coach" }]);
    expect(logs.filter((l) => l.event === "alexa.skill-ids").map((l) => l.data?.accepted)).toEqual([2]);
    writeLocal({ "speech coach": MAIN, "spee coach": COACH, spee: ONE_WORD });
    expect(await post(plugin, c, env(ONE_WORD))).toBe(200);
    expect(logs.filter((l) => l.event === "alexa.skill-ids").map((l) => l.data?.accepted)).toEqual([2, 3]);
    expect(JSON.stringify(logs)).not.toMatch(/amzn1\.ask\.skill\.\d/);
    expect(plugin.describe!().note).toMatch(/^3 skill ids from /);
    expect(plugin.describe!().note).not.toContain("amzn1");
  });
  it("a local file that does not parse, or has no skills object, makes the health note degraded and says its skills are refused (review L193)", () => {
    const fresh = () => createAlexaPlugin({ skillIds: skillIdSource({}, { config, local }), verifySignature: false });
    writeFileSync(local, "{ not json");
    let d = fresh().describe!();
    expect(d.status).toBe("degraded");
    expect(d.note).toMatch(/^1 skill id from skill-id\.json; skill-ids\.local\.json could not be read, so the skills in it are refused; /);
    expect(d.note).not.toContain("skipped");
    writeFileSync(local, JSON.stringify({ spee: "x" }));
    d = fresh().describe!();
    expect(d.status).toBe("degraded");
    expect(d.note).toContain("skill-ids.local.json could not be read, so the skills in it are refused");
    // one bad entry in a file that reads: the rest are accepted, and the note counts the one skipped
    writeLocal({ "spee coach": COACH, spee: "not-an-id" });
    d = fresh().describe!();
    expect(d.status).toBe("ready");
    expect(d.note).toMatch(/^2 skill ids from skill-id\.json, skill-ids\.local\.json \(1 skipped\); signature check/);
    expect(JSON.stringify(d)).not.toContain("amzn1");
  });
  it("a fixed id (the option tests use) still works alone", () => {
    expect(createAlexaPlugin({ skillId: MAIN }).describe!().note).toMatch(/^1 skill id from options;/);
  });
});

describe("POST /alexa over HTTP with several skills", () => {
  let s: HubServer;
  beforeAll(async () => {
    writeLocal({ "speech coach": MAIN, "spee coach": COACH });
    const skillIds = skillIdSource({ ALEXA_SKILL_IDS: LISTED }, { config, local });
    // The signature check passes every request here, so a public request reaches the skill id check.
    const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillIds, verifySignature: async () => ({ ok: true }) }) : p));
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  });
  afterAll(async () => s?.close());
  const tunnel = { "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" };
  const send = (body: unknown, headers: Record<string, string> = {}) => raw(s.port, "/alexa", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("every listed skill is answered, on this machine and through the tunnel", async () => {
    for (const id of [MAIN, COACH, LISTED]) {
      expect((await send(env(id))).status, id).toBe(200);
      expect((await send(env(id), tunnel)).status, id).toBe(200);
    }
  });
  it("any other skill is refused as before: 400 wrong skill id, on this machine and through the tunnel", async () => {
    for (const headers of [{}, tunnel]) {
      const r = await send(env(STRANGER), headers);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text)).toEqual({ error: "alexa_rejected", message: "wrong skill id" });
    }
    const stale = await send(env(COACH, Date.now() - 200_000), tunnel);
    expect(JSON.parse(stale.text)).toEqual({ error: "alexa_rejected", message: "timestamp outside the 150 s window" });
    expect((await raw(s.port, "/alexa", { headers: tunnel })).status).toBe(403); // the gate: POST only
  });
  it("a skill the deploy records while the hub runs is answered without a restart", async () => {
    expect((await send(env(ONE_WORD), tunnel)).status).toBe(400);
    writeLocal({ "speech coach": MAIN, "spee coach": COACH, spee: ONE_WORD });
    expect((await send(env(ONE_WORD), tunnel)).status).toBe(200);
  });
});
