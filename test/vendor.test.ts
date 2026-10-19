// Every package (hub, web TV, Vega TV) must install the same vendored tv-voice-bridge tarball, and that
// tarball must be tracked. A stale `file:` path installs on this machine from node_modules but fails on a
// clean clone, and a version split leaves the TV on an older client than the hub.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = ["package.json", "tv/web/package.json", "tv/vega/package.json"];
const BRIDGE = "tv-voice-bridge";

const bridgeSpec = (pkg: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, pkg), "utf8"));
  return (j.dependencies?.[BRIDGE] ?? j.devDependencies?.[BRIDGE]) as string | undefined;
};

describe("vendored tv-voice-bridge", () => {
  const tarballs = PACKAGES.map((pkg) => {
    const spec = bridgeSpec(pkg);
    expect(spec, `${pkg} depends on ${BRIDGE}`).toMatch(/^file:/);
    return relative(ROOT, resolve(dirname(join(ROOT, pkg)), spec!.slice("file:".length)));
  });

  it("every package points at the same tarball", () => {
    expect(new Set(tarballs).size).toBe(1);
  });

  it("the tarball exists and is tracked by git", () => {
    const tgz = tarballs[0]!;
    expect(existsSync(join(ROOT, tgz))).toBe(true);
    expect(execFileSync("git", ["ls-files", "--error-unmatch", tgz], { cwd: ROOT }).toString().trim()).toBe(tgz);
  });

  it("each installed copy matches the tarball's version", () => {
    const want = tarballs[0]!.match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1];
    for (const pkg of PACKAGES) {
      const installed = join(ROOT, dirname(pkg), "node_modules", BRIDGE, "package.json");
      if (!existsSync(installed)) continue; // not installed in this checkout (e.g. CI without the TV deps)
      expect(JSON.parse(readFileSync(installed, "utf8")).version, pkg).toBe(want);
    }
  });
});
