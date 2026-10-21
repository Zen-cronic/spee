// npm run alexa:deploy sets up one development skill per invocation name (scripts/alexa-deploy.ts),
// each generated from the one checked-in package (src/alexa/skillPackage.ts). Every ask call here goes
// to a fake runner: no test runs the real ask CLI.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploy, DeployStop, parseNames, plan, type AskResult, type DeployConfig } from "../scripts/alexa-deploy.js";
import { checkInvocationName, DEFAULT_INVOCATION_NAMES, examplePhraseOk, loadSkillPackage, packageFor, swapName } from "../src/alexa/skillPackage.js";
import { readSkillConfig, resolveSkillIds } from "../src/alexa/verify.js";

const LOCALES = readSkillConfig().locales;
const BASE = loadSkillPackage(LOCALES);
const MAIN = "amzn1.ask.skill.11111111-1111-1111-1111-111111111111";
const ENDPOINT = "https://abc123.ngrok-free.app/alexa";

describe("the skill package for each name", () => {
  it("the checked-in package is the speech coach skill, in both locales", () => {
    expect(LOCALES).toEqual(["en-CA", "en-US"]);
    expect(BASE.invocationName).toBe("speech coach");
    expect(DEFAULT_INVOCATION_NAMES).toEqual(["speech coach", "spee coach", "spee"]);
  });
  it("changes only the invocation name, the example phrases, the testing instructions and the endpoint", () => {
    for (const name of DEFAULT_INVOCATION_NAMES) {
      const pkg = packageFor(BASE, name, ENDPOINT);
      for (const l of LOCALES) {
        expect(pkg.models[l]!.interactionModel.languageModel.invocationName).toBe(name);
        const model = structuredClone(pkg.models[l]!);
        model.interactionModel.languageModel.invocationName = BASE.invocationName;
        expect(model, `${name} ${l}`).toEqual(BASE.models[l]); // the same intents and samples
      }
      const m = structuredClone(pkg.manifest);
      expect(m.manifest.apis.custom.endpoint).toEqual({ uri: ENDPOINT, sslCertificateType: "Wildcard" });
      m.manifest.apis.custom.endpoint = BASE.manifest.manifest.apis.custom.endpoint;
      for (const [l, listing] of Object.entries(m.manifest.publishingInformation.locales)) {
        expect(listing.examplePhrases).toEqual(BASE.manifest.manifest.publishingInformation.locales[l]!.examplePhrases!.map((p) => swapName(p, "speech coach", name)));
        listing.examplePhrases = BASE.manifest.manifest.publishingInformation.locales[l]!.examplePhrases;
      }
      m.manifest.publishingInformation.testingInstructions = BASE.manifest.manifest.publishingInformation.testingInstructions;
      expect(m, name).toEqual(BASE.manifest);
    }
    expect(BASE.manifest.manifest.apis.custom.endpoint.uri).toBe("https://PUBLIC_BASE_URL.invalid/alexa"); // the checked-in copy is untouched
  });
  it("every skill's example phrases use its own invocation name and its own samples", () => {
    for (const name of DEFAULT_INVOCATION_NAMES) {
      const pkg = packageFor(BASE, name);
      for (const l of LOCALES) {
        const phrases = pkg.manifest.manifest.publishingInformation.locales[l]!.examplePhrases!;
        expect(phrases.length).toBeGreaterThan(0);
        for (const p of phrases) expect(examplePhraseOk(p, name, pkg.models[l]!), `${name}: ${p}`).toBe(true);
        for (const other of DEFAULT_INVOCATION_NAMES.filter((n) => n !== name && !name.includes(n) && !n.includes(name))) expect(phrases.join(" ").toLowerCase()).not.toContain(other);
      }
      expect(pkg.manifest.manifest.publishingInformation.testingInstructions).toContain(`open ${name},`);
    }
    expect(examplePhraseOk("Alexa, open spee", "speech coach", BASE.models["en-CA"]!)).toBe(false);
    expect(examplePhraseOk("Alexa, ask speech coach to sing", "speech coach", BASE.models["en-CA"]!)).toBe(false);
  });
  it("checks a name against Amazon's rules before any ask call", () => {
    expect(checkInvocationName("speech coach")).toEqual({ problems: [], oneWord: false });
    expect(checkInvocationName("spee coach")).toEqual({ problems: [], oneWord: false });
    expect(checkInvocationName("spee")).toEqual({ problems: [], oneWord: true });
    expect(checkInvocationName("open coach").problems).toEqual(['"open" is a launch phrase']);
    expect(checkInvocationName("coach for me").problems).toEqual(['"for" is a connecting word']);
    expect(checkInvocationName("spee app").problems).toEqual(['"app" is not allowed in an invocation name']);
    expect(checkInvocationName("spee-coach 2").problems).toContain("use lower-case letters and spaces only");
  });
  it("names come from --names, else ALEXA_INVOCATION_NAMES, else the default three", () => {
    expect(parseNames([], {})).toEqual(DEFAULT_INVOCATION_NAMES);
    expect(parseNames(["--dry-run", "--names", " Speech  Coach ,spee coach,speech coach"], {})).toEqual(["speech coach", "spee coach"]);
    expect(parseNames(["--names=spee coach"], { ALEXA_INVOCATION_NAMES: "spee" })).toEqual(["spee coach"]);
    expect(parseNames([], { ALEXA_INVOCATION_NAMES: "spee" })).toEqual(["spee"]);
  });
});

