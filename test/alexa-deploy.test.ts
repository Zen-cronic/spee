// npm run alexa:deploy sets up one development skill per invocation name (scripts/alexa-deploy.ts),
// each generated from the one checked-in package (src/alexa/skillPackage.ts). Every ask call here goes
// to a fake runner: no test runs the real ask CLI.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploy, DeployStop, notFound, parseNames, plan, type AskResult, type DeployConfig } from "../scripts/alexa-deploy.js";
import { checkInvocationName, DEFAULT_INVOCATION_NAMES, deployMarker, examplePhraseOk, loadSkillPackage, markedName, packageFor, swapName } from "../src/alexa/skillPackage.js";
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
  it("every generated manifest carries the deploy's marker with its own name, so the deploy can recognise it on the account", () => {
    for (const name of DEFAULT_INVOCATION_NAMES) {
      const pkg = packageFor(BASE, name, ENDPOINT);
      expect(pkg.manifest.manifest.publishingInformation.testingInstructions).toBe(`Development only. Say: open ${name}, repeat the sentence, then ask: how did I do. Set up by npm run alexa:deploy for the invocation name "${name}".`);
      expect(markedName(pkg.manifest)).toBe(name);
    }
    expect(markedName(BASE.manifest)).toBeNull(); // the checked-in copy has none
    expect(markedName({ manifest: { publishingInformation: { testingInstructions: 'Set up by npm run alexa:deploy for the invocation name "Spee Coach".' } } })).toBeNull(); // never a name Alexa would refuse
    expect(markedName(null)).toBeNull();
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

// A fake ask CLI over a fake account: creates numbered skills from the manifest it is given, keeps
// each skill's manifest and models, lists the development skills (a page at a time), reports builds
// as SUCCEEDED after one poll unless the skill's model is set up to fail, and records every call. The
// vendor list comes with a line of other text around its JSON, as a CLI notice would. `account`
// seeds skills already there: listed under `listed` ("Spee" by default), with the deploy's marker
// for `marker`, and a model whose invocation name is `model`. The existing skill (MAIN) is always
// there unless seeded otherwise; a skill that is not there can be neither read nor updated.
type Seed = { id: string; listed?: string; marker?: string; model?: string; stage?: string };
function fakeAsk(o: { failBuild?: (invocationName: string) => string | null; refuse?: (args: string[]) => boolean; vendors?: number; account?: Seed[]; createOut?: (id: string) => string; pageSize?: number } = {}) {
  const calls: string[][] = [];
  const skills = new Map<string, { listed: string; stage: string; manifest: unknown; model: string | null }>();
  const seeds: Seed[] = [...(o.account ?? []), ...((o.account ?? []).some((k) => k.id === MAIN) ? [] : [{ id: MAIN, model: "speech coach" }])];
  for (const k of seeds) skills.set(k.id, { listed: k.listed ?? "Spee", stage: k.stage ?? "development", manifest: { manifest: { publishingInformation: { locales: { "en-CA": { name: k.listed ?? "Spee" } }, testingInstructions: k.marker ? deployMarker(k.marker) : "Development only." } } }, model: k.model ?? null });
  const polls = new Map<string, number>();
  let n = 0;
  const ok = (out: unknown = ""): AskResult => ({ ok: true, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });
  const notFound: AskResult = { ok: false, out: "", err: "[Error]: 404 Not Found" };
  const run = (args: string[]): AskResult => {
    calls.push(args);
    if (o.refuse?.(args)) return { ok: false, out: "", err: "[Error]: 400 Bad Request" };
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    switch (args[1]) {
      case "get-vendor-list":
        return ok(`Some notice from the CLI\n${JSON.stringify({ vendors: Array.from({ length: o.vendors ?? 1 }, () => ({ name: "Me", id: "VENDOR", roles: ["ROLE_ADMINISTRATOR"] })) }, null, 2)}\n`);
      case "list-skills-for-vendor": {
        const all = [...skills.entries()].map(([skillId, k]) => ({ skillId, stage: k.stage, nameByLocale: { "en-CA": k.listed, "en-US": k.listed }, apis: ["custom"], publicationStatus: "DEVELOPMENT" }));
        const size = o.pageSize ?? 50;
        const from = args.includes("--next-token") ? Number(flag("--next-token")) : 0;
        const more = from + size < all.length;
        return ok({ skills: all.slice(from, from + size), isTruncated: more, ...(more ? { nextToken: String(from + size) } : {}) });
      }
      case "get-skill-manifest": {
        const k = skills.get(flag("-s"));
        return k ? ok(k.manifest) : notFound;
      }
      case "get-interaction-model": {
        const k = skills.get(flag("-s"));
        return k?.model ? ok({ interactionModel: { languageModel: { invocationName: k.model, intents: [] } } }) : notFound;
      }
      case "create-skill-for-vendor": {
        n++;
        const id = `amzn1.ask.skill.00000000-0000-0000-0000-00000000000${n}`;
        const manifest = JSON.parse(readFileSync(flag("--manifest").slice("file:".length), "utf8"));
        skills.set(id, { listed: manifest.manifest.publishingInformation.locales["en-CA"].name, stage: "development", manifest, model: null });
        return ok(o.createOut ? o.createOut(id) : { skillId: id });
      }
      case "update-skill-manifest": {
        const k = skills.get(flag("-s"));
        if (!k) return notFound;
        k.manifest = JSON.parse(readFileSync(flag("--manifest").slice("file:".length), "utf8"));
        return ok();
      }
      case "set-interaction-model": {
        const model = JSON.parse(readFileSync(flag("--interaction-model").slice("file:".length), "utf8"));
        const id = flag("-s");
        const k = skills.get(id) ?? { listed: "Spee", stage: "development", manifest: null, model: null };
        skills.set(id, { ...k, model: model.interactionModel.languageModel.invocationName });
        return ok();
      }
      case "get-skill-status": {
        const id = flag("-s");
        if (args.includes("--resource")) return ok({ manifest: { lastUpdateRequest: { status: "SUCCEEDED" } } });
        const k = (polls.get(id) ?? 0) + 1;
        polls.set(id, k);
        const failed = o.failBuild?.(skills.get(id)?.model ?? "");
        const status = k < 2 ? "IN_PROGRESS" : failed ? "FAILED" : "SUCCEEDED";
        return ok({ interactionModel: Object.fromEntries(LOCALES.map((l) => [l, { lastUpdateRequest: { status, ...(status === "FAILED" ? { errors: [{ message: failed }] } : {}) } }])) });
      }
      default:
        return ok();
    }
  };
  const mutating = () => calls.filter((c) => !["get-vendor-list", "list-skills-for-vendor", "get-skill-manifest", "get-interaction-model", "get-skill-status"].includes(c[1]!));
  return { run, calls, skills, sub: () => calls.map((c) => c[1]), creates: () => calls.filter((c) => c[1] === "create-skill-for-vendor").length, mutating };
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
    cfg = { names: [...DEFAULT_INVOCATION_NAMES], endpoint: ENDPOINT, profile: "default", stage: "development", locales: LOCALES, base: BASE, primary: { skillId: MAIN, source: "alexa/skill-id.json" }, envIds: [], localPath: join(dir, "skill-ids.local.json"), outDir: join(dir, "out") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("updates speech coach, looks on the account first, creates spee coach and spee, and the hub then accepts all three", async () => {
    const ask = fakeAsk({ account: [{ id: MAIN, model: "speech coach" }] }); // the existing skill: already recorded, so never read
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.created])).toEqual([["speech coach", true, false], ["spee coach", true, true], ["spee", true, true]]);
    expect(ask.sub()).toEqual([
      "get-vendor-list", "list-skills-for-vendor", // before any change: nothing on the account for spee coach or spee
      "update-skill-manifest", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
      "create-skill-for-vendor", "get-skill-status", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
      "create-skill-for-vendor", "get-skill-status", "set-interaction-model", "set-interaction-model", "get-skill-status", "get-skill-status", "set-skill-enablement",
    ]);
    expect(ask.calls[1]).toEqual(["smapi", "list-skills-for-vendor", "--profile", "default"]);
    for (const c of ask.calls) expect(c.slice(-2)).toEqual(["--profile", "default"]);
    expect(ask.calls[2]).toEqual(["smapi", "update-skill-manifest", "-s", MAIN, "-g", "development", "--manifest", `file:${join(cfg.outDir, "speech-coach/skill.json")}`, "--profile", "default"]);
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
    expect(lines).toContain('\nBefore creating anything, the deploy looks on the account for a skill already set up for "spee coach" and "spee", and checks that each recorded skill is still there:');
  });

  it("saves a new skill's id before its model is uploaded, so a later failure never loses it", async () => {
    const ask = fakeAsk({ refuse: (a) => a[1] === "set-interaction-model" && a.includes("en-US") && !a.includes(MAIN) });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[1]).toMatchObject({ step: "set-interaction-model", reason: "the en-US model was refused", created: true });
    expect(Object.keys(local().skills)).toEqual(["speech coach", "spee coach", "spee"]);
    // A second run reuses the saved skills: it checks they are still on the account, and creates none.
    const again = fakeAsk({ account: [...ask.skills.keys()].map((id) => ({ id })) });
    const r2 = await deploy(cfg, deps(again.run));
    expect(again.sub()).not.toContain("create-skill-for-vendor");
    expect(again.sub().slice(0, 3)).toEqual(["get-vendor-list", "list-skills-for-vendor", "update-skill-manifest"]); // all listed: nothing more to read
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
    expect(out).toMatch(/speech coach {2}UPDATE skill amzn1\.ask\.skill\.11111111… \(alexa\/skill-id\.json\)\n/);
    expect(out).toMatch(/spee coach {4}UPDATE skill amzn1\.ask\.skill\.22222222… \(alexa\/skill-ids\.local\.json\)\n/);
    expect(out).toMatch(/spee {10}CREATE a development skill, unless the account already has one for this name \(one word: .*the build may refuse it/);
    expect(out).not.toContain("Warning:"); // the local file is here
    // the account lookup comes before any change, and the dry run shows it
    expect(out).toContain('Before creating anything, the deploy looks on the account for a skill already set up for "spee", and checks that each recorded skill is still there:\n$ ask smapi get-vendor-list --profile default\n$ ask smapi list-skills-for-vendor --profile default');
    expect(out).toContain("$ ask smapi get-skill-manifest -s <a recorded skill the list does not show> -g development --profile default   (when it answers not found, that skill is gone, and its name is set up again)");
    expect(out).toContain("$ ask smapi get-skill-manifest -s <each development skill on the account> -g development --profile default");
    expect(out).toContain("$ ask smapi get-interaction-model -s <a skill listed as Spee whose manifest names none> -g development -l en-CA --profile default");
    expect(out.indexOf("list-skills-for-vendor")).toBeLessThan(out.indexOf("update-skill-manifest"));
    expect(out).toContain(`$ ask smapi create-skill-for-vendor --manifest file:${join(cfg.outDir, "spee/skill.json")} --profile default`);
    expect(out).toContain("$ ask smapi get-skill-status -s <new skill id> --resource manifest --profile default");
    expect(out).toContain("$ ask smapi set-skill-enablement -s <new skill id> -g development --profile default");
    expect(out).toContain("dry run, nothing was run or written\n  speech coach: would be updated\n  spee coach: would be updated\n  spee: would be CREATED, unless the account already has one");
    expect(existsSync(cfg.outDir)).toBe(false);
    expect(readFileSync(cfg.localPath, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["skill-ids.local.json"]);
  });

  it("--dry-run in a checkout with no local file warns that the names it would create may have been set up elsewhere", async () => {
    cfg.envIds = ["amzn1.ask.skill.22222222-2222-2222-2222-222222222222"];
    await deploy(cfg, deps(() => {
      throw new Error("a dry run must not call ask");
    }), { dry: true });
    const out = lines.join("\n");
    expect(out).toMatch(/spee coach {4}CREATE a development skill/);
    expect(out).toContain('Warning: this checkout has no alexa/skill-ids.local.json, so "spee coach" and "spee" have no recorded skill and are planned as CREATE. If they were set up from another checkout, run the deploy in the checkout the hub runs from (the hub reads only its own checkout\'s file). Before any create, the deploy reads every development skill on the account and adopts the one it set up for that name, by the marker in its manifest, so it makes no second skill for a name while it can read the account.');
    expect(out).toContain("$ ask smapi get-skill-manifest -s <each development skill on the account and each id in ALEXA_SKILL_IDS (1)> -g development --profile default");
    expect(existsSync(cfg.localPath)).toBe(false);
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

  // The account is the record of which skills exist, the local file a cache (review L193). Before a
  // create, the deploy reads the account and adopts a skill already set up for the name.
  const SPEE_COACH = "amzn1.ask.skill.22222222-2222-2222-2222-222222222222";
  const SPEE = "amzn1.ask.skill.33333333-3333-3333-3333-333333333333";
  const hubAccepts = () => {
    const config = join(dir, "skill-id.json");
    writeFileSync(config, JSON.stringify({ skillId: MAIN }));
    return resolveSkillIds({}, { config, local: cfg.localPath }).ids;
  };

  it("another checkout set the skills up (no local file here): they are found on the account by their marker and adopted, never created again", async () => {
    const OTHER = "amzn1.ask.skill.99999999-9999-9999-9999-999999999999"; // another project's skill: no marker, another listing
    const ask = fakeAsk({ account: [{ id: MAIN, model: "speech coach" }, { id: SPEE_COACH, marker: "spee coach", model: "spee coach" }, { id: SPEE, marker: "spee", model: "spee" }, { id: OTHER, listed: "Another skill", model: "spee coach" }] });
    const results = await deploy(cfg, deps(ask.run));
    expect(ask.creates()).toBe(0);
    expect(results.map((r) => [r.name, r.ok, r.created, r.skillId])).toEqual([["speech coach", true, false, MAIN], ["spee coach", true, false, SPEE_COACH], ["spee", true, false, SPEE]]);
    // every development skill not yet recorded is read; one with no marker under another listing is left alone
    expect(ask.calls.filter((c) => c[1] === "get-skill-manifest").map((c) => c[3])).toEqual([SPEE_COACH, SPEE, OTHER]);
    expect(ask.sub()).not.toContain("get-interaction-model"); // the marker named them, and the other skill is not Spee's
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": SPEE_COACH, spee: SPEE });
    expect(hubAccepts().sort()).toEqual([MAIN, SPEE_COACH, SPEE].sort());
    expect(lines.join("\n")).toContain('spee coach: found amzn1.ask.skill.22222222… on the account: update it');
    // every read comes before the first change
    const firstChange = ask.calls.findIndex((c) => c[1] === "update-skill-manifest");
    expect(ask.calls.slice(firstChange).some((c) => ["list-skills-for-vendor", "get-skill-manifest"].includes(c[1]!))).toBe(false);
  });

  it("a recorded skill no longer on the account: the deploy says so and adopts the one the account has for that name, else creates one, and saves it in place of the old id (review L197)", async () => {
    const GONE = "amzn1.ask.skill.55555555-5555-5555-5555-555555555555"; // deleted in the developer console
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "spee coach": GONE, spee: SPEE } }));
    const ask = fakeAsk({ account: [{ id: SPEE_COACH, marker: "spee coach" }, { id: SPEE, marker: "spee" }] });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.created, r.skillId])).toEqual([["speech coach", true, false, MAIN], ["spee coach", true, false, SPEE_COACH], ["spee", true, false, SPEE]]);
    expect(ask.creates()).toBe(0);
    expect(ask.calls.some((c) => c[1] === "update-skill-manifest" && c.includes(GONE))).toBe(false);
    expect(ask.calls.filter((c) => c.includes(GONE)).map((c) => c[1])).toEqual(["get-skill-manifest"]); // the one check, a read
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": SPEE_COACH, spee: SPEE });
    const out = lines.join("\n");
    expect(out).toContain("Before any change, the deploy checks that each recorded skill is still on the account:");
    expect(out).toContain("spee coach: the skill recorded in alexa/skill-ids.local.json (amzn1.ask.skill.55555555…) is not on the account any more, so this name is set up again, and the new id saved in its place");
    expect(out).toContain("spee coach: found amzn1.ask.skill.22222222… on the account: update it");
    // none on the account for it: one is created, and saved in place of the old id
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "spee coach": GONE } }));
    cfg.names = ["speech coach", "spee coach"];
    const bare = fakeAsk();
    const r2 = await deploy(cfg, deps(bare.run));
    expect(r2.map((r) => [r.name, r.ok, r.created])).toEqual([["speech coach", true, false], ["spee coach", true, true]]);
    expect(local().skills["spee coach"]).toBe(r2[1]!.skillId);
    expect(r2[1]!.skillId).not.toBe(GONE);
  });

  it("the checked-in skill no longer on the account: speech coach fails with that reason, and the other names go on", async () => {
    const ask = fakeAsk({ account: [{ id: SPEE_COACH, marker: "spee coach" }] });
    ask.skills.delete(MAIN); // deleted in the developer console
    cfg.names = ["speech coach", "spee coach"];
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.step])).toEqual([["speech coach", false, "account lookup"], ["spee coach", true, undefined]]);
    expect(results[0]!.reason).toBe("alexa/skill-id.json names amzn1.ask.skill.11111111…, which is not on the account of profile default. Fix alexa/skill-id.json, or set ALEXA_SKILL_ID to this name's skill");
    expect(ask.calls.some((c) => c[1] === "update-skill-manifest" && c.includes(MAIN))).toBe(false);
    expect(ask.creates()).toBe(0);
    cfg.primary = { skillId: MAIN, source: "ALEXA_SKILL_ID" };
    const r2 = await deploy(cfg, deps(ask.run));
    expect(r2[0]!.reason).toBe("ALEXA_SKILL_ID names amzn1.ask.skill.11111111…, which is not on the account of profile default. Set ALEXA_SKILL_ID to this name's skill");
  });

  // What the ask CLI prints for a failed SMAPI call: the error's message and detail, with its headers.
  const smapiError = (statusCode: number, message: string) => `[Error]: ${JSON.stringify({ message, detail: { name: "ServiceError", statusCode, headers: [{ key: "content-length", value: "404" }], response: { message } } }, null, 2)}`;

  it("only a not-found answer makes a recorded skill gone: a throttled read fails the lookup, so nothing is created and the recorded names deploy unchecked (review L207)", async () => {
    expect(notFound({ ok: false, out: "", err: smapiError(404, "The resource being requested is not found.") })).toBe(true);
    expect(notFound({ ok: false, out: "", err: "[Error]: 404 Not Found" })).toBe(true); // the fake's
    expect(notFound({ ok: false, out: "", err: smapiError(429, "Exceed the permitted request limit.") })).toBe(false); // a 404 in its headers is not enough
    expect(notFound({ ok: false, out: "", err: smapiError(401, "The auth token is invalid/expired or doesn't have access to the resource.") })).toBe(false);
    expect(notFound({ ok: false, out: "", err: "" })).toBe(false);
    // "spee coach" is under another vendor of the profile, so the default vendor's list leaves it
    // out, and its one manifest read is throttled
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "spee coach": SPEE_COACH } }));
    cfg.names = ["speech coach", "spee coach"];
    const ask = fakeAsk({ account: [{ id: SPEE_COACH, marker: "spee coach" }] });
    const run = (a: string[]): AskResult => {
      if (a[1] === "get-skill-manifest" && a.includes(SPEE_COACH)) return { ok: false, out: "", err: smapiError(429, "Exceed the permitted request limit.") };
      const r = ask.run(a);
      if (a[1] !== "list-skills-for-vendor") return r;
      const j = JSON.parse(r.out) as { skills: { skillId: string }[] };
      return { ...r, out: JSON.stringify({ ...j, skills: j.skills.filter((k) => k.skillId !== SPEE_COACH) }) };
    };
    const results = await deploy(cfg, deps(run));
    expect(results.map((r) => [r.name, r.ok, r.created, r.skillId])).toEqual([["speech coach", true, false, MAIN], ["spee coach", true, false, SPEE_COACH]]);
    expect(ask.creates()).toBe(0);
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": SPEE_COACH });
    const out = lines.join("\n");
    expect(out).toContain("could not check that amzn1.ask.skill.22222222… is still on the account: the names with no recorded skill are skipped, and the recorded skills deploy unchecked");
    expect(out).not.toContain("is not on the account any more");
  });

  it("a listing renamed since the skills were set up: they are still found by their marker and adopted, never created again (review L199)", async () => {
    const ask = fakeAsk({ account: [{ id: MAIN, model: "speech coach" }, { id: SPEE_COACH, listed: "Spee Coach", marker: "spee coach" }, { id: SPEE, listed: "Speech Coach", marker: "spee" }] });
    const results = await deploy(cfg, deps(ask.run));
    expect(ask.creates()).toBe(0);
    expect(results.map((r) => [r.name, r.ok, r.created, r.skillId])).toEqual([["speech coach", true, false, MAIN], ["spee coach", true, false, SPEE_COACH], ["spee", true, false, SPEE]]);
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": SPEE_COACH, spee: SPEE });
  });

  it("ids only in ALEXA_SKILL_IDS: each one's name is read from the account (its model, when its manifest has no marker), and the skill is adopted", async () => {
    cfg.envIds = [SPEE_COACH, SPEE];
    // made by hand, listed under another name: only ALEXA_SKILL_IDS points at them
    const ask = fakeAsk({ account: [{ id: SPEE_COACH, listed: "Speech Coach", model: "spee coach" }, { id: SPEE, listed: "Speech Coach", model: "Spee" }] });
    const results = await deploy(cfg, deps(ask.run));
    expect(ask.creates()).toBe(0);
    expect(results.map((r) => [r.name, r.ok, r.skillId])).toEqual([["speech coach", true, MAIN], ["spee coach", true, SPEE_COACH], ["spee", true, SPEE]]);
    expect(ask.calls.filter((c) => c[1] === "get-interaction-model").map((c) => c.slice(2, 8))).toEqual([["-s", SPEE_COACH, "-g", "development", "-l", "en-CA"], ["-s", SPEE, "-g", "development", "-l", "en-CA"]]);
    expect(local().skills).toEqual({ "speech coach": MAIN, "spee coach": SPEE_COACH, spee: SPEE });
  });

  it("an ALEXA_SKILL_IDS id the account cannot show, or a list that fails, skips every create; the recorded skills still deploy", async () => {
    cfg.envIds = [SPEE_COACH];
    const ask = fakeAsk(); // the account does not have it
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.step])).toEqual([["speech coach", true, undefined], ["spee coach", false, "account lookup"], ["spee", false, "account lookup"]]);
    expect(results[1]!.reason).toBe("could not read the manifest of amzn1.ask.skill.22222222…, so a create could make a second skill for its name");
    expect(ask.creates()).toBe(0);
    cfg.envIds = [];
    const down = fakeAsk({ refuse: (a) => a[1] === "list-skills-for-vendor" });
    const r2 = await deploy(cfg, deps(down.run));
    expect(r2.map((r) => [r.ok, r.step])).toEqual([[true, undefined], [false, "account lookup"], [false, "account lookup"]]);
    expect(down.creates()).toBe(0);
  });

  it("an ALEXA_SKILL_IDS entry that is not a skill id stops the deploy before any ask call", async () => {
    cfg.envIds = [SPEE_COACH, "amzn1.ask.skill.bad id"];
    const results = await deploy(cfg, deps(() => {
      throw new Error("a stopped deploy must not call ask");
    }));
    expect(results).toEqual([]);
    expect(lines).toEqual(["alexa:deploy: stopped: ALEXA_SKILL_IDS: entry 2 is not an amzn1.ask.skill.* id. Fix it, then run again. Nothing was run or written."]);
  });

  it("two skills on the account for one name: the deploy stops before any change and lists them", async () => {
    const ask = fakeAsk({ account: [{ id: SPEE_COACH, marker: "spee coach" }, { id: "amzn1.ask.skill.44444444-4444-4444-4444-444444444444", model: "spee coach" }, { id: SPEE, marker: "spee" }] });
    const results = await deploy(cfg, deps(ask.run));
    expect(results).toEqual([]);
    expect(ask.mutating()).toEqual([]); // reads only
    expect(existsSync(cfg.localPath)).toBe(false);
    expect(lines.at(-1)).toBe('\nalexa:deploy: stopped: the account has more than one skill set up for "spee coach" (amzn1.ask.skill.22222222…; amzn1.ask.skill.44444444…). Alexa could send that name to any of them. Delete the extra ones in the developer console, then run again. Nothing was changed; only read calls ran.');
  });

  it("a second skill on the account for a recorded name also stops the deploy, naming the recorded one, until the extra one is deleted (review L201)", async () => {
    const EXTRA = "amzn1.ask.skill.44444444-4444-4444-4444-444444444444"; // e.g. made by an older deploy in another checkout
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "spee coach": SPEE_COACH, spee: SPEE } }));
    const account = [{ id: SPEE_COACH, marker: "spee coach" }, { id: EXTRA, listed: "Speech Coach", marker: "spee coach" }, { id: SPEE, marker: "spee" }];
    const ask = fakeAsk({ account });
    expect(await deploy(cfg, deps(ask.run))).toEqual([]);
    expect(ask.mutating()).toEqual([]); // reads only
    expect(lines.at(-1)).toBe('\nalexa:deploy: stopped: the account has more than one skill set up for "spee coach" (amzn1.ask.skill.22222222…, the one in alexa/skill-ids.local.json; amzn1.ask.skill.44444444…). Alexa could send that name to any of them. Delete the extra ones in the developer console, then run again. Nothing was changed; only read calls ran.');
    expect(local().skills).toEqual({ "spee coach": SPEE_COACH, spee: SPEE });
    // the extra one deleted: the recorded skills deploy
    const r2 = await deploy(cfg, deps(fakeAsk({ account: account.filter((k) => k.id !== EXTRA) }).run));
    expect(r2.map((r) => [r.name, r.ok, r.skillId])).toEqual([["speech coach", true, MAIN], ["spee coach", true, SPEE_COACH], ["spee", true, SPEE]]);
  });

  it("a create that answers without a skill id stops the deploy; the next run finds that skill on the account and adopts it", async () => {
    const ask = fakeAsk({ createOut: () => "Skill created. Check the developer console.\n" });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.step, r.reason])).toEqual([
      ["speech coach", true, undefined, undefined],
      ["spee coach", false, "create-skill-for-vendor", "no skill id in the answer"],
      ["spee", false, "not run", "the deploy stopped at spee coach"],
    ]);
    expect(ask.creates()).toBe(1); // no create for spee after it
    expect(local().skills).toEqual({ "speech coach": MAIN });
    expect(lines.join("\n")).toContain("spee coach: STOPPED: the create answered without a skill id");
    // the next run: the skill the create made is on the account, with its marker
    const again = fakeAsk({ account: [...ask.skills.entries()].map(([id]) => ({ id, marker: "spee coach" })) });
    const r2 = await deploy(cfg, deps(again.run));
    expect(again.creates()).toBe(1); // spee only
    expect(r2.map((r) => [r.name, r.ok, r.created])).toEqual([["speech coach", true, false], ["spee coach", true, false], ["spee", true, true]]);
    expect(local().skills["spee coach"]).toBe("amzn1.ask.skill.00000000-0000-0000-0000-000000000001");
  });

  it("a local file that stops reading during the run stops the deploy at the next save, with its message and no stack trace, and never overwrites it (review L200)", async () => {
    const broken = '{ "skills": { "speech coach": "x", } }\n';
    // broken by hand after speech coach is ready: spee coach's create has run when its id is saved
    const ask = fakeAsk({ refuse: (a) => (a[1] === "set-skill-enablement" && a.includes(MAIN) && void writeFileSync(cfg.localPath, broken), false) });
    const results = await deploy(cfg, deps(ask.run));
    expect(results.map((r) => [r.name, r.ok, r.created, r.step, r.stopped])).toEqual([
      ["speech coach", true, false, undefined, undefined],
      ["spee coach", false, true, "save the skill id", true],
      ["spee", false, false, "not run", undefined],
    ]);
    expect(ask.creates()).toBe(1); // spee is not run
    expect(readFileSync(cfg.localPath, "utf8")).toBe(broken); // never overwritten
    const made = results[1]!.skillId!;
    expect(markedName(ask.skills.get(made)!.manifest as never)).toBe("spee coach"); // the next run adopts it by its marker
    const out = lines.join("\n");
    expect(out).toContain("spee coach: STOPPED while saving its skill id in alexa/skill-ids.local.json: skill-ids.local.json does not parse; none of its skills are accepted.");
    expect(out).toContain("The skill it just created (amzn1.ask.skill.00000000…) is on the account with the deploy's marker, so the next run adopts it. The names after it were not run.");
    expect(out).not.toContain("Nothing was run or written");
    expect(out).toContain("spee coach: STOPPED at save the skill id: alexa/skill-ids.local.json could not be read\n  spee: FAILED at not run: the deploy stopped at spee coach");
    // a recorded name stops before any ask call of its own
    writeFileSync(cfg.localPath, JSON.stringify({ skills: { "speech coach": MAIN, "spee coach": made } }));
    lines = [];
    const again = fakeAsk({ account: [{ id: made, marker: "spee coach" }], refuse: (a) => (a[1] === "set-skill-enablement" && a.includes(MAIN) && void writeFileSync(cfg.localPath, broken), false) });
    const r2 = await deploy(cfg, deps(again.run));
    expect(r2.map((r) => [r.name, r.ok, r.stopped ?? false])).toEqual([["speech coach", true, false], ["spee coach", false, true], ["spee", false, false]]);
    expect(again.calls.some((c) => c.includes(made))).toBe(false);
    expect(lines.join("\n")).toContain("Nothing was changed for this name. The names after it were not run.");
  });

  it("a local file that was lost to a parse error and moved aside: the next run adopts every skill from the account", async () => {
    const first = fakeAsk();
    await deploy(cfg, deps(first.run));
    const made = local().skills;
    rmSync(cfg.localPath);
    const again = fakeAsk({ account: Object.entries(made).filter(([n]) => n !== "speech coach").map(([n, id]) => ({ id: id as string, marker: n })), pageSize: 1 });
    const r2 = await deploy(cfg, deps(again.run));
    expect(again.creates()).toBe(0);
    expect(again.calls.filter((c) => c[1] === "list-skills-for-vendor").map((c) => c.slice(2, 4))).toEqual([["--profile", "default"], ["--next-token", "1"], ["--next-token", "2"]]); // a page at a time
    expect(r2.map((r) => r.skillId)).toEqual(Object.values(made));
    expect(local().skills).toEqual(made);
  });
});
