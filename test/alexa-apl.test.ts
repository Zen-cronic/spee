// Speaking Mirror screens on Alexa devices with a display (src/alexa/apl.ts,
// alexa/apl/speaking-mirror.json): the manifest declares APL; the directive goes out only when the
// device lists Alexa.Presentation.APL; each screen's datasource; masking for the screen; the
// document's shape, bindings and palette (the TV's).
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APL_DIRECTIVE, aplDocument, checkingScreen, drillScreen, EMPTY, emptyScreen, gradeFailure, IDLE_AFTER_END_MS, plainReason, progressScreen, renderDirective, supportsApl, tracker, verdictScreen, type Screen } from "../src/alexa/apl.js";
import { createAlexaPlugin, maskSpoken } from "../src/alexa/plugin.js";
import { handleAlexa, summaryScreen, type SkillDeps } from "../src/alexa/skill.js";
import type { AlexaRequestEnvelope, AlexaResponseEnvelope, SessionAttributes } from "../src/alexa/types.js";
import type { GradeResult } from "../src/hub/contract.js";
import { MASK_SCREEN, MASK_SPEECH, setMaskTerms } from "../src/hub/mask.js";
import { createPlugins } from "../src/hub/plugins.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { HubClient } from "../src/mcp/hubClient.js";
import * as tv from "../tv/web/src/mirror/format.js";

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const DOC = JSON.parse(read("alexa/apl/speaking-mirror.json"));
const APL_DEVICE = { deviceId: "amzn1.ask.device.DEMO", supportedInterfaces: { "Alexa.Presentation.APL": { runtime: { maxVersion: "2024.3" } } } };

function env(name: string, opts: { attrs?: SessionAttributes; slot?: string; screen?: boolean } = {}): AlexaRequestEnvelope {
  const e = JSON.parse(read(`alexa/fixtures/${name}.json`)).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date().toISOString();
  if (opts.attrs) e.session!.attributes = { ...opts.attrs };
  if (opts.slot !== undefined) e.request.intent!.slots!.attempt!.value = opts.slot;
  if (opts.screen !== false) e.context!.System!.device = structuredClone(APL_DEVICE);
  return e;
}
const directives = (r: { envelope: AlexaResponseEnvelope }) => r.envelope.response.directives ?? [];
const screenOf = (r: { envelope: AlexaResponseEnvelope }): Screen => (directives(r)[0]!.datasources as { payload: { screen: Screen } }).payload.screen;

const grade = (over: Partial<GradeResult>): GradeResult => ({
  graderVersion: 1,
  pass: false,
  reasons: [],
  checks: [],
  habit: { kind: "hedge", label: "unsure words", hits: 0, found: [] },
  fillerCount: 0,
  fillers: [],
  hedgeCount: 0,
  hedges: [],
  contentMatch: 1,
  contentThreshold: 0.8,
  missing: [],
  fuzzy: [],
  required: [],
  ...over,
});
const failed = (rule: GradeResult["checks"][number]["rule"]) => [{ rule, ok: false, detail: "" }];

describe("skill manifest", () => {
  it("declares ALEXA_PRESENTATION_APL with the TV and landscape hub viewports, both locales kept", () => {
    const m = JSON.parse(read("alexa/skill-package/skill.json")).manifest;
    const apl = m.apis.custom.interfaces.find((i: { type: string }) => i.type === "ALEXA_PRESENTATION_APL");
    expect(apl).toBeDefined();
    expect(apl.supportedViewports).toContainEqual({ mode: "TV", shape: "RECTANGLE", minHeight: 540, maxHeight: 540, minWidth: 960, maxWidth: 960 });
    expect(apl.supportedViewports.filter((v: { mode: string }) => v.mode === "HUB").length).toBe(3);
    expect(Object.keys(m.publishingInformation.locales)).toEqual(["en-CA", "en-US"]);
    expect(m.apis.custom.endpoint.sslCertificateType).toBe("Wildcard");
  });
});

describe("APL support check", () => {
  it("is true only when the device lists Alexa.Presentation.APL", () => {
    expect(supportsApl(env("launch"))).toBe(true);
    expect(supportsApl(env("launch", { screen: false }))).toBe(false);
    const clock = env("launch", { screen: false });
    clock.context!.System!.device = { supportedInterfaces: { "Alexa.Presentation.APLT": { runtime: { maxVersion: "1.0" } } } };
    expect(supportsApl(clock)).toBe(false); // a character display is not a screen
  });
});

