// The mirror is restyled from the Rack Board shells: no string may still say Rack Board (the bridge package is
// tv-voice-bridge since 0.3.0, so nothing is exempt).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const DIRS = ["tv/web", "tv/vega", "web/phone"];
const SKIP = new Set(["node_modules", "dist", "build", ".tmp"]);
const TEXT = /\.(ts|tsx|js|json|toml|html|css|md)$/;
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : TEXT.test(n) ? [join(d, n)] : [])) : [];

describe("Speaking Mirror branding", () => {
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
    expect(manifest).not.toMatch(/w3cmedia|media\.server/); // the mirror is silent: no media player
  });
  it("the wordmark is Spee on the TV and Speaking Mirror on the phone", () => {
    for (const f of ["tv/web/src/brand.ts", "tv/vega/src/brand.ts"]) expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/PRODUCT_NAME = ["']Spee["']/);
    expect(readFileSync(join(ROOT, "web/phone/src/brand.ts"), "utf8")).toMatch(/PRODUCT_NAME = ["']Speaking Mirror["']/);
  });
});
