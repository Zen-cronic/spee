// Spee screens on Alexa devices with a display (src/alexa/apl.ts,
// alexa/apl/speaking-mirror.json): the manifest declares APL; the directive goes out only when the
// device lists Alexa.Presentation.APL; each screen's datasource; masking for the screen; the
// document's shape, bindings and palette (the TV's).
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APL_DATASOURCE, APL_DIRECTIVE, aplDocument, aplMode, bindParameters, checkingScreen, drillScreen, EMPTY, emptyScreen, gradeFailure, IDLE_AFTER_END_MS, plainReason, progressScreen, renderDirective, supportsApl, tracker, verdictScreen, viewportMode, wantsApl, type Screen } from "../src/alexa/apl.js";
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

// The viewports the real devices send: an Echo Show 8 and the Fire TV stick (hub log, 2026-10-22: "TV 1920x1080 RECTANGLE").
const VIEWPORTS = {
  hub: { mode: "HUB", shape: "RECTANGLE", pixelWidth: 1280, pixelHeight: 800, dpi: 160 },
  tv: { mode: "TV", shape: "RECTANGLE", pixelWidth: 1920, pixelHeight: 1080, dpi: 320 },
} as const;

// opts.screen: an APL device (default); opts.viewport: its viewport (default an Echo Show; null: none).
function env(name: string, opts: { attrs?: SessionAttributes; slot?: string; screen?: boolean; viewport?: keyof typeof VIEWPORTS | null } = {}): AlexaRequestEnvelope {
  const e = JSON.parse(read(`alexa/fixtures/${name}.json`)).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date().toISOString();
  if (opts.attrs) e.session!.attributes = { ...opts.attrs };
  if (opts.slot !== undefined) e.request.intent!.slots!.attempt!.value = opts.slot;
  if (opts.screen !== false) e.context!.System!.device = structuredClone(APL_DEVICE);
  const vp = opts.viewport === undefined ? (opts.screen === false ? null : "hub") : opts.viewport;
  if (vp) e.context!.Viewport = { ...VIEWPORTS[vp] };
  return e;
}
const directives = (r: { envelope: AlexaResponseEnvelope }) => r.envelope.response.directives ?? [];
type Sources = { spee: { screen: Screen } };
const screenOf = (r: { envelope: AlexaResponseEnvelope }): Screen => (directives(r)[0]!.datasources as Sources).spee.screen;

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
  summaryScreen({ counted: 3, attempts: 3, cards: 3, lines: { passed: 2, failed: 1, unverified: 0, pending: 0, untried: 0 } }),
];

describe("APL document", () => {
  it("is an APL document with a version, resources, the mark and a mainTemplate taking the spee datasource", () => {
    expect(DOC.type).toBe("APL");
    expect(DOC.version).toMatch(/^2023\.\d$/);
    expect(APL_DATASOURCE).toBe("spee");
    expect(DOC.mainTemplate.parameters).toEqual([APL_DATASOURCE]);
    expect(DOC.mainTemplate.items.length).toBeGreaterThan(0);
    expect(DOC.graphics.mark).toMatchObject({ type: "AVG", version: "1.2" });
    for (const item of DOC.graphics.mark.items) expect(["path", "group"]).toContain(item.type);
    expect(aplDocument()).toEqual(DOC);
  });

  it("every screen kind has its own branch, and every spee.screen binding exists in every screen's datasource", () => {
    const all = strings(DOC.mainTemplate).join("\n");
    for (const kind of ["drill", "checking", "verdict", "progress", "empty"]) expect(all).toContain(`'${kind}'`);
    expect(JSON.stringify(DOC)).not.toMatch(/\$\{[^}]*\bpayload\b/); // no binding through the pre-1.3 "payload" parameter
    const refs = [...new Set([...all.matchAll(/spee\.screen\.([A-Za-z]+)/g)].map((m) => m[1]!))];
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
    expect(s).toMatchObject({ kind: "drill", brand: "Spee", kicker: "Say this:", sentence: 'Say "hello" to the team.', hint: "Then ask: how did I do?", status: "" });
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
    expect(progressScreen(base)).toMatchObject({ kind: "progress", hero: "1.2", heroCaption: "Unsure words, out of every 100 words you said this week", line: "You said “I guess” less this week.", footerTv: "Open Spee on this TV for details" });
    expect(progressScreen({ ...base, week: { ...base.week, topHabit: null } })).toMatchObject({ hero: "2", heroCaption: "lines ready to practise" });
    expect(progressScreen({ ...base, week: { ...base.week, topHabit: null }, drills: { dueNow: 0, nextCardId: null } })).toMatchObject({ hero: "1200", heroCaption: "words Bee heard this week" });
  });
  it("caught up and no line: a friendly empty state", () => {
    expect(EMPTY.caughtUp()).toMatchObject({ kind: "empty", headline: "You’re all caught up.", hint: "Ask: how am I doing?" });
    expect(EMPTY.noLine()).toMatchObject({ kind: "empty", hint: "Say: quiz me" });
    // help: Bee grades the words it transcribed, never the sound of a voice
    expect(EMPTY.help()).toMatchObject({ kind: "empty", line: "Alexa gives you a line. Say it out loud, and Bee checks it from what it heard you say." });
    expect(JSON.stringify(EMPTY.help())).not.toMatch(/voice/i);
    expect(emptyScreen('a "b"', "c")).toMatchObject({ headline: "a “b”", line: "c" });
  });
});

