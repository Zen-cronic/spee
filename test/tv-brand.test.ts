// The TV app is restyled from the Rack Board shells: no string may still say Rack Board (the bridge package is
// tv-voice-bridge since 0.3.0, so nothing is exempt). The product was called Speaking Mirror until 2026-10-21
// and is now Spee: no source a person reads may still say Speaking Mirror. Identifiers keep the old name
// (com.beecoach.mirror, speakingmirror_*.vpkg, the npm names, the "speaking-mirror" WebSocket subprotocol,
// the speakingMirror.<kind> APL tokens), and none of them has a space, so the check skips them. One dated
// history line may name it: HISTORY_LINE, once, in the first lines of FRICTION_LOG.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const DIRS = ["tv/web", "tv/vega", "web/phone"];
// Every surface a person reads: the TV apps, the web pages, the Alexa skill and its screens, the hub, the
// Agent Skill, the docs and the top-level documents.
const NAME_DIRS = ["tv/web", "tv/vega", "web", "src/alexa", "alexa", "src/hub", "skills", "docs"];
const NAME_FILES = ["README.md", "FACTS.md", "FRICTION_LOG.md", "MEETINGS_REPORT.md", "REAL_DATA_REPORT.md", "package.json"];
const SKIP = new Set(["node_modules", "dist", "build", ".tmp", ".ask"]);
const TEXT = /\.(ts|tsx|mts|js|mjs|json|toml|html|css|md)$/;
// The friction log's note on the rename. Only this exact line, only near the top of FRICTION_LOG.md and
// only once is skipped; any other mention there still fails.
const HISTORY_LINE = "Spee was called Speaking Mirror until 2026-10-21; the entries before that date use the new name.";
const HISTORY_FILE = "FRICTION_LOG.md";
function withoutHistoryLine(rel: string, text: string): string {
  if (rel !== HISTORY_FILE) return text;
  const lines = text.split("\n");
  const at = lines.indexOf(HISTORY_LINE);
  if (at < 0 || at > 4) return text;
  lines.splice(at, 1);
  return lines.join("\n");
}
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : TEXT.test(n) ? [join(d, n)] : [])) : [];

describe("Spee branding", () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
  it("scans the TV apps and the phone page", () => {
    expect(files.length).toBeGreaterThan(30);
  });
  it('has no "Rack Board" or "rackboard" string', () => {
    const hits = files.filter((f) => /rack\s*board/i.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
  it("the Vega package is com.beecoach.mirror, titled Spee", () => {
    const manifest = readFileSync(join(ROOT, "tv/vega/manifest.toml"), "utf8");
    expect(manifest).toMatch(/title = "Spee"/);
    expect(manifest).toMatch(/id = "com\.beecoach\.mirror"/);
    expect(manifest).toMatch(/id = "com\.beecoach\.mirror\.main"/);
    const app = JSON.parse(readFileSync(join(ROOT, "tv/vega/app.json"), "utf8"));
    expect(app.name).toBe("com.beecoach.mirror.main");
    expect(app.displayName).toBe("Spee");
    expect(manifest).not.toMatch(/w3cmedia|media\.server/); // the TV app is silent: no media player
  });
  it('no surface a person reads still says "Speaking Mirror"', () => {
    const named = [...NAME_DIRS.flatMap((d) => walk(join(ROOT, d))), ...NAME_FILES.map((f) => join(ROOT, f))];
    expect(named.length).toBeGreaterThan(100);
    expect(named.some((f) => f.endsWith("alexa/apl/speaking-mirror.json")) && named.some((f) => f.endsWith("web/hub/index.html")) && named.some((f) => f.endsWith("skills/speaking-coach/SKILL.md"))).toBe(true);
    const hits = named.filter((f) => /speaking\s+mirror/i.test(withoutHistoryLine(f.slice(ROOT.length), readFileSync(f, "utf8"))));
    expect(hits.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
  it("the friction log says once, at the top, that Spee was called Speaking Mirror until 2026-10-21, and nothing else may", () => {
    const log = readFileSync(join(ROOT, HISTORY_FILE), "utf8").split("\n");
    expect(log.slice(0, 5)).toContain(HISTORY_LINE);
    expect(log.filter((l) => l === HISTORY_LINE)).toHaveLength(1);
    const mirror = (rel: string, text: string) => /speaking\s+mirror/i.test(withoutHistoryLine(rel, text));
    expect(mirror(HISTORY_FILE, `# Title\n\n${HISTORY_LINE}\n`)).toBe(false);
    expect(mirror(HISTORY_FILE, `# Title\n\n${HISTORY_LINE}\n\nThe Speaking Mirror app froze.\n`)).toBe(true);
    expect(mirror(HISTORY_FILE, `# Title\n\n${HISTORY_LINE} Also Speaking Mirror.\n`)).toBe(true);
    expect(mirror(HISTORY_FILE, `${"line\n".repeat(10)}${HISTORY_LINE}\n`)).toBe(true); // not at the top
    expect(mirror("README.md", `# Title\n\n${HISTORY_LINE}\n`)).toBe(true); // not in another file
  });
  it("every Alexa skill is listed as Spee, in every locale, whatever name it answers to", () => {
    const listing = JSON.parse(readFileSync(join(ROOT, "alexa/skill-package/skill.json"), "utf8")).manifest.publishingInformation.locales;
    expect(Object.keys(listing).sort()).toEqual(["en-CA", "en-US"]);
    for (const l of Object.values(listing) as { name: string }[]) expect(l.name).toBe("Spee");
  });
  it("the wordmark is Spee on the TV and the phone", () => {
    for (const f of ["tv/web/src/brand.ts", "tv/vega/src/brand.ts", "web/phone/src/brand.ts"]) expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/PRODUCT_NAME = ["']Spee["']/);
  });
});
