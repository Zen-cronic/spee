// Set up Spee's development Alexa skills, one per invocation name, all pointing at this hub.
//
//   PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy
//   npm run alexa:deploy -- --dry-run          # the plan (each name UPDATE or CREATE) and the commands; runs and writes nothing
//   npm run alexa:deploy -- --status           # read-only: each skill's build status
//   npm run alexa:deploy -- --names "speech coach,spee coach"   # or ALEXA_INVOCATION_NAMES
//
// Alexa takes one invocation name per skill and locale, so each name is its own development skill
// (docs/alexa.md, "Skill names"). The names, in priority order, default to "speech coach", "spee
// coach" and "spee". The checked-in model's name ("speech coach") is the existing skill
// (ALEXA_SKILL_ID, else alexa/skill-id.json); a name recorded in alexa/skill-ids.local.json
// (git-ignored) reuses its skill. The account is the record of which skills exist and the local file
// a cache, so before creating a skill for any other name the deploy looks on the account, adopts a
// skill already set up for it, and stops when it finds two. A local file that does not parse, or holds
// an entry that is not a skill id, stops the deploy before any ask call, in a dry run too, and is
// never overwritten; so does an ALEXA_SKILL_IDS entry that is not a skill id.
//
// Before any change, when a name has no recorded skill (with the ASK CLI profile from
// alexa/skill-id.json, "default"):
//   ask smapi get-vendor-list                 (a check: create-skill-for-vendor takes the vendor id from the profile)
//   ask smapi list-skills-for-vendor          (each page, with --next-token)
//   ask smapi get-skill-manifest -s <id> -g development, for each development skill on the account
//     and each id in ALEXA_SKILL_IDS: the deploy's marker in its testing instructions names the
//     invocation name it was set up for, whatever the listing says. A skill listed as Spee, or in
//     ALEXA_SKILL_IDS, with no marker: ask smapi get-interaction-model -s <id> -g development -l en-CA
//     gives it. Any other skill with no marker is not Spee's and is left alone.
// For each name:
//   1. writes out/alexa/<name>/: skill.json (the checked-in manifest with the endpoint
//      <PUBLIC_BASE_URL>/alexa, certificate Wildcard, the example phrases in this name, and the
//      marker) and one interaction model per locale (the checked-in model with this invocation name)
//   2. an existing skill (recorded, or found on the account): ask smapi update-skill-manifest
//      a new name: ask smapi create-skill-for-vendor, the new id saved to alexa/skill-ids.local.json at
//      once, then ask smapi get-skill-status --resource manifest until the skill exists. A create that
//      answers without an id stops the deploy: the skill may exist, and the next run adopts it.
//   3. ask smapi set-interaction-model      (each locale, development stage)
//   4. polls ask smapi get-skill-status until every locale's build SUCCEEDED (or FAILED; 180 s cap)
//   5. ask smapi set-skill-enablement       (testing on, development stage; idempotent)
// A name that fails at any step is reported and skipped, and the next name goes on. The exit status
// is 0 when the first name is ready. A local file that can no longer be read when the deploy saves a
// skill id to it (changed during the run) stops the deploy there, with exit status 2: the names after
// it are not run, and a skill created a moment before is left for the next run to adopt by its
// marker. A hub running from this checkout accepts every skill in
// alexa/skill-ids.local.json and reads the file again when it changes, so it needs no restart. This
// script never touches the live stage, deletes nothing and never starts a tunnel.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../src/hub/atomic.js";
import { REPO_ROOT } from "../src/hub/static.js";
import { isSkillId, LOCAL_SKILLS_PATH, parseSkillIdList, readLocalSkills, readSkillConfig } from "../src/alexa/verify.js";
import { checkInvocationName, DEFAULT_INVOCATION_NAMES, loadSkillPackage, markedName, normalizeName, packageFor, type InteractionModel, type SkillManifest, type SkillPackage } from "../src/alexa/skillPackage.js";

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
  envIds: string[]; // ALEXA_SKILL_IDS, as given: their names are read from the account before any create
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
  stopped?: true; // the deploy stopped at this name: the local file could not be read to save its skill id
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