describe("masking", () => {
  afterEach(() => setMaskTerms([]));
  it("masks every datasource string for a screen (▒▒▒); the plugin then masks only what Alexa says", () => {
    setMaskTerms(["Jordan Quill", "Acme"]);
    const d = renderDirective(verdictScreen({ kind: "fail", grade: grade({ checks: failed("content"), missing: ["Acme"] }), next: { resay: "Ask Jordan Quill about Acme." } }));
    const s = (d.datasources as Sources).spee.screen;
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
    setMaskTerms(["Spee", "Mirror"]);
    const d = renderDirective(drillScreen({ resay: "Hello." }));
    expect(d.token).toBe("speakingMirror.drill");
    expect(d.document).toEqual(DOC);
    expect((d.datasources as Sources).spee.screen.brand).toBe(MASK_SCREEN);
  });
});

describe("binding as a device binds (bindParameters)", () => {
  it("every screen's datasource reaches the document's spee parameter, so no screen renders blank", () => {
    for (const sc of ALL_SCREENS) {
      const d = renderDirective(sc);
      const bound = bindParameters(d.document as Record<string, unknown>, d.datasources as Record<string, unknown>);
      expect(bound, sc.kind).toEqual({ spee: { screen: sc } });
    }
  });
  it("the 2026-10-22 Fire TV blank screen: a parameter named payload gets the whole datasources object, one level above the screen", () => {
    const d = renderDirective(drillScreen({ resay: "I'll send the report on Friday." }));
    const legacy = { ...DOC, mainTemplate: { ...DOC.mainTemplate, parameters: ["payload"] } };
    // the old document bound payload.screen.*, and the old datasource was { payload: { screen } }: payload.screen was undefined
    expect((bindParameters(legacy, { payload: { screen: drillScreen({ resay: "x" }) } }).payload as Record<string, unknown>).screen).toBeUndefined();
    expect(bindParameters(legacy, d.datasources as Record<string, unknown>).payload).toBe(d.datasources);
    expect(Object.keys(d.datasources as object)).toEqual(["spee"]);
  });
});