// Every binding the document uses, collected from its strings.
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const ALL_SCREENS: Screen[] = [
  drillScreen({ resay: "I'll send the report on Friday." }),
  checkingScreen({ resay: "I'll send the report on Friday." }),
  checkingScreen(null),
  verdictScreen({ kind: "pass", next: { resay: "We ship on Monday." } }),
  verdictScreen({ kind: "fail", grade: grade({ checks: failed("fillers"), fillers: ["um"] }), next: { resay: "We ship on Monday." } }),
  verdictScreen({ kind: "unverified", next: null, hint: "Say: quiz me" }),
  progressScreen({ narration: "This week you said unsure words less. Keep going.", week: { words: 900, hedgesPer100: 1.2, likesPer100: 0.4, vaguePer100: 0.1, topHabit: { key: "hedges", label: "unsure words", per100: 1.24 } }, drills: { dueNow: 2, nextCardId: null } }),
  EMPTY.caughtUp(),
  summaryScreen({ passed: 2, counted: 3, attempts: 3 }),
];

describe("APL document", () => {
  it("is an APL document with a version, resources, the mark and a mainTemplate taking payload", () => {
    expect(DOC.type).toBe("APL");
    expect(DOC.version).toMatch(/^2023\.\d$/);
    expect(DOC.mainTemplate.parameters).toEqual(["payload"]);
    expect(DOC.mainTemplate.items.length).toBeGreaterThan(0);
    expect(DOC.graphics.mark).toMatchObject({ type: "AVG", version: "1.2" });
    for (const item of DOC.graphics.mark.items) expect(["path", "group"]).toContain(item.type);
    expect(aplDocument()).toEqual(DOC);
  });

  it("every screen kind has its own branch, and every payload binding exists in every screen's datasource", () => {
    const all = strings(DOC.mainTemplate).join("\n");
    for (const kind of ["drill", "checking", "verdict", "progress", "empty"]) expect(all).toContain(`'${kind}'`);
    const refs = [...new Set([...all.matchAll(/payload\.screen\.([A-Za-z]+)/g)].map((m) => m[1]!))];
    expect(refs.length).toBeGreaterThan(10);
    for (const s of ALL_SCREENS) for (const r of refs) expect(s, `${s.kind}.${r}`).toHaveProperty(r);
    // the tracker's items bind data.label/state/who
    const dataRefs = [...new Set([...strings(DOC.layouts).join("\n").matchAll(/data\.([A-Za-z]+)/g)].map((m) => m[1]!))];
    for (const r of dataRefs) expect(tracker(0)[0], r).toHaveProperty(r);
  });

  it("every @resource and every custom component it uses is defined", () => {
    const defined = new Set<string>();
    for (const r of DOC.resources) for (const group of ["colors", "dimensions", "numbers", "strings"]) Object.keys(r[group] ?? {}).forEach((k) => defined.add(k));
    const used = [...new Set(strings({ l: DOC.layouts, m: DOC.mainTemplate }).flatMap((s) => [...s.matchAll(/@([A-Za-z]+)/g)].map((m) => m[1]!)))];
    for (const u of used) expect(defined, `@${u}`).toContain(u);
    const BUILTIN = new Set(["Container", "Frame", "Text", "VectorGraphic"]);
    const types: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.type === "string" && /^[A-Z]/.test(o.type)) types.push(o.type); // components; parameter types are lower case
        Object.values(o).forEach(walk);
      }
    };
    walk({ l: DOC.layouts, m: DOC.mainTemplate });
    for (const t of types) expect(BUILTIN.has(t) || t in DOC.layouts, t).toBe(true);
  });

  it("uses the TV's palette, and one resource (@colorBee) for checked by Bee, the tracker's Bee step and the mark's reflection", () => {
    const theme = read("tv/web/src/theme.ts");
    const C: Record<string, string> = Object.fromEntries([...theme.slice(theme.indexOf("export const C"), theme.indexOf("};")).matchAll(/(\w+): '(#[0-9a-f]{6})'/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
    const colors: Record<string, string> = DOC.resources[0].colors;
    for (const [k, v] of Object.entries(colors)) {
      const tvKey = k === "colorBee" ? "bee" : k === "colorBeeBg" ? "beeBg" : k;
      expect(v.toLowerCase(), k).toBe(C[tvKey]);
    }
    // no colour literal anywhere outside the palette resource
    const outside = strings({ g: DOC.graphics, l: DOC.layouts, m: DOC.mainTemplate }).join("\n");
    expect(outside).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(outside).not.toMatch(/lavender/i);
    const bee = strings(DOC).filter((s) => s.includes("@colorBee"));
    expect(bee.length).toBeGreaterThanOrEqual(3); // the tag, the status line, the tracker, the mark
    expect(DOC.layouts.Brand.items[0].items[0]).toMatchObject({ source: "mark", bee: "@colorBee", you: "@lime" });
  });

  it("draws the mark at 48 dp or more on every viewport (the large master; smaller sizes need the small one)", () => {
    for (const r of DOC.resources) {
      const m = r.dimensions?.markSize;
      if (m) expect(parseInt(m, 10)).toBeGreaterThanOrEqual(48);
    }
  });

  it("the mark is the approved two voices: your bubble and the bar, then the reflection lower in the Bee colour", () => {
    const mark = DOC.graphics.mark;
    expect(mark).toMatchObject({ width: 64, height: 64, viewportWidth: 64, viewportHeight: 64 });
    expect(mark.items.map((i: { fill: string }) => i.fill)).toEqual(["${you}", "${you}", "${bee}"]);
    // where each path starts (its top edge): the reflection sits below your bubble, the bar spans both
    const top = (i: { pathData: string }) => Number(/^M[\d.]+ ([\d.]+)/.exec(i.pathData)![1]);
    const [you, bar, bee] = mark.items.map(top);
    expect(bee).toBeGreaterThan(you);
    expect(bar).toBeLessThan(you);
    expect(mark.parameters).toEqual([
      { name: "you", type: "color", default: "@lime" },
      { name: "bee", type: "color", default: "@colorBee" },
    ]);
  });
});

describe("screens", () => {
  it("drill: the sentence, the tracker on step 1, and what to ask", () => {
    const s = drillScreen({ resay: 'Say "hello"  to the team.' });
    expect(s).toMatchObject({ kind: "drill", brand: "Speaking Mirror", kicker: "Say this:", sentence: 'Say "hello" to the team.', hint: "Then ask: how did I do?", status: "" });
    expect(s.steps.map((x) => [x.label, x.state, x.who])).toEqual([
      ["You said it", "current", "you"],
      ["Checked by Bee", "todo", "bee"],
      ["Result", "todo", "you"],
    ]);
  });
  it("checking: the tracker on step 2 and Bee is checking", () => {
    const s = checkingScreen({ resay: "We ship on Monday." });
    expect(s).toMatchObject({ kind: "checking", sentence: "We ship on Monday.", status: "Bee is checking…" });
    expect(s.steps.map((x) => x.state)).toEqual(["done", "current", "todo"]);
  });
  it("verdict: Passed or Not yet with the TV's reason, Checked by Bee, and the next line", () => {
    const pass = verdictScreen({ kind: "pass", next: { resay: "We ship on Monday." } });
    expect(pass).toMatchObject({ kind: "verdict", headline: "Passed.", tone: "pass", reason: "Bee heard it.", checked: true, tag: "Checked by Bee", kicker: "Next, say:", sentence: "We ship on Monday." });
    const g = grade({ checks: failed("habit"), habit: { kind: "hedge", label: "unsure words", hits: 1, found: ["i guess"] } });
    const fail = verdictScreen({ kind: "fail", grade: g, next: { resay: "We ship on Monday." } });
    expect(fail).toMatchObject({ headline: "Not yet.", tone: "fail", reason: "You still said “i guess”.", checked: true, kicker: "Say it again:" });
    const none = verdictScreen({ kind: "unverified", next: null, hint: "Say: quiz me" });
    expect(none).toMatchObject({ headline: "Not counted.", tone: "neutral", checked: false, sentence: "", hint: "Say: quiz me" });
  });
  it("the reason is the TV's own words for every rule (plainReason of gradeFailure)", () => {
    const cases: GradeResult[] = [
      grade({ checks: failed("nonempty") }),
      grade({ checks: failed("habit"), habit: { kind: "hedge", label: "x", hits: 2, found: ["i think", "i guess", "i think"] } }),
      grade({ checks: failed("habit") }),
      grade({ checks: failed("fillers"), fillers: ["um", "uh", "um"] }),
      grade({ checks: failed("content"), missing: ["report", "friday", "send", "team"] }),
      grade({ checks: failed("content") }),
      grade({ checks: failed("required"), required: [{ word: "Friday", ok: false }, { word: "send", ok: true }] }),
      grade({ checks: [{ rule: "nonempty", ok: true, detail: "" }], pass: true }),
    ];
    for (const g of cases) expect(plainReason(gradeFailure(g))).toBe(tv.plainReason(tv.gradeFailure(g)));
  });
  it("how am I doing: one number, one sentence of the narration, and where to look", () => {
    const base = { narration: 'You said "I guess" less this week. Live coaching is off. Two lines are due.', week: { words: 1200, hedgesPer100: 1.24, likesPer100: 0, vaguePer100: 0, topHabit: { key: "hedges", label: "unsure words", per100: 1.24 } }, drills: { dueNow: 2, nextCardId: null } };
    expect(progressScreen(base)).toMatchObject({ kind: "progress", hero: "1.2", heroCaption: "Unsure words, out of every 100 words you said this week", line: "You said “I guess” less this week.", footerTv: "Open Speaking Mirror on this TV for details" });
    expect(progressScreen({ ...base, week: { ...base.week, topHabit: null } })).toMatchObject({ hero: "2", heroCaption: "lines ready to practise" });
    expect(progressScreen({ ...base, week: { ...base.week, topHabit: null }, drills: { dueNow: 0, nextCardId: null } })).toMatchObject({ hero: "1200", heroCaption: "words Bee heard this week" });
  });
  it("caught up and no line: a friendly empty state", () => {
    expect(EMPTY.caughtUp()).toMatchObject({ kind: "empty", headline: "You’re all caught up.", hint: "Ask: how am I doing?" });
    expect(EMPTY.noLine()).toMatchObject({ kind: "empty", hint: "Say: quiz me" });
    expect(emptyScreen('a "b"', "c")).toMatchObject({ headline: "a “b”", line: "c" });
  });
});

describe("masking", () => {
  afterEach(() => setMaskTerms([]));
  it("masks every datasource string for a screen (▒▒▒); the plugin then masks only what Alexa says", () => {
    setMaskTerms(["Jordan Quill", "Acme"]);
    const d = renderDirective(verdictScreen({ kind: "fail", grade: grade({ checks: failed("content"), missing: ["Acme"] }), next: { resay: "Ask Jordan Quill about Acme." } }));
    const s = (d.datasources as { payload: { screen: Screen } }).payload.screen;
    expect(s.sentence).toBe(`Ask ${MASK_SCREEN} about ${MASK_SCREEN}.`);
    expect(s.reason).toBe(`A few words were missing: ${MASK_SCREEN}.`);
    expect(s.kind).toBe("verdict");
    // the Alexa plugin masks the speech ("name"); the directive goes out as built, screen marks and all
    const out = maskSpoken({ version: "1.0", sessionAttributes: { cardId: "demo:Acme" }, response: { outputSpeech: { type: "PlainText", text: "Ask Jordan Quill about Acme." }, reprompt: { outputSpeech: { type: "PlainText", text: "Say: Ask Jordan Quill." } }, directives: [d] } });
    expect(out.response.outputSpeech?.text).toBe(`Ask ${MASK_SPEECH} about ${MASK_SPEECH}.`);
    expect(out.response.reprompt?.outputSpeech.text).toBe(`Say: Ask ${MASK_SPEECH}.`);
    expect(out.sessionAttributes).toEqual({ cardId: "demo:Acme" }); // an id, never masked
    expect(out.response.directives).toEqual([d]);
  });
  it("leaves the document itself and the token alone", () => {
    setMaskTerms(["Mirror"]);
    const d = renderDirective(drillScreen({ resay: "Hello." }));
    expect(d.token).toBe("speakingMirror.drill");
    expect(d.document).toEqual(DOC);
    expect((d.datasources as { payload: { screen: Screen } }).payload.screen.brand).toBe(`Speaking ${MASK_SCREEN}`);
  });
});

describe("skill turns on a device with a screen (in-process demo hub)", () => {
  let s: HubServer;
  let hub: HubClient;
  const post = (p: string, b: unknown) => fetch(s.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
  const get = (p: string) => fetch(s.url + p).then((r) => r.json() as Promise<any>);
  beforeAll(async () => {
    const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p));
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
    hub = new HubClient(s.url);
  });
  afterAll(async () => s.close());
  const deps = (): SkillDeps => {
    let t = 0;
    return { hub, now: () => t, sleep: async (ms) => void ((t += ms), await new Promise((r) => setImmediate(r))), progressive: async () => true };
  };
  async function verdictReady(id: string, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await get(`/api/attempts/${id}`)).verdictReady) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it("voice-only: no directive on any turn, the same speech as with a screen", async () => {
    await post("/api/session/end", {});
    const voice = await handleAlexa(env("launch", { screen: false }), deps());
    expect(voice.envelope.response.directives).toBeUndefined();
    expect(voice.hubCalls).toEqual(["POST /api/session/start 200"]);
    await post("/api/session/end", {});
    const shown = await handleAlexa(env("launch"), deps());
    expect(shown.envelope.response.outputSpeech).toEqual(voice.envelope.response.outputSpeech);
    expect(shown.envelope.response.reprompt).toEqual(voice.envelope.response.reprompt);
    expect(shown.envelope.response.shouldEndSession).toBe(voice.envelope.response.shouldEndSession);
    for (const name of ["how-am-i-doing", "help", "next", "stop"]) expect(directives(await handleAlexa(env(name, { screen: false }), deps())), name).toEqual([]);
  });

  it("launch -> drill, attempt -> checking, early how did I do -> checking, then the verdict", async () => {
    await post("/api/session/end", {});
    const launch = await handleAlexa(env("launch"), deps());
    const card = (await get("/api/session")).openCard;
    expect(directives(launch)).toHaveLength(1);
    expect(directives(launch)[0]).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill" });
    expect(directives(launch)[0]!.document).toEqual(DOC);
    expect(screenOf(launch)).toMatchObject({ kind: "drill", sentence: card.resay });

    await post("/api/demo/scenario", { scenario: "verified" });
    const att = await handleAlexa(env("attempt", { attrs: launch.envelope.sessionAttributes, slot: card.resay }), deps());
    expect(screenOf(att)).toMatchObject({ kind: "checking", sentence: card.resay, status: "Bee is checking…" });
    expect(att.hubCalls).toEqual(["POST /api/attempt 202", "GET /api/session 200"]);

    const early = await handleAlexa(env("how-did-i-do", { attrs: att.envelope.sessionAttributes }), deps());
    expect(early.envelope.response.outputSpeech?.text).toBe("Bee hasn't sent that line yet. Ask me again in a few seconds.");
    expect(screenOf(early)).toMatchObject({ kind: "checking", sentence: card.resay });

    expect(await verdictReady(att.envelope.sessionAttributes!.attemptId as string)).toBe(true);
    const v = await handleAlexa(env("how-did-i-do", { attrs: early.envelope.sessionAttributes }), deps());
    const next = (await get("/api/session")).openCard;
    expect(directives(v)[0]!.token).toBe("speakingMirror.verdict");
    expect(screenOf(v)).toMatchObject({ headline: "Passed.", tone: "pass", checked: true, ...(next ? { kicker: "Next, say:", sentence: next.resay } : {}) });
  });

  it("a fail shows Not yet with the TV's reason and the same line to say again", async () => {
    let card = (await get("/api/session")).openCard;
    if (!card) card = (await post("/api/session/start", { by: "alexa" })).card;
    await post("/api/demo/scenario", { scenario: "bee-hears-filler" });
    const att = await handleAlexa(env("attempt", { attrs: { cardId: card.id }, slot: card.resay }), deps());
    const id = att.envelope.sessionAttributes!.attemptId as string;
    expect(await verdictReady(id)).toBe(true);
    const v = await handleAlexa(env("how-did-i-do", { attrs: att.envelope.sessionAttributes }), deps());
    const graded = await get(`/api/attempts/${id}`);
    expect(screenOf(v)).toMatchObject({ kind: "verdict", headline: "Not yet.", tone: "fail", checked: true, reason: `${tv.plainReason(tv.gradeFailure(graded.attempt.final.grade))}.`, kicker: "Say it again:", sentence: card.resay });
  });

  it("how am I doing -> progress; a one-shot leaves quickly (idleTimeout)", async () => {
    const oneShot = env("how-am-i-doing");
    oneShot.session!.new = true; // "Alexa, ask speech coach how am I doing"
    const r = await handleAlexa(oneShot, deps());
    const c = await get("/api/coach/now");
    expect(directives(r)[0]!.token).toBe("speakingMirror.progress");
    expect(screenOf(r)).toMatchObject({ kind: "progress", footerTv: "Open Speaking Mirror on this TV for details" });
    expect(screenOf(r).line.length).toBeGreaterThan(0);
    expect(c.narration.replace(/"([^"]*)"/g, "“$1”")).toContain(screenOf(r).line);
    expect(r.envelope.response.shouldEndSession).toBe(true);
    expect(directives(r)[0]!.document).toMatchObject({ settings: { idleTimeout: IDLE_AFTER_END_MS } });
  });

  it("no line, no drill, nothing to check: friendly empty states; help keeps an open line's screen", async () => {
    await post("/api/session/end", {});
    expect(screenOf(await handleAlexa(env("attempt", { slot: "the report is ready for review" }), deps()))).toMatchObject({ kind: "empty", headline: "No line to say right now." });
    expect(screenOf(await handleAlexa(env("next"), deps()))).toMatchObject({ kind: "empty", headline: "You’re not practising right now." });
    expect(screenOf(await handleAlexa(env("help"), deps()))).toMatchObject({ kind: "empty" });
    expect(directives(await handleAlexa(env("help", { attrs: { cardId: "demo:x" } }), deps()))).toEqual([]);
    expect(directives(await handleAlexa(env("fallback", { attrs: { cardId: "demo:x" } }), deps()))).toEqual([]);
    expect(directives(await handleAlexa(env("stop"), deps()))).toEqual([]);
  });

  it("the round's end: a summary screen", () => {
    expect(summaryScreen({ passed: 2, counted: 3, attempts: 3 })).toMatchObject({ headline: "That’s the round.", line: "2 of 3 lines passed, checked by Bee." });
    expect(summaryScreen({ passed: 0, counted: 0, attempts: 0 }).line).toBe("");
  });

  it("over HTTP, POST /alexa carries the directive for a screen device", async () => {
    await post("/api/session/end", {});
    const r = await fetch(s.url + "/alexa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env("launch")) });
    const j = (await r.json()) as AlexaResponseEnvelope;
    expect(j.response.directives?.[0]).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill", datasources: { payload: { screen: { kind: "drill" } } } });
  });
});

describe("POST /alexa with masking on (in-process demo hub)", () => {
  let s: HubServer;
  beforeAll(async () => {
    const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p));
    // "Lime" and "Coral" are also resource names in the document (@lime, @coral); "coach" is in the launch line
    s = await startHubServer({ maskTerms: ["Lime", "Coral", "coach"], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  });
  afterAll(async () => {
    await s.close();
    setMaskTerms([]);
  });
  it("masks what Alexa says, and sends the APL document as it is", async () => {
    await fetch(s.url + "/api/session/end", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const r = await fetch(s.url + "/alexa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env("launch")) });
    const j = (await r.json()) as AlexaResponseEnvelope;
    expect(j.response.outputSpeech?.text).toMatch(/^Speech name\. Say this:/);
    expect(j.response.reprompt?.outputSpeech.text).toMatch(/^Say:/);
    const d = j.response.directives?.[0];
    expect(d).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill" });
    expect(d!.document).toEqual(DOC);
    expect((d!.datasources as { payload: { screen: Screen } }).payload.screen).toMatchObject({ kind: "drill", brand: "Speaking Mirror" });
  });
});