// A reason the deploy stops before any ask call or write. The message says what to fix.
export class DeployStop extends Error {}

// The skills recorded in the local file. A file that does not parse, has no "skills" object or holds
// an entry that is not a skill id stops the deploy: read as "no skills", it would make a second
// skill for a name it lost, and saving would overwrite the ids it still holds.
export function readLocalOrStop(path: string, done = "Nothing was run or written."): Record<string, string> {
  const { skills, warnings } = readLocalSkills(path);
  if (warnings.length) {
    throw new DeployStop(`${warnings.join("; ")}. It is the record of which skill serves each name, so it is never read as empty or overwritten. Fix it by hand (or move it aside: the next run then finds the skills on the account), then run again.${done ? ` ${done}` : ""}`);
  }
  return skills;
}

export function plan(cfg: Pick<DeployConfig, "names" | "base" | "primary" | "localPath"> & Partial<Pick<DeployConfig, "envIds">>): PlannedSkill[] {
  const local = readLocalOrStop(cfg.localPath);
  const env = parseSkillIdList((cfg.envIds ?? []).join(","));
  if (env.warnings.length) throw new DeployStop(`${env.warnings.join("; ").replace(/; skipped/g, "")}. Fix it, then run again. Nothing was run or written.`);
  return cfg.names.map((name) => {
    const { problems, oneWord } = checkInvocationName(name);
    if (name === cfg.base.invocationName) return { name, skillId: cfg.primary.skillId, from: cfg.primary.source, problems, oneWord };
    if (local[name]) return { name, skillId: local[name]!, from: LOCAL_LABEL, problems, oneWord };
    return { name, skillId: null, from: null, problems, oneWord };
  });
}

// Each name as UPDATE (a recorded skill) or CREATE (none recorded: the account is looked up first),
// and a warning when names would be created in a checkout with no local file: they may have been
// set up from another checkout, whose hub reads its own file.
export function describePlan(cfg: DeployConfig, planned: PlannedSkill[], print: (line: string) => void, localExists = existsSync(cfg.localPath)): void {
  print(`alexa:deploy: ${planned.length} name${planned.length === 1 ? "" : "s"}, profile ${cfg.profile}, stage ${cfg.stage}, locales ${cfg.locales.join(", ")}, endpoint ${cfg.endpoint}`);
  const w = Math.max(...planned.map((p) => p.name.length));
  for (const p of planned) {
    const what = p.problems.length
      ? `SKIPPED: ${p.problems.join("; ")}`
      : p.skillId
        ? `UPDATE skill ${shortId(p.skillId)} (${p.from})`
        : `CREATE a development skill, unless the account already has one for this name`;
    print(`  ${p.name.padEnd(w)}  ${what}${p.oneWord && !p.problems.length ? " (one word: Alexa allows it only for a registered brand, so the build may refuse it; the other names go on)" : ""}`);
  }
  const creating = planned.filter((p) => !p.problems.length && !p.skillId).map((p) => `"${p.name}"`);
  if (creating.length && !localExists) {
    print(`Warning: this checkout has no ${LOCAL_LABEL}, so ${creating.join(" and ")} ${creating.length === 1 ? "has" : "have"} no recorded skill and ${creating.length === 1 ? "is" : "are"} planned as CREATE. If ${creating.length === 1 ? "it was" : "they were"} set up from another checkout, run the deploy in the checkout the hub runs from (the hub reads only its own checkout's file). Before any create, the deploy reads every development skill on the account and adopts the one it set up for that name, by the marker in its manifest, so it makes no second skill for a name while it can read the account.`);
  }
}

// Read again before each save, so a skill another run recorded meanwhile is kept. A file that can no
// longer be read throws DeployStop: the deploy stops at that name (deploy's `record`).
function saveLocal(path: string, name: string, skillId: string): void {
  const skills = readLocalOrStop(path, "");
  if (skills[name] === skillId) return;
  writeJsonAtomic(path, { note: LOCAL_NOTE, skills: { ...skills, [name]: skillId } });
}

