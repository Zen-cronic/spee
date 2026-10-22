// The claims ledger (FACTS.md) against the docs and the code. Each check is a substring, a file's
// existence or a constant, never prose style: a doc may say more, but it may not say these
// differently.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREEN_TEXT } from "../src/alexa/apl.js";
import { POLL_BUDGET_MS } from "../src/alexa/skill.js";
import { DEFAULT_INVOCATION_NAMES } from "../src/alexa/skillPackage.js";
import { WRIST_TEXT_MAX } from "../src/hub/contract.js";
import { BEE_LINE_LAG_MS } from "../src/hub/live/demoScripts.js";
import { DEFAULT_POLICY } from "../src/hub/live/policy.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const FACTS = read("FACTS.md");
const pkg = JSON.parse(read("package.json")) as { name: string; engines?: { node?: string }; scripts: Record<string, string> };

// The two latency sentences, as FACTS.md states them.
function sentence(id: "L1" | "L2"): string {
  const m = FACTS.match(new RegExp(`^- \\*\\*${id}:\\*\\* (.+)$`, "m"));
  if (!m) throw new Error(`FACTS.md has no ${id} line`);
  return m[1]!.trim();
}
const LATENCY_DOCS = ["README.md", "docs/live.md", "docs/alexa.md", "docs/CONTRACT.md"];

// The docs a judge reads: the README, the ledger, docs/*.md and every Agent Skill.
function walk(dir: string, keep: (p: string) => boolean): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p, keep);
    return keep(p) ? [p] : [];
  });
}
const DOCS = ["README.md", "FACTS.md", ...walk("docs", (p) => p.endsWith(".md")), ...walk("skills", (p) => p.endsWith("SKILL.md"))];

describe("latency: one story, word for word", () => {
  const L1 = sentence("L1");
  const L2 = sentence("L2");
  it("FACTS.md states the two sentences", () => {
    expect(L1).toBe("Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it.");
    expect(L2).toBe("A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn.");
  });
  for (const doc of LATENCY_DOCS) {
    it(`${doc} carries L1 and L2 verbatim`, () => {
      const text = read(doc);
      expect(text).toContain(L1);
      expect(text).toContain(L2);
    });
  }
  it("the older, conflicting figures are gone from those docs", () => {
    for (const doc of LATENCY_DOCS) for (const old of ["15 to 19 s", "17 to 20 s", "5.4 to 6 s", "Bee's line takes 5 to 20 s"]) expect(read(doc), `${doc}: ${old}`).not.toContain(old);
  });
  it("the numbers match the measurement and the code", () => {
    expect(read("FRICTION_LOG.md")).toContain("4.3–14.7 s (median 5.4 s)");
    expect(BEE_LINE_LAG_MS).toBe(5400); // the demo replays the measured median
    expect(POLL_BUDGET_MS).toBeLessThan(8000); // the skill answers inside Alexa's 8 s
    expect(read("docs/CONTRACT.md")).toContain("**17.4 s**"); // the worked nudge example, "about 20 s"
  });
});

describe("the pre-registered check", () => {
  const prereg = JSON.parse(read("prereg/transfer.json")) as { registered_local: string; drilled: { habit: string }[]; control: { habit: string }[]; min_words_per_period: number };
  const date = prereg.registered_local.slice(0, 10);
  it("FACTS.md and the README give the registration date and the keys", () => {
    expect(date).toBe("2026-10-16");
    for (const doc of ["FACTS.md", "README.md"]) {
      const text = read(doc);
      expect(text, doc).toContain(date);
      for (const h of [...prereg.drilled, ...prereg.control]) expect(text, `${doc}: ${h.habit}`).toContain(`\`${h.habit}\``);
    }
    expect(prereg.drilled.map((h) => h.habit)).toEqual(["hedges", "filler:like"]);
    expect(prereg.control.map((h) => h.habit)).toEqual(["restart"]);
    expect(FACTS).toContain(`At least ${prereg.min_words_per_period} words`);
  });
  it("it is called a pilot, and nothing claims it proves anything", () => {
    expect(FACTS).toContain("two-tier pilot");
    expect(read("README.md")).toContain("two-tier pilot");
    for (const doc of DOCS) expect(read(doc), doc).not.toMatch(/\bproves?\b/i);
  });
});

