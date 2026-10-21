// Set up Spee's development Alexa skills, one per invocation name, all pointing at this hub.
//
//   PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy
//   npm run alexa:deploy -- --dry-run          # the plan and the commands; runs and writes nothing
//   npm run alexa:deploy -- --status           # read-only: each skill's build status
//   npm run alexa:deploy -- --names "speech coach,spee coach"   # or ALEXA_INVOCATION_NAMES
//
// Alexa takes one invocation name per skill and locale, so each name is its own development skill
// (docs/alexa.md, "Skill names"). The names, in priority order, default to "speech coach", "spee
// coach" and "spee". The checked-in model's name ("speech coach") is the existing skill
// (ALEXA_SKILL_ID, else alexa/skill-id.json); a name recorded in alexa/skill-ids.local.json
// (git-ignored) reuses its skill; any other name gets a new development skill.
//
// For each name, with the ASK CLI profile from alexa/skill-id.json ("default"):
//   1. writes out/alexa/<name>/: skill.json (the checked-in manifest with the endpoint
//      <PUBLIC_BASE_URL>/alexa, certificate Wildcard, and the example phrases in this name) and one
//      interaction model per locale (the checked-in model with this invocation name)
//   2. an existing skill: ask smapi update-skill-manifest
//      a new name: ask smapi get-vendor-list once (a check: create-skill-for-vendor takes the vendor id
//      from the ASK CLI profile), ask smapi create-skill-for-vendor, the new id saved to
//      alexa/skill-ids.local.json at once, then ask smapi get-skill-status --resource manifest until
//      the skill exists
//   3. ask smapi set-interaction-model      (each locale, development stage)
//   4. polls ask smapi get-skill-status until every locale's build SUCCEEDED (or FAILED; 180 s cap)
//   5. ask smapi set-skill-enablement       (testing on, development stage; idempotent)
// A name that fails at any step is reported and skipped, and the next name goes on. The exit status
// is 0 when the first name is ready. The hub accepts every skill in alexa/skill-ids.local.json and
// reads the file again when it changes, so it needs no restart. This script never touches the live
// stage, deletes nothing and never starts a tunnel.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../src/hub/atomic.js";
import { REPO_ROOT } from "../src/hub/static.js";
import { LOCAL_SKILLS_PATH, readLocalSkills, readSkillConfig } from "../src/alexa/verify.js";
import { checkInvocationName, DEFAULT_INVOCATION_NAMES, loadSkillPackage, normalizeName, packageFor, type SkillPackage } from "../src/alexa/skillPackage.js";

export type AskResult = { ok: boolean; out: string; err: string };
export type AskRunner = (args: string[]) => AskResult;

export interface DeployConfig {
  names: string[];
  endpoint: string;
  profile: string;
  stage: string;
  locales: string[];
  base: SkillPackage;
  primary: { skillId: string; source: string }; // the skill for base.invocationName
  localPath: string;
  outDir: string;
}
export interface DeployDeps {
  run: AskRunner;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs?: number;
  manifestTimeoutMs?: number;
  buildTimeoutMs?: number;
}

export interface PlannedSkill {
  name: string;
  skillId: string | null; // null: a new skill will be created
  from: string | null; // where the id comes from
  problems: string[]; // the name breaks Amazon's rules: skipped before any ask call
  oneWord: boolean;
}
export interface DeployResult {
  name: string;
  ok: boolean;
  created: boolean;
  skillId: string | null;
  step?: string;
  reason?: string;
}

const LOCAL_LABEL = "alexa/skill-ids.local.json";
const LOCAL_NOTE = "Written by npm run alexa:deploy: the development skill for each invocation name. Git-ignored; the hub accepts every skill here.";
const slug = (name: string) => name.replace(/[^a-z]+/g, "-");
export const shortId = (id: string) => `${id.slice(0, 24)}…`;

// Names from --names "a,b" / --names=a,b, else ALEXA_INVOCATION_NAMES, else the default three.
export function parseNames(args: string[], env: Record<string, string | undefined>): string[] {
  const i = args.findIndex((a) => a === "--names" || a.startsWith("--names="));
  const raw = i < 0 ? env.ALEXA_INVOCATION_NAMES : args[i]!.includes("=") ? args[i]!.slice(args[i]!.indexOf("=") + 1) : args[i + 1];
  const list = (raw ?? "").split(",").map(normalizeName).filter(Boolean);
  return [...new Set(list.length ? list : DEFAULT_INVOCATION_NAMES)];
}