type LastUpdate = { lastUpdateRequest?: { status?: string; errors?: { message?: string }[] } };
// The JSON body the ask CLI prints, tolerating a line of other text around it.
const parse = <T>(text: string): T | null => {
  for (const t of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      return JSON.parse(t) as T;
    } catch {
      /* try the next */
    }
  }
  return null;
};
const errorText = (u: LastUpdate | undefined) =>
  (u?.lastUpdateRequest?.errors ?? [])
    .map((e) => e.message)
    .filter(Boolean)
    .join("; ") || "no detail";

// The account is the record of which skills exist; the local file is a cache of it. Before creating
// a skill for a name with no recorded one, the deploy reads the account: the manifest of every
// development skill on it and of every id in ALEXA_SKILL_IDS. The marker (packageFor) names the
// invocation name a skill was set up for, whatever its listing is called now (the listing name has
// changed before, and can be edited in the console). A skill with no marker is named by its model's
// invocation name only when it is listed under the package's name ("Spee") or in ALEXA_SKILL_IDS;
// any other is not Spee's. Ids already recorded are left out.
type SkillList = { skills?: { skillId?: unknown; stage?: unknown; nameByLocale?: Record<string, unknown> }[]; isTruncated?: boolean; nextToken?: string };
export type OnAccount = { byName: Map<string, string[]>; unnamed: string[] } | { failed: string };
const MAX_PAGES = 20;
export function lookOnAccount(ask: (args: string[]) => AskResult, cfg: DeployConfig, known: ReadonlySet<string>): OnAccount {
  const listedAs = new Set(Object.values(cfg.base.manifest.manifest.publishingInformation.locales).map((l) => l.name));
  const named = new Set(cfg.envIds.filter((id) => !known.has(id))); // named by their model when they carry no marker
  const ids = new Set(named);
  let token: string | null = null;
  for (let page = 1; ; page++) {
    const r = ask(["smapi", "list-skills-for-vendor", ...(token ? ["--next-token", token] : [])]);
    const j = r.ok ? parse<SkillList>(r.out) : null;
    if (!j || !Array.isArray(j.skills)) return { failed: "could not list the account's skills, so a create could make a second skill for a name" };
    for (const sk of j.skills) {
      if (sk.stage !== cfg.stage || !isSkillId(sk.skillId) || known.has(sk.skillId)) continue;
      ids.add(sk.skillId);
      if (Object.values(sk.nameByLocale ?? {}).some((n) => listedAs.has(String(n)))) named.add(sk.skillId);
    }
    if (!j.isTruncated || !j.nextToken) break;
    if (page >= MAX_PAGES) return { failed: `the account lists more than ${MAX_PAGES} pages of skills` };
    token = j.nextToken;
  }
  const byName = new Map<string, string[]>();
  const unnamed: string[] = [];
  for (const id of ids) {
    const m = ask(["smapi", "get-skill-manifest", "-s", id, "-g", cfg.stage]);
    const manifest = m.ok ? parse<SkillManifest>(m.out) : null;
    if (!manifest?.manifest) return { failed: `could not read the manifest of ${shortId(id)}, so a create could make a second skill for its name` };
    let name = markedName(manifest);
    if (!name && !named.has(id)) continue; // no marker and not listed as Spee: not one of Spee's skills
    if (!name) {
      const im = ask(["smapi", "get-interaction-model", "-s", id, "-g", cfg.stage, "-l", cfg.locales[0]!]);
      const invocation = im.ok ? parse<InteractionModel>(im.out)?.interactionModel?.languageModel?.invocationName : null;
      name = typeof invocation === "string" ? normalizeName(invocation) : null;
    }
    if (name) byName.set(name, [...(byName.get(name) ?? []), id]);
    else unnamed.push(id);
  }
  return { byName, unnamed };
}