describe("ALEXA_APL: which screens get a document", () => {
  const at = (viewport: keyof typeof VIEWPORTS | null, screen = true) => env("launch", { viewport, screen });
  it("parses off, on and hub-only; anything else is hub-only", () => {
    expect(aplMode(undefined)).toBe("hub-only");
    expect(aplMode("")).toBe("hub-only");
    expect(aplMode(" ON ")).toBe("on");
    expect(aplMode("off")).toBe("off");
    expect(aplMode("Hub-Only")).toBe("hub-only");
    expect(aplMode("true")).toBe("hub-only");
  });
  it("reads the request's viewport mode", () => {
    expect(viewportMode(at("tv"))).toBe("TV");
    expect(viewportMode(at("hub"))).toBe("HUB");
    expect(viewportMode(at(null))).toBeNull();
  });
  it("hub-only (the default): an Echo Show, never a TV or a device without a viewport; on: every APL device; off: none", () => {
    expect(wantsApl(at("hub"))).toBe(true);
    expect(wantsApl(at("tv"))).toBe(false);
    expect(wantsApl(at(null))).toBe(false);
    expect(wantsApl(at("tv"), "on")).toBe(true);
    expect(wantsApl(at(null), "on")).toBe(true);
    expect(wantsApl(at("hub"), "off")).toBe(false);
    for (const m of ["on", "off", "hub-only"] as const) expect(wantsApl(at("hub", false), m), m).toBe(false); // voice-only
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

  it("Fire TV, StartDrill: hub-only sends no document (voice only, the Spee app stays in front); on sends the TV screen with the line", async () => {
    const quiz = (o: Parameters<typeof env>[1]) => {
      const e = env("next", o);
      e.request.intent = { name: "StartDrillIntent", slots: {} } as never;
      return e;
    };
    await post("/api/session/end", {});
    const tvDefault = await handleAlexa(quiz({ viewport: "tv" }), deps());
    expect(tvDefault.routed.intent).toBe("StartDrillIntent");
    expect(tvDefault.envelope.response.directives).toBeUndefined();
    expect(tvDefault.hubCalls).toEqual(["POST /api/session/start 200"]); // no extra call for a screen
    await post("/api/session/end", {});
    const tvOn = await handleAlexa(quiz({ viewport: "tv" }), { ...deps(), aplMode: "on" });
    const card = (await get("/api/session")).openCard;
    expect(directives(tvOn)[0]).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill" });
    expect(screenOf(tvOn)).toMatchObject({ kind: "drill", brand: "Spee", kicker: "Say this:", sentence: card.resay, hint: "Then ask: how did I do?" });
    expect(screenOf(tvOn).steps).toEqual(tracker(0));
    // the speech, the reprompt and the open session are the same either way, and on an Echo Show
    await post("/api/session/end", {});
    const hub = await handleAlexa(quiz({}), deps());
    expect(screenOf(hub)).toMatchObject({ kind: "drill", sentence: card.resay });
    for (const r of [tvOn, hub]) {
      expect(r.envelope.response.outputSpeech).toEqual(tvDefault.envelope.response.outputSpeech);
      expect(r.envelope.response.reprompt).toEqual(tvDefault.envelope.response.reprompt);
      expect(r.envelope.response.shouldEndSession).toBe(false);
    }
    await post("/api/session/end", {});
    expect(directives(await handleAlexa(quiz({}), { ...deps(), aplMode: "off" }))).toEqual([]);
  });

  it("Fire TV under hub-only: no document on any turn", async () => {
    await post("/api/session/end", {});
    for (const name of ["launch", "how-am-i-doing", "help", "next", "attempt", "how-did-i-do", "stop"]) expect(directives(await handleAlexa(env(name, { viewport: "tv" }), deps())), name).toEqual([]);
  });

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
    expect(screenOf(r)).toMatchObject({ kind: "progress", footerTv: "Open Spee on this TV for details" });
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

  it("a lost attempt and a refused one show the open line again, never the stale checking screen", async () => {
    await post("/api/session/end", {});
    const card = (await post("/api/session/start", { by: "alexa" })).card;
    // "how did I do?" for an attempt the hub no longer has (a restart or a reset)
    const lost = await handleAlexa(env("how-did-i-do", { attrs: { cardId: card.id, attemptId: "att_gone" } }), deps());
    expect(lost.envelope.response.outputSpeech?.text).toBe("I lost track of that one. Say the line again.");
    expect(screenOf(lost)).toMatchObject({ kind: "drill", sentence: card.resay, status: "" });
    expect(screenOf(lost).steps).toEqual(tracker(0));
    // with no line open: nothing to check
    await post("/api/session/end", {});
    expect(screenOf(await handleAlexa(env("how-did-i-do", { attrs: { attemptId: "att_gone" } }), deps()))).toMatchObject({ kind: "empty", headline: "Nothing to check yet." });
    // an attempt the hub refused for a reason other than "no line open"
    const open = (await post("/api/session/start", { by: "alexa" })).card;
    const refusing = new HubClient(s.url, { fetch: async (u, init) => (String(u).endsWith("/api/attempt") ? new Response(JSON.stringify({ error: "attempt_refused", message: "x" }), { status: 409, headers: { "content-type": "application/json" } }) : fetch(u, init)) });
    const refused = await handleAlexa(env("attempt", { attrs: { cardId: open.id }, slot: open.resay }), { ...deps(), hub: refusing });
    expect(refused.envelope.response.outputSpeech?.text).toBe("I didn't catch that. Say the sentence again, or ask how did I do.");
    expect(screenOf(refused)).toMatchObject({ kind: "drill", sentence: open.resay });
    // voice-only: the same speech, no directive
    const voice = await handleAlexa(env("attempt", { attrs: { cardId: open.id }, slot: open.resay, screen: false }), { ...deps(), hub: refusing });
    expect(voice.envelope.response.outputSpeech).toEqual(refused.envelope.response.outputSpeech);
    expect(voice.envelope.response.directives).toBeUndefined();
  });

  it("the round's end: a summary screen", () => {
    expect(summaryScreen({ counted: 3, attempts: 3, cards: 3, lines: { passed: 2, failed: 1, unverified: 0, pending: 0, untried: 0 } })).toMatchObject({ headline: "That’s the round.", line: "2 of 3 lines passed, checked by Bee (1 not yet)." });
    // a line missed and then passed on a retry is one line, as on the TV (review L164)
    expect(summaryScreen({ counted: 3, attempts: 3, cards: 2, lines: { passed: 1, failed: 1, unverified: 0, pending: 0, untried: 0 } }).line).toBe("1 of 2 lines passed, checked by Bee (1 not yet).");
    expect(summaryScreen({ counted: 2, attempts: 2, cards: 2, lines: { passed: 2, failed: 0, unverified: 0, pending: 0, untried: 0 } }).line).toBe("2 of 2 lines passed, checked by Bee.");
    expect(summaryScreen({ counted: 0, attempts: 0, cards: 0, lines: { passed: 0, failed: 0, unverified: 0, pending: 0, untried: 0 } }).line).toBe("");
  });

  it("over HTTP, POST /alexa carries the directive for a screen device", async () => {
    await post("/api/session/end", {});
    const r = await fetch(s.url + "/alexa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env("launch")) });
    const j = (await r.json()) as AlexaResponseEnvelope;
    expect(j.response.directives?.[0]).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill", datasources: { spee: { screen: { kind: "drill" } } } });
  });
});

describe("ALEXA_APL in the Alexa plugin", () => {
  const saved = process.env.ALEXA_APL;
  afterEach(() => (saved === undefined ? delete process.env.ALEXA_APL : (process.env.ALEXA_APL = saved)));
  it("defaults to hub-only, reads ALEXA_APL, and says which in the hub health note", () => {
    delete process.env.ALEXA_APL;
    expect(createAlexaPlugin({ skillId: SKILL }).describe!().note).toContain("APL hub-only (Echo Show screens; a Fire TV gets voice only");
    process.env.ALEXA_APL = "on";
    expect(createAlexaPlugin({ skillId: SKILL }).describe!().note).toContain("APL on (every screen, the Fire TV too)");
    process.env.ALEXA_APL = "off";
    expect(createAlexaPlugin({ skillId: SKILL }).describe!().note).toContain("APL off (no screens)");
    process.env.ALEXA_APL = "bogus";
    expect(createAlexaPlugin({ skillId: SKILL }).describe!().note).toContain("APL hub-only");
  });
});

describe("POST /alexa with masking on (in-process demo hub)", () => {
  let s: HubServer;
  beforeAll(async () => {
    const plugins = createPlugins().map((p) => (p.name === "alexa" ? createAlexaPlugin({ skillId: SKILL }) : p));
    // "Lime" and "Coral" are also resource names in the document (@lime, @coral); "invoice" is in the demo's first line
    s = await startHubServer({ maskTerms: ["Lime", "Coral", "invoice"], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.05, stateDir: null }), fixtureV2: true, plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
  });
  afterAll(async () => {
    await s.close();
    setMaskTerms([]);
  });
  it("masks what Alexa says, and sends the APL document as it is", async () => {
    await fetch(s.url + "/api/session/end", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const r = await fetch(s.url + "/alexa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env("launch")) });
    const j = (await r.json()) as AlexaResponseEnvelope;
    expect(j.response.outputSpeech?.text).toBe('Spee. Say this: "I fixed the name retry job this morning."');
    expect(j.response.reprompt?.outputSpeech.text).toMatch(/^Say: "I fixed the name retry job/);
    const d = j.response.directives?.[0];
    expect(d).toMatchObject({ type: APL_DIRECTIVE, token: "speakingMirror.drill" });
    expect(d!.document).toEqual(DOC);
    expect((d!.datasources as Sources).spee.screen).toMatchObject({ kind: "drill", brand: "Spee" });
  });
});