describe("no novelty claim", () => {
  it("no doc calls the product the first of anything", () => {
    const banned = /\b(?:world'?s first|first[- ]ever|first of its kind|the first (?:wearable|speaking|realtime|real-time|live|ambient|coach|app|system|tool))\b/i;
    for (const doc of DOCS) expect(read(doc), doc).not.toMatch(banned);
  });
  it("the prior art is named in the ledger and the README", () => {
    for (const doc of ["FACTS.md", "README.md"]) expect(read(doc), doc).toContain("arXiv 2507.04238");
  });
});

describe("every command and path a doc names exists", () => {
  const scriptsOf = (dir: string) => Object.keys((JSON.parse(read(`${dir}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {});
  it("every `npm run <script>` (and `npm --prefix <dir> run <script>`)", () => {
    const missing: string[] = [];
    for (const doc of [...DOCS, "FRICTION_LOG.md"]) {
      for (const m of read(doc).matchAll(/\bnpm(?:\s+--prefix\s+(\S+))?\s+run\s+([A-Za-z0-9:_-]+)/g)) {
        const dir = m[1];
        const names = dir ? scriptsOf(dir) : Object.keys(pkg.scripts);
        if (!names.includes(m[2]!)) missing.push(`${doc}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("every backticked repo path (gitignored ones excepted)", () => {
    const ROOTS = /^(?:src|test|docs|scripts|alexa|tv|web|prereg|fixtures|coach|vendor|skills|day1)\//;
    const TOP = /^(?:[A-Z][A-Z_]*\.md|LICENSE|package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts)$/;
    const found: { doc: string; path: string }[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/`([^`\n]+)`/g)) {
        const p = m[1]!.trim().replace(/[.,;:]$/, "");
        if ((ROOTS.test(p) || TOP.test(p)) && !/[\s<>$|]/.test(p)) found.push({ doc, path: p });
      }
    }
    expect(found.length).toBeGreaterThan(50);
    const ignored = gitIgnored(found.map((f) => f.path));
    const missing = found.filter(({ doc, path }) => !ignored.has(path) && !pathExists(path, dirname(doc))).map(({ doc, path }) => `${doc}: ${path}`);
    expect(missing).toEqual([]);
  });
});

describe("the same words on every surface", () => {
  const trackers = (file: string) =>
    [...read(file).matchAll(/<Tracker\s+steps=\{\[([\s\S]*?)\]\}/g)].map((m) => [...m[1]!.matchAll(/label:\s*'([^']+)'/g)].map((l) => l[1]));
  it('the drill tracker reads "You said it, Checked by Bee, Result" on the TV and on Alexa screens', () => {
    expect([...SCREEN_TEXT.steps]).toEqual(["You said it", "Checked by Bee", "Result"]);
    for (const file of ["tv/web/src/views/LiveView.tsx", "tv/vega/src/views/LiveView.tsx"]) {
      const all = trackers(file);
      expect(all.length, file).toBeGreaterThan(0);
      for (const t of all) expect(t, file).toEqual([...SCREEN_TEXT.steps]);
    }
    expect(FACTS).toContain(`"${SCREEN_TEXT.steps.join(", ")}"`);
  });
  it('Alexa answers to "speech coach" (tried on a device), and the deploy adds "spee coach" and "spee"; the docs say which is which', () => {
    for (const locale of ["en-CA", "en-US"]) expect(JSON.parse(read(`alexa/skill-package/interactionModels/custom/${locale}.json`)).interactionModel.languageModel.invocationName).toBe("speech coach");
    expect([...DEFAULT_INVOCATION_NAMES]).toEqual(["speech coach", "spee coach", "spee"]);
    expect(read("README.md")).toContain('On Alexa, say "Alexa, ask Speech Coach to quiz me". `npm run alexa:deploy` also sets up "Spee Coach" and "Spee" as extra development skills, not yet tried on a device');
    expect(read("docs/alexa.md")).toContain('On Alexa, Spee answers to "speech coach", the skill tested on a real device. `npm run alexa:deploy` also sets up "spee coach" and "spee" as extra development skills, not yet tried on a device');
    expect(read("docs/alexa.md")).toContain('"speech coach" is the one tested on a real device.');
    for (const doc of ["README.md", "docs/alexa.md"]) expect(read(doc), doc).not.toContain("skill is called Speech Coach");
    // The phrase tried on a device stays on the TV and the phone page until the other names are tried.
    for (const f of ["tv/web/src/views/WeekView.tsx", "tv/vega/src/views/WeekView.tsx", "web/phone/index.html"]) expect(read(f), f).toContain("Alexa, ask Speech Coach to quiz me");
  });
});

describe("caps and limits quoted equal the code", () => {
  const P = DEFAULT_POLICY;
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  it("FACTS.md quotes DEFAULT_POLICY and WRIST_TEXT_MAX", () => {
    expect(FACTS).toContain(
      `no nudge in the first ${P.warmupMs / 1000} s of a conversation, ${P.cooldownMs / 60_000} min between any two nudges, ${P.ruleCooldownMs / 60_000} min between nudges of the same rule, ${P.capPerHour} per hour, ${P.capPerDay} per day, none from ${hh(P.quietHours.startHour)} to ${hh(P.quietHours.endHour)}`,
    );
    expect(FACTS).toContain(`at most ${WRIST_TEXT_MAX} characters`);
  });
  it("docs/live.md quotes the same numbers", () => {
    const live = read("docs/live.md");
    expect(live).toContain(`${P.cooldownMs / 60_000} min between any two nudges`);
    expect(live).toContain(`${P.ruleCooldownMs / 60_000} min between nudges of the same rule`);
    expect(live).toContain(`${P.capPerHour} per hour, ${P.capPerDay} per day`);
    expect(live).toContain(`no nudge in the first ${P.warmupMs / 1000} s of a conversation`);
    expect(live).toContain(`${hh(P.quietHours.startHour)} to ${hh(P.quietHours.endHour)}`);
    expect(live).toContain(`At most ${WRIST_TEXT_MAX} characters`);
  });
});

describe("runtime and the trust split", () => {
  it("the Node version in the docs equals engines.node, and the package is spee", () => {
    expect(pkg.name).toBe("spee");
    const engines = pkg.engines?.node ?? "";
    const m = read("README.md").match(/Needs Node (\d+(?:\.\d+)*) or later/);
    expect(m, "README states the Node version").not.toBeNull();
    expect(engines).toBe(`>=${m![1]}`);
    expect(FACTS).toContain(`Node ${m![1]} or later`);
    const [major, minor] = process.versions.node.split(".").map(Number);
    const [wantMajor, wantMinor = 0] = m![1]!.split(".").map(Number);
    expect(major! > wantMajor! || (major === wantMajor && minor! >= wantMinor), `running Node ${process.versions.node}`).toBe(true);
  });
  it("the files that count habits, grade and decide nudges import no model client", () => {
    const files = ["src/hub/habits.ts", "src/hub/grade.ts", "src/hub/fuzzy.ts", "src/hub/realCards.ts", "src/real/text.ts", "src/hub/live/rules.ts", "src/hub/live/policy.ts", "src/hub/live/window.ts"];
    for (const f of files) expect(read(f), f).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:llm|bedrock|anthropic|openai)/i);
  });
  it("Bee's wearer tag figure is the measured one", () => {
    expect(read("FRICTION_LOG.md")).toContain("(8/9 utterances;");
    expect(FACTS).toContain("8 of 9 lines");
    expect(read("README.md")).toContain("8 of 9 lines");
  });
});

// Helpers

// A path exists relative to the repo root or to the doc's own directory. A glob segment (`*`,
// `{a,b}`) or a trailing `**` needs at least one match.
function pathExists(p: string, docDir: string): boolean {
  for (const base of [ROOT, join(ROOT, docDir)]) {
    if (/[*{]/.test(p)) {
      if (globMatches(base, p)) return true;
    } else if (existsSync(join(base, p))) return true;
  }
  return false;
}
function globMatches(base: string, pattern: string): boolean {
  const alternatives = expandBraces(pattern.replace(/\/\*\*$/, ""));
  return alternatives.some((alt) => {
    if (!/\*/.test(alt)) return existsSync(join(base, alt));
    const dir = join(base, dirname(alt));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    const re = new RegExp(`^${alt.split("/").pop()!.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return readdirSync(dir).some((f) => re.test(f));
  });
}
function expandBraces(p: string): string[] {
  const m = p.match(/\{([^{}]+)\}/);
  if (!m) return [p];
  return m[1]!.split(",").flatMap((alt) => expandBraces(p.replace(m[0], alt)));
}
// Paths git ignores (private outputs, local files), which a doc may name but a clone never has.
function gitIgnored(paths: string[]): Set<string> {
  // Each path is also asked as a directory ("p/"), so a directory-only rule ("dist/") matches an
  // unbuilt directory. Answers are compared without the trailing slash.
  const norm = (p: string) => relative(ROOT, join(ROOT, p.trim()));
  const asked = [...new Set(paths.flatMap((p) => [p, `${p.replace(/\/+$/, "")}/`]))];
  const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: ROOT, input: asked.join("\n"), encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${r.stderr}`);
  const hits = new Set(r.stdout.split("\n").filter((l) => l.trim()).map(norm));
  return new Set(paths.filter((p) => hits.has(norm(p))));
}