export function plan(cfg: Pick<DeployConfig, "names" | "base" | "primary" | "localPath">): PlannedSkill[] {
  const local = readLocalSkills(cfg.localPath).skills;
  return cfg.names.map((name) => {
    const { problems, oneWord } = checkInvocationName(name);
    if (name === cfg.base.invocationName) return { name, skillId: cfg.primary.skillId, from: cfg.primary.source, problems, oneWord };
    if (local[name]) return { name, skillId: local[name]!, from: LOCAL_LABEL, problems, oneWord };
    return { name, skillId: null, from: null, problems, oneWord };
  });
}

export function describePlan(cfg: DeployConfig, planned: PlannedSkill[], print: (line: string) => void): void {
  print(`alexa:deploy: ${planned.length} name${planned.length === 1 ? "" : "s"}, profile ${cfg.profile}, stage ${cfg.stage}, locales ${cfg.locales.join(", ")}, endpoint ${cfg.endpoint}`);
  const w = Math.max(...planned.map((p) => p.name.length));
  for (const p of planned) {
    const what = p.problems.length
      ? `skipped: ${p.problems.join("; ")}`
      : p.skillId
        ? `existing skill ${shortId(p.skillId)} (${p.from}): update`
        : `no skill yet: create a development skill and save its id in ${LOCAL_LABEL}`;
    print(`  ${p.name.padEnd(w)}  ${what}${p.oneWord && !p.problems.length ? " (one word: Alexa allows it only for a registered brand, so the build may refuse it; the other names go on)" : ""}`);
  }
}

function saveLocal(path: string, name: string, skillId: string): void {
  const { skills } = readLocalSkills(path);
  if (skills[name] === skillId) return;
  writeJsonAtomic(path, { note: LOCAL_NOTE, skills: { ...skills, [name]: skillId } });
}

type LastUpdate = { lastUpdateRequest?: { status?: string; errors?: { message?: string }[] } };
const parse = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};
const errorText = (u: LastUpdate | undefined) =>
  (u?.lastUpdateRequest?.errors ?? [])
    .map((e) => e.message)
    .filter(Boolean)
    .join("; ") || "no detail";