// A fake ask CLI: creates numbered skills, reports builds as SUCCEEDED after one poll unless the
// skill's model is set up to fail, and records every call. The vendor list comes with a line of other
// text around its JSON, as a CLI notice would.
function fakeAsk(o: { failBuild?: (invocationName: string) => string | null; refuse?: (args: string[]) => boolean; vendors?: number } = {}) {
  const calls: string[][] = [];
  const models = new Map<string, string>(); // skill id -> invocation name
  const polls = new Map<string, number>();
  let n = 0;
  const ok = (out: unknown = ""): AskResult => ({ ok: true, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });
  const run = (args: string[]): AskResult => {
    calls.push(args);
    if (o.refuse?.(args)) return { ok: false, out: "", err: "[Error]: 400 Bad Request" };
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    switch (args[1]) {
      case "get-vendor-list":
        return ok(`Some notice from the CLI\n${JSON.stringify({ vendors: Array.from({ length: o.vendors ?? 1 }, () => ({ name: "Me", id: "VENDOR", roles: ["ROLE_ADMINISTRATOR"] })) }, null, 2)}\n`);
      case "create-skill-for-vendor":
        n++;
        return ok({ skillId: `amzn1.ask.skill.00000000-0000-0000-0000-00000000000${n}` });
      case "set-interaction-model": {
        const model = JSON.parse(readFileSync(flag("--interaction-model").slice("file:".length), "utf8"));
        models.set(flag("-s"), model.interactionModel.languageModel.invocationName);
        return ok();
      }
      case "get-skill-status": {
        const id = flag("-s");
        if (args.includes("--resource")) return ok({ manifest: { lastUpdateRequest: { status: "SUCCEEDED" } } });
        const k = (polls.get(id) ?? 0) + 1;
        polls.set(id, k);
        const failed = o.failBuild?.(models.get(id) ?? "");
        const status = k < 2 ? "IN_PROGRESS" : failed ? "FAILED" : "SUCCEEDED";
        return ok({ interactionModel: Object.fromEntries(LOCALES.map((l) => [l, { lastUpdateRequest: { status, ...(status === "FAILED" ? { errors: [{ message: failed }] } : {}) } }])) });
      }
      default:
        return ok();
    }
  };
  return { run, calls, sub: () => calls.map((c) => c[1]) };
}

