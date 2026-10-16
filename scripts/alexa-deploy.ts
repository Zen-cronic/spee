// Update the existing development Alexa skill (alexa/skill-id.json) to point at this hub.
//
//   PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy
//   npm run alexa:deploy -- --dry-run          # print the commands, run nothing
//   npm run alexa:deploy -- --status           # read-only: the skill's build status
//
// Steps (ASK CLI profile from alexa/skill-id.json, "default"):
//   1. writes out/alexa/skill.json: alexa/skill-package/skill.json with the endpoint
//      <PUBLIC_BASE_URL>/alexa (sslCertificateType Wildcard, which ngrok's certificate satisfies)
//   2. ask smapi update-skill-manifest      (development stage, the existing skill id)
//   3. ask smapi set-interaction-model      (each locale, from alexa/skill-package/interactionModels)
//   4. polls ask smapi get-skill-status until every locale's build SUCCEEDED (or FAILED; 180 s cap)
//   5. ask smapi set-skill-enablement       (testing on, development stage; idempotent)
// It never creates a skill, never touches the live stage and never starts a tunnel.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillConfig } from "../src/alexa/verify.js";
import { REPO_ROOT } from "../src/hub/static.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const statusOnly = args.includes("--status");
const cfg = readSkillConfig();
const skillId = process.env.ALEXA_SKILL_ID?.trim() || cfg.skillId;
const profile = process.env.ASK_PROFILE?.trim() || cfg.askProfile;
const ask = process.env.ASK_BIN || "ask";
const outDir = join(REPO_ROOT, "out/alexa");

function run(cmd: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const shown = `${ask} ${cmd.join(" ")}`;
  if (!opts.quiet) console.log(`$ ${shown}`);
  if (dry) return { ok: true, out: "" };
  const r = spawnSync(ask, cmd, { encoding: "utf8", cwd: REPO_ROOT });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) console.error(out.trim());
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

type BuildStatus = Record<string, { lastUpdateRequest?: { status?: string; errors?: unknown } }>;
function buildStatus(): BuildStatus | null {
  const r = run(["smapi", "get-skill-status", "-s", skillId, "--profile", profile], { quiet: true });
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.out) as { interactionModel?: BuildStatus }).interactionModel ?? {};
  } catch {
    return null;
  }
}
const summary = (s: BuildStatus) => Object.entries(s).map(([l, v]) => `${l} ${v.lastUpdateRequest?.status ?? "?"}`).join(", ");

if (statusOnly) {
  const s = buildStatus();
  if (!s) process.exit(1);
  console.log(`skill ${skillId} (profile ${profile}): ${summary(s)}`);
  process.exit(0);
}

const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
if (!/^https:\/\/[^/\s]+$/.test(base)) {
  console.error("alexa:deploy: set PUBLIC_BASE_URL to the tunnel's https origin, e.g.\n  ngrok http 8791\n  PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy");
  process.exit(2);
}
const endpoint = `${base}/alexa`;

// 1. the manifest with the endpoint substituted
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "alexa/skill-package/skill.json"), "utf8"));
manifest.manifest.apis.custom.endpoint = { uri: endpoint, sslCertificateType: "Wildcard" };
mkdirSync(outDir, { recursive: true });
const manifestFile = join(outDir, "skill.json");
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`alexa:deploy: skill ${skillId}, profile ${profile}, endpoint ${endpoint}${dry ? " (dry run)" : ""}`);

// 2. manifest
if (!run(["smapi", "update-skill-manifest", "-s", skillId, "-g", cfg.stage, "--manifest", `file:${manifestFile}`, "--profile", profile]).ok) process.exit(1);

// 3. interaction models
for (const locale of cfg.locales) {
  const file = join(REPO_ROOT, `alexa/skill-package/interactionModels/custom/${locale}.json`);
  if (!run(["smapi", "set-interaction-model", "-s", skillId, "-g", cfg.stage, "-l", locale, "--interaction-model", `file:${file}`, "--profile", profile]).ok) process.exit(1);
}

// 4. wait for the model builds
if (!dry) {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = buildStatus();
    if (s) {
      const line = summary(s);
      if (line !== last) console.log(`  build: ${line}`);
      last = line;
      const states = cfg.locales.map((l) => s[l]?.lastUpdateRequest?.status);
      if (states.some((x) => x === "FAILED")) {
        console.error(JSON.stringify(s, null, 1));
        process.exit(1);
      }
      if (states.every((x) => x === "SUCCEEDED")) break;
    }
    if (Date.now() - t0 > 180_000) {
      console.error("alexa:deploy: the model build did not finish in 180 s; check: npm run alexa:deploy -- --status");
      process.exit(1);
    }
  }
}

// 5. testing on (development stage)
run(["smapi", "set-skill-enablement", "-s", skillId, "-g", cfg.stage, "--profile", profile]);

console.log(`\nalexa:deploy: done. In the Alexa app (same Amazon account as the developer console): "Alexa, open speech coach".
The hub must be running with this endpoint reachable: curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${endpoint} -d '{}'  (expect 400: alexa_rejected)`);