export async function deploy(cfg: DeployConfig, deps: DeployDeps, opts: { dry?: boolean } = {}): Promise<DeployResult[]> {
  const pollMs = deps.pollMs ?? 4000;
  const planned = plan(cfg);
  describePlan(cfg, planned, deps.print);
  const ask = (args: string[], quiet = false): AskResult => {
    const full = [...args, "--profile", cfg.profile];
    if (!quiet || opts.dry) deps.print(`$ ask ${full.join(" ")}`);
    if (opts.dry) return { ok: true, out: "", err: "" };
    const r = deps.run(full);
    if (!r.ok && r.err.trim()) deps.print(r.err.trim());
    return r;
  };
  // Polls until `check` says done or failed, or the cap passes. A dry run prints the poll once.
  const poll = async (label: string, args: string[], check: (out: string) => { done: boolean; failed?: string }, capMs: number): Promise<{ ok: boolean; reason?: string }> => {
    if (opts.dry) {
      deps.print(`$ ask ${[...args, "--profile", cfg.profile].join(" ")}   (every ${pollMs / 1000} s until ${label}; ${capMs / 1000} s cap)`);
      return { ok: true };
    }
    const t0 = deps.now();
    for (;;) {
      await deps.sleep(pollMs);
      const r = ask(args, true);
      if (r.ok) {
        const c = check(r.out);
        if (c.failed) return { ok: false, reason: c.failed };
        if (c.done) return { ok: true };
      }
      if (deps.now() - t0 > capMs) return { ok: false, reason: `not done in ${capMs / 1000} s (check: npm run alexa:deploy -- --status)` };
    }
  };

  let vendorChecked: boolean | null = null;
  const results: DeployResult[] = [];
  for (const p of planned) {
    deps.print(`\n${p.name}:`);
    const fail = (step: string, reason: string, skillId = p.skillId, created = false): void => {
      deps.print(`  ${p.name}: FAILED at ${step}: ${reason}. Skipped; the other names go on.`);
      results.push({ name: p.name, ok: false, created, skillId, step, reason });
    };
    if (p.problems.length) {
      fail("name check", p.problems.join("; "));
      continue;
    }
    // 1. this name's package
    const pkg = packageFor(cfg.base, p.name, cfg.endpoint);
    const dir = join(cfg.outDir, slug(p.name));
    const manifestFile = join(dir, "skill.json");
    const modelFile = (l: string) => join(dir, `${l}.json`);
    if (!opts.dry) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(manifestFile, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
      for (const l of cfg.locales) writeFileSync(modelFile(l), `${JSON.stringify(pkg.models[l], null, 2)}\n`);
    }

    // 2. the skill: update the existing one, or create one
    let skillId = p.skillId;
    let created = false;
    if (skillId) {
      if (!opts.dry) saveLocal(cfg.localPath, p.name, skillId);
      if (!ask(["smapi", "update-skill-manifest", "-s", skillId, "-g", cfg.stage, "--manifest", `file:${manifestFile}`]).ok) {
        fail("update-skill-manifest", "the manifest update was refused");
        continue;
      }
    } else {
      if (vendorChecked === null) {
        const v = ask(["smapi", "get-vendor-list"]);
        const n = parse<{ vendors?: unknown[] }>(v.out)?.vendors?.length ?? 0;
        vendorChecked = opts.dry || (v.ok && n > 0);
        if (!opts.dry) deps.print(v.ok ? `  ${n} vendor${n === 1 ? "" : "s"} on this profile; create-skill-for-vendor uses the one ask configure saved` : "  could not list the vendors");
      }
      if (!vendorChecked) {
        fail("get-vendor-list", "this ASK CLI profile lists no vendor (run ask configure)");
        continue;
      }
      const c = ask(["smapi", "create-skill-for-vendor", "--manifest", `file:${manifestFile}`]);
      skillId = opts.dry ? "<new skill id>" : (/"skillId"\s*:\s*"(amzn1\.ask\.skill\.[A-Za-z0-9-]+)"/.exec(c.out)?.[1] ?? null);
      if (!c.ok || !skillId) {
        fail("create-skill-for-vendor", c.ok ? "no skill id in the answer" : "the create was refused");
        continue;
      }
      created = true;
      if (!opts.dry) {
        saveLocal(cfg.localPath, p.name, skillId);
        deps.print(`  created ${shortId(skillId)}; saved in ${LOCAL_LABEL}`);
      }
      const id = skillId;
      const m = await poll("the manifest SUCCEEDED", ["smapi", "get-skill-status", "-s", id, "--resource", "manifest"], (out) => {
        const s = parse<{ manifest?: LastUpdate }>(out)?.manifest;
        const st = s?.lastUpdateRequest?.status;
        return st === "FAILED" ? { done: false, failed: `manifest FAILED: ${errorText(s)}` } : { done: st === "SUCCEEDED" };
      }, deps.manifestTimeoutMs ?? 120_000);
      if (!m.ok) {
        fail("manifest", m.reason!, id, true);
        continue;
      }
    }
    const id = skillId;

    // 3. interaction models
    const refused = cfg.locales.find((l) => !ask(["smapi", "set-interaction-model", "-s", id, "-g", cfg.stage, "-l", l, "--interaction-model", `file:${modelFile(l)}`]).ok);
    if (refused) {
      fail("set-interaction-model", `the ${refused} model was refused`, id, created);
      continue;
    }

    // 4. the model builds
    let shown = "";
    const b = await poll("every locale SUCCEEDED", ["smapi", "get-skill-status", "-s", id], (out) => {
      const s = parse<{ interactionModel?: Record<string, LastUpdate> }>(out)?.interactionModel ?? {};
      const line = cfg.locales.map((l) => `${l} ${s[l]?.lastUpdateRequest?.status ?? "?"}`).join(", ");
      if (line !== shown) deps.print(`  build: ${line}`);
      shown = line;
      const bad = cfg.locales.find((l) => s[l]?.lastUpdateRequest?.status === "FAILED");
      if (bad) return { done: false, failed: `build FAILED in ${bad}: ${errorText(s[bad])}` };
      return { done: cfg.locales.every((l) => s[l]?.lastUpdateRequest?.status === "SUCCEEDED") };
    }, deps.buildTimeoutMs ?? 180_000);
    if (!b.ok) {
      fail("build", b.reason!, id, created);
      continue;
    }

    // 5. testing on
    if (!ask(["smapi", "set-skill-enablement", "-s", id, "-g", cfg.stage]).ok) {
      fail("set-skill-enablement", "testing could not be turned on (developer console, Test tab: Development)", id, created);
      continue;
    }
    results.push({ name: p.name, ok: true, created, skillId: id });
  }

  deps.print(`\nalexa:deploy: ${opts.dry ? "dry run, nothing was run or written" : "summary"}`);
  for (const r of results) {
    deps.print(`  ${r.name}: ${r.ok ? (opts.dry ? "planned" : `ready${r.created ? " (new skill)" : ""}`) : `FAILED at ${r.step}: ${r.reason}`}`);
  }
  const ready = results.filter((r) => r.ok);
  if (ready.length && !opts.dry) {
    deps.print(`In the Alexa app (the developer account): ${ready.map((r) => `"Alexa, ask ${r.name} to quiz me"`).join(" or ")}.`);
    deps.print(`The hub accepts every skill in ${LOCAL_LABEL} and reads it again when it changes. Check the endpoint: curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${cfg.endpoint} -d '{}'  (expect 400: alexa_rejected)`);
  }
  return results;
}