export async function deploy(cfg: DeployConfig, deps: DeployDeps, opts: { dry?: boolean } = {}): Promise<DeployResult[]> {
  const pollMs = deps.pollMs ?? 4000;
  let planned: PlannedSkill[];
  try {
    planned = plan(cfg);
  } catch (e) {
    if (!(e instanceof DeployStop)) throw e;
    deps.print(`alexa:deploy: stopped: ${e.message}`);
    return [];
  }
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

  // Before any change: the vendor, then the account, for the names with no recorded skill. A name the
  // account already has a skill for adopts it; two skills for one name stop the deploy.
  const creating = planned.filter((p) => !p.problems.length && !p.skillId);
  let noCreate: { step: string; reason: string } | null = null;
  if (creating.length) {
    deps.print(`\nBefore creating anything, the deploy looks on the account for a skill already set up for ${creating.map((p) => `"${p.name}"`).join(", ")}:`);
    const v = ask(["smapi", "get-vendor-list"]);
    const n = parse<{ vendors?: unknown[] }>(v.out)?.vendors?.length ?? 0;
    if (!opts.dry) deps.print(v.ok ? `  ${n} vendor${n === 1 ? "" : "s"} on this profile; create-skill-for-vendor uses the one ask configure saved` : "  could not list the vendors");
    if (opts.dry) {
      const listedAs = [...new Set(Object.values(cfg.base.manifest.manifest.publishingInformation.locales).map((l) => l.name))].join(" or ");
      const env = cfg.envIds.length ? ` and each id in ALEXA_SKILL_IDS (${cfg.envIds.length})` : "";
      deps.print(`$ ask smapi list-skills-for-vendor --profile ${cfg.profile}   (each page, with --next-token)`);
      deps.print(`$ ask smapi get-skill-manifest -s <each development skill on the account${env}> -g ${cfg.stage} --profile ${cfg.profile}   (its testing instructions name the invocation name it was set up for)`);
      deps.print(`$ ask smapi get-interaction-model -s <a skill listed as ${listedAs}${env ? " or in ALEXA_SKILL_IDS" : ""} whose manifest names none> -g ${cfg.stage} -l ${cfg.locales[0]} --profile ${cfg.profile}`);
    } else if (!(v.ok && n > 0)) noCreate = { step: "get-vendor-list", reason: "this ASK CLI profile lists no vendor (run ask configure)" };
    else {
      const known = new Set(planned.map((p) => p.skillId).filter((id): id is string => !!id));
      const found = lookOnAccount((a) => ask(a), cfg, known);
      if ("failed" in found) {
        noCreate = { step: "account lookup", reason: found.failed };
        deps.print(`  ${found.failed}: the names with no recorded skill are skipped`);
      } else {
        const twice = creating.filter((p) => (found.byName.get(p.name) ?? []).length > 1);
        if (twice.length) {
          deps.print(`\nalexa:deploy: stopped: the account has more than one skill set up for ${twice.map((p) => `"${p.name}" (${found.byName.get(p.name)!.map(shortId).join(", ")})`).join(" and ")}. Delete the extra ones in the developer console, or record the right one in ${LOCAL_LABEL}, then run again. Nothing was changed; only read calls ran.`);
          return [];
        }
        for (const p of creating) {
          const id = found.byName.get(p.name)?.[0];
          if (id) Object.assign(p, { skillId: id, from: "found on the account" });
          deps.print(`  ${p.name}: ${id ? `found ${shortId(id)} on the account: update it, and save its id in ${LOCAL_LABEL}` : "none on the account: create one"}`);
        }
        for (const id of found.unnamed) deps.print(`  ${shortId(id)} names no invocation name (no marker and no model): left alone`);
      }
    }
  }

  const results: DeployResult[] = [];
  let stoppedAt: string | null = null;
  for (const p of planned) {
    if (stoppedAt) {
      results.push({ name: p.name, ok: false, created: false, skillId: p.skillId, step: "not run", reason: `the deploy stopped at ${stoppedAt}` });
      continue;
    }
    deps.print(`\n${p.name}:`);
    const fail = (step: string, reason: string, skillId = p.skillId, created = false): void => {
      deps.print(`  ${p.name}: FAILED at ${step}: ${reason}. Skipped; the other names go on.`);
      results.push({ name: p.name, ok: false, created, skillId, step, reason });
    };
    // Saves this name's skill id in the local file. A file changed during the run so that it no longer
    // reads stops the deploy here: the names after it are not run, and nothing is overwritten.
    const record = (id: string, created: boolean): boolean => {
      if (opts.dry) return true;
      try {
        saveLocal(cfg.localPath, p.name, id);
        return true;
      } catch (e) {
        if (!(e instanceof DeployStop)) throw e;
        const left = created
          ? `The skill it just created (${shortId(id)}) is on the account with the deploy's marker, so the next run adopts it.`
          : "Nothing was changed for this name.";
        deps.print(`  ${p.name}: STOPPED while saving its skill id in ${LOCAL_LABEL}: ${e.message} ${left} The names after it were not run.`);
        results.push({ name: p.name, ok: false, created, skillId: id, step: "save the skill id", reason: `${LOCAL_LABEL} could not be read`, stopped: true });
        stoppedAt = p.name;
        return false;
      }
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
      if (!record(skillId, false)) continue;
      if (!ask(["smapi", "update-skill-manifest", "-s", skillId, "-g", cfg.stage, "--manifest", `file:${manifestFile}`]).ok) {
        fail("update-skill-manifest", "the manifest update was refused");
        continue;
      }
    } else {
      if (noCreate) {
        fail(noCreate.step, noCreate.reason);
        continue;
      }
      const c = ask(["smapi", "create-skill-for-vendor", "--manifest", `file:${manifestFile}`]);
      if (!c.ok) {
        fail("create-skill-for-vendor", "the create was refused");
        continue;
      }
      skillId = opts.dry ? "<new skill id>" : (/"skillId"\s*:\s*"(amzn1\.ask\.skill\.[A-Za-z0-9-]+)"/.exec(c.out)?.[1] ?? null);
      if (!skillId) {
        // The skill may exist with nothing recording it: the next names wait, and the next run finds
        // it on the account by its marker.
        deps.print(`  ${p.name}: STOPPED: the create answered without a skill id, so the skill may exist with nothing recording it. The names after it were not run. Check the developer console (a development skill listed as Spee); the next run finds it on the account by its testing instructions and adopts it.`);
        results.push({ name: p.name, ok: false, created: false, skillId: null, step: "create-skill-for-vendor", reason: "no skill id in the answer" });
        stoppedAt = p.name;
        continue;
      }
      created = true;
      if (!record(skillId, true)) continue;
      if (!opts.dry) deps.print(`  created ${shortId(skillId)}; saved in ${LOCAL_LABEL}`);
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
    deps.print(`  ${r.name}: ${r.ok ? (opts.dry ? (r.created ? "would be CREATED, unless the account already has one" : "would be updated") : `ready${r.created ? " (new skill)" : ""}`) : `${r.stopped ? "STOPPED" : "FAILED"} at ${r.step}: ${r.reason}`}`);
  }
  const ready = results.filter((r) => r.ok);
  if (ready.length && !opts.dry) {
    deps.print(`In the Alexa app (the developer account): ${ready.map((r) => `"Alexa, ask ${r.name} to quiz me"`).join(" or ")}.`);
    deps.print(`A hub running from this checkout accepts every skill in ${LOCAL_LABEL} and reads it again when it changes; a hub in another checkout needs their ids in ALEXA_SKILL_IDS. Check the endpoint: curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${cfg.endpoint} -d '{}'  (expect 400: alexa_rejected)`);
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
    envIds: (env.ALEXA_SKILL_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
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
    let planned: PlannedSkill[];
    try {
      planned = plan(cfg);
    } catch (e) {
      if (!(e instanceof DeployStop)) throw e;
      console.error(`alexa:deploy: stopped: ${e.message}`);
      return 2;
    }
    for (const p of planned) {
      if (!p.skillId) {
        console.log(`${p.name}: no skill recorded in this checkout (a deploy looks on the account before creating one)`);
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
  return results.some((r) => r.stopped) ? 2 : results[0]?.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());