describe("alexa:deploy with a fake ask CLI", () => {
  let dir = "";
  let cfg: DeployConfig;
  let lines: string[] = [];
  let t = 0;
  const deps = (run: (a: string[]) => AskResult) => ({ run, print: (l: string) => void lines.push(l), sleep: async (ms: number) => void (t += ms), now: () => t });
  const local = () => JSON.parse(readFileSync(cfg.localPath, "utf8"));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alexa-deploy-"));
    lines = [];
    t = 0;
    cfg = { names: [...DEFAULT_INVOCATION_NAMES], endpoint: ENDPOINT, profile: "default", stage: "development", locales: LOCALES, base: BASE, primary: { skillId: MAIN, source: "alexa/skill-id.json" }, localPath: join(dir, "skill-ids.local.json"), outDir: join(dir, "out") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("updates speech coach, creates spee coach and spee, and the hub then accepts all three", async () => {
    const ask = fakeAsk();
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.created])).toEqual([["speech coach", true, false], ["spee coach", true, true], ["spee", true, true]]);
    expect(ask.sub()).toEqual([
      "update-skill-manifest", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
      "get-vendor-list", "create-skill-for-vendor", "get-skill-status", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
      "create-skill-for-vendor", "get-skill-status", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
    ]);
    for (const c of ask.calls) expect(c.slice(-2)).toEqual(["--profile", "default"]);
    expect(ask.calls[0]).toEqual(["smapi", "update-skill-manifest", "-s", MAIN, "-g", "development", "--manifest", `file:${join(cfg.outDir, "speech-coach/skill.json")}`, "--profile", "default"]);
    expect(ask.calls.find((c) => c[1] === "create-skill-for-vendor")).toEqual(["smapi", "create-skill-for-vendor", "--manifest", `file:${join(cfg.outDir, "spee-coach/skill.json")}`, "--profile", "default"]);
    expect(ask.calls.filter((c) => c[1] === "set-skill-enablement").map((c) => c.slice(2, 6))).toEqual([
      ["-s", MAIN, "-g", "development"],
      ["-s", results[1]!.skillId, "-g", "development"],
      ["-s", results[2]!.skillId, "-g", "development"],
    ]);
    // Each skill got its own name, from generated files.
    const uploaded = (id: string, l: string) => JSON.parse(readFileSync(join(cfg.outDir, { [MAIN]: "speech-coach", [results[1]!.skillId!]: "spee-coach", [results[2]!.skillId!]: "spee" }[id]!, `${l}.json`), "utf8"));
    for (const r of results) for (const l of LOCALES) expect(uploaded(r.skillId!, l).interactionModel.languageModel.invocationName).toBe(r.name);
    expect(JSON.parse(readFileSync(join(cfg.outDir, "spee/skill.json"), "utf8")).manifest.publishingInformation.locales["en-CA"].examplePhrases[0]).toBe("Alexa, open spee");
    // The local file names every skill, and the hub accepts every one.
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": results[1]!.skillId, spee: results[2]!.skillId });
    const config = join(dir, "skill-id.json");
    writeFileSync(config, JSON.stringify({ skillId: MAIN }));
    const hub = resolveSkillIds({}, { config, local: cfg.localPath });
    expect(hub.ids.sort()).toEqual(results.map((r) => r.skillId!).sort());
    expect(hub.names[results[2]!.skillId!]).toBe("spee");
    expect(lines.join("\n")).toContain('"Alexa, ask speech coach to quiz me" or "Alexa, ask spee coach to quiz me" or "Alexa, ask spee to quiz me"');
  });

  it("saves a new skill's id before its model is uploaded, so a later failure never loses it", async () => {
    const ask = fakeAsk({ refuse: (a) => a[1] === "set-interaction-model" && a.includes("en-US") && !a.includes(MAIN) });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[1]).toMatchObject({ step: "set-interaction-model", reason: "the en-US model was refused", created: true });
    expect(Object.keys(local().skills)).toEqual(["speech coach", "spee coach", "spee"]);
    // A second run reuses the saved skills: no new create.
    const again = fakeAsk();
    const r2 = await deploy(cfg, deps(again.run));
    expect(again.sub()).not.toContain("create-skill-for-vendor");
    expect(again.sub()).not.toContain("get-vendor-list");
    expect(r2.map((r) => r.skillId)).toEqual(results.map((r) => r.skillId));
    expect(r2.every((r) => r.ok && !r.created)).toBe(true);
  });

  it("a name whose build fails is reported and skipped; the others go on", async () => {
    const ask = fakeAsk({ failBuild: (name) => (name === "spee" ? "Invocation name must be at least 2 words" : null) });
    cfg.names = ["speech coach", "spee", "spee coach"];
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok])).toEqual([["speech coach", true], ["spee", false], ["spee coach", true]]);
    expect(results[1]).toMatchObject({ step: "build", reason: "build FAILED in en-CA: Invocation name must be at least 2 words" });
    expect(ask.calls.filter((c) => c[1] === "set-skill-enablement")).toHaveLength(2); // not for the failed one
    expect(lines.join("\n")).toContain("spee: FAILED at build: build FAILED in en-CA: Invocation name must be at least 2 words");
    expect(local().skills.spee).toBe(results[1]!.skillId); // kept, so a retry reuses it
  });

  it("a refused create, a build that never finishes and a refused manifest update are each one name's failure", async () => {
    const ask = fakeAsk({ refuse: (a) => a[1] === "create-skill-for-vendor" || (a[1] === "update-skill-manifest" && a.includes(MAIN)) });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.step])).toEqual([["speech coach", false, "update-skill-manifest"], ["spee coach", false, "create-skill-for-vendor"], ["spee", false, "create-skill-for-vendor"]]);
    expect(existsSync(cfg.localPath) ? Object.keys(local().skills) : []).toEqual(["speech coach"]);
    const stuck = fakeAsk({ failBuild: () => null });
    const slow = { ...deps((a) => (a[1] === "get-skill-status" && !a.includes("--resource") ? { ok: true, out: JSON.stringify({ interactionModel: { "en-CA": { lastUpdateRequest: { status: "IN_PROGRESS" } } } }), err: "" } : stuck.run(a))), buildTimeoutMs: 20_000 };
    cfg.names = ["spee coach"];
    const r = await deploy(cfg, slow);
    expect(r[0]).toMatchObject({ ok: false, step: "build", reason: "not done in 20 s (check: npm run alexa:deploy -- --status)" });
  });

  it("no vendor on the profile: new names are skipped, the existing skill still deploys", async () => {
    const ask = fakeAsk({ vendors: 0 });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.ok, r.step])).toEqual([[true, undefined], [false, "get-vendor-list"], [false, "get-vendor-list"]]);
    expect(ask.sub().filter((s) => s === "get-vendor-list")).toHaveLength(1);
    expect(ask.sub()).not.toContain("create-skill-for-vendor");
  });

  it("a name that breaks Amazon's rules is skipped before any ask call", async () => {
    const ask = fakeAsk();
    cfg.names = ["open spee", "spee coach"];
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.step])).toEqual([["open spee", false, "name check"], ["spee coach", true, undefined]]);
    expect(ask.calls.some((c) => c.join(" ").includes("open spee"))).toBe(false);
  });

  it("--dry-run prints the plan and every command, and runs and writes nothing", async () => {
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "spee coach": "amzn1.ask.skill.22222222-2222-2222-2222-222222222222" } }));
    const before = readFileSync(cfg.localPath, "utf8");
    const results = await deploy(cfg, deps(() => {
      throw new Error("a dry run must not call ask");
    }), { dry: true });
    expect(results.every((r) => r.ok)).toBe(true);
    const out = lines.join("\n");
    expect(out).toMatch(/speech coach {2}existing skill amzn1\.ask\.skill\.11111111… \(alexa\/skill-id\.json\): update/);
    expect(out).toMatch(/spee coach {4}existing skill amzn1\.ask\.skill\.22222222… \(alexa\/skill-ids\.local\.json\): update/);
    expect(out).toMatch(/spee {10}no skill yet: create a development skill .*\(one word: .*the build may refuse it/);
    expect(out).toContain("$ ask smapi get-vendor-list --profile default");
    expect(out).toContain(`$ ask smapi create-skill-for-vendor --manifest file:${join(cfg.outDir, "spee/skill.json")} --profile default`);
    expect(out).toContain("$ ask smapi get-skill-status -s <new skill id> --resource manifest --profile default");
    expect(out).toContain("$ ask smapi set-skill-enablement -s <new skill id> -g development --profile default");
    expect(out).toContain("dry run, nothing was run or written");
    expect(existsSync(cfg.outDir)).toBe(false);
    expect(readFileSync(cfg.localPath, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["skill-ids.local.json"]);
  });

  // A local file the deploy cannot trust (review L193): read as "no skills", it would create a second
  // skill for each name it lost, and saving would overwrite the ids it still holds.
  const BAD_FILES: [string, string][] = [
    ["does not parse (a trailing comma)", `{ "skills": { "speech coach": "${MAIN}", "spee coach": "amzn1.ask.skill.22222222-2222-2222-2222-222222222222", } }\n`],
    ["has an entry that is not a skill id", JSON.stringify({ skills: { "spee coach": "amzn1.ask.skill.22222222-2222-2222-2222-222222222222", spee: "not-an-id" } })],
    ["has no skills object", JSON.stringify({ spee: "amzn1.ask.skill.33333333-3333-3333-3333-333333333333" })],
  ];
  for (const [what, text] of BAD_FILES) {
    it(`a local file that ${what} stops the deploy before any ask call, in a real run and a dry run, and is never overwritten`, async () => {
      writeFileSync(cfg.localPath, text);
      for (const dry of [false, true]) {
        lines = [];
        const results = await deploy(cfg, deps(() => {
          throw new Error("a stopped deploy must not call ask");
        }), { dry });
        expect(results).toEqual([]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^alexa:deploy: stopped: skill-ids\.local\.json( does not parse|: the skill for "spee" is not an amzn1\.ask\.skill\.\* id| has no "skills" object)/);
        expect(lines[0]).toContain("never read as empty or overwritten");
        expect(lines[0]).toContain("Nothing was run or written.");
        expect(readFileSync(cfg.localPath, "utf8")).toBe(text);
        expect(existsSync(cfg.outDir)).toBe(false);
      }
      expect(() => plan(cfg)).toThrow(DeployStop);
    });
  }

  it("plan: the checked-in name is the existing skill, a recorded name reuses its skill, the rest are new", () => {
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { spee: "amzn1.ask.skill.33333333-3333-3333-3333-333333333333" } }));
    expect(plan(cfg).map((p) => [p.name, p.skillId, p.from, p.oneWord])).toEqual([
      ["speech coach", MAIN, "alexa/skill-id.json", false],
      ["spee coach", null, null, false],
      ["spee", "amzn1.ask.skill.33333333-3333-3333-3333-333333333333", "alexa/skill-ids.local.json", true],
    ]);
  });
});