// The real runner: the ask CLI, its stdout as the answer.
export function askCli(bin = process.env.ASK_BIN || "ask"): AskRunner {
  return (args) => {
    const r = spawnSync(bin, args, { encoding: "utf8", cwd: REPO_ROOT });
    return { ok: r.status === 0, out: r.stdout ?? "", err: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
  };
}

export function deployConfig(args: string[], env: Record<string, string | undefined>, endpoint: string): DeployConfig {
  const skillCfg = readSkillConfig();
  const primaryEnv = env.ALEXA_SKILL_ID?.trim();
  return {
    names: parseNames(args, env),
    endpoint,
    profile: env.ASK_PROFILE?.trim() || skillCfg.askProfile,
    stage: skillCfg.stage,
    locales: skillCfg.locales,
    base: loadSkillPackage(skillCfg.locales),
    primary: { skillId: primaryEnv || skillCfg.skillId, source: primaryEnv ? "ALEXA_SKILL_ID" : "alexa/skill-id.json" },
    localPath: LOCAL_SKILLS_PATH,
    outDir: join(REPO_ROOT, "out/alexa"),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const baseOk = /^https:\/\/[^/\s]+$/.test(base);
  if (args.includes("--status")) {
    const cfg = deployConfig(args, process.env, "");
    const run = askCli();
    let bad = 0;
    for (const p of plan(cfg)) {
      if (!p.skillId) {
        console.log(`${p.name}: no skill yet`);
        continue;
      }
      const r = run(["smapi", "get-skill-status", "-s", p.skillId, "--profile", cfg.profile]);
      const s = parse<{ interactionModel?: Record<string, LastUpdate> }>(r.out)?.interactionModel;
      if (!r.ok || !s) bad++;
      console.log(`${p.name} (${shortId(p.skillId)}, profile ${cfg.profile}): ${s ? Object.entries(s).map(([l, v]) => `${l} ${v.lastUpdateRequest?.status ?? "?"}`).join(", ") : `no status${r.err.trim() ? `: ${r.err.trim()}` : ""}`}`);
    }
    return bad ? 1 : 0;
  }
  if (!baseOk && !dry) {
    console.error("alexa:deploy: set PUBLIC_BASE_URL to the tunnel's https origin, e.g.\n  ngrok http 8791\n  PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy");
    return 2;
  }
  const cfg = deployConfig(args, process.env, `${baseOk ? base : "https://<PUBLIC_BASE_URL>"}/alexa`);
  const results = await deploy(cfg, { run: askCli(), print: (l) => console.log(l), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now }, { dry });
  return results[0]?.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());
