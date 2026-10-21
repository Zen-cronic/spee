// Copy the TV app's shared code into the Vega app (npm run tv:sync).
//
//   src/hub/contract.ts                      -> tv/web/src/contract.ts, tv/vega/src/contract.ts
//   tv/web/src/{views,components,mirror}/**  -> tv/vega/src/...   (stale Vega copies are removed)
//   tv/web/src/{theme,brand,motion}.ts       -> tv/vega/src/
//
// Platform files stay per app: App.tsx, focus.tsx, debug.tsx, platform/** (fonts, config, remote).
// `--check` changes nothing and exits 1 when a copy differs (test/tv-sync.test.ts runs the same
// comparison).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const WEB_SRC = join(ROOT, "tv/web/src");
export const VEGA_SRC = join(ROOT, "tv/vega/src");
export const HUB_CONTRACT = join(ROOT, "src/hub/contract.ts");
export const SYNC_DIRS = ["views", "components", "mirror"] as const;
export const SYNC_FILES = ["theme.ts", "brand.ts", "motion.ts"] as const;

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])) : []);

// Every [source, destination] pair the sync maintains.
export function syncPairs(): [string, string][] {
  const pairs: [string, string][] = [
    [HUB_CONTRACT, join(WEB_SRC, "contract.ts")],
    [HUB_CONTRACT, join(VEGA_SRC, "contract.ts")],
  ];
  for (const f of SYNC_FILES) pairs.push([join(WEB_SRC, f), join(VEGA_SRC, f)]);
  for (const d of SYNC_DIRS) for (const f of walk(join(WEB_SRC, d))) pairs.push([f, join(VEGA_SRC, relative(WEB_SRC, f))]);
  return pairs;
}

// Files in the synced Vega folders that have no web source (left over from a rename).
export function staleCopies(): string[] {
  const want = new Set(syncPairs().map(([, d]) => d));
  return SYNC_DIRS.flatMap((d) => walk(join(VEGA_SRC, d))).filter((f) => !want.has(f));
}

// Destinations that are missing or differ from their source, plus stale copies.
export function syncDiff(): string[] {
  const bad = syncPairs()
    .filter(([s, d]) => !existsSync(d) || !readFileSync(s).equals(readFileSync(d)))
    .map(([, d]) => relative(ROOT, d));
  return [...bad, ...staleCopies().map((f) => `${relative(ROOT, f)} (stale)`)];
}

export function runSync(): { copied: number; removed: number } {
  let copied = 0;
  for (const [s, d] of syncPairs()) {
    if (existsSync(d) && readFileSync(s).equals(readFileSync(d))) continue;
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    copied++;
  }
  const stale = staleCopies();
  for (const f of stale) rmSync(f);
  return { copied, removed: stale.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const diff = syncDiff();
    if (diff.length) {
      console.error(`tv-sync: ${diff.length} file(s) out of sync (run npm run tv:sync):\n  ${diff.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`tv-sync: ${syncPairs().length} files in sync`);
  } else {
    const r = runSync();
    console.log(`tv-sync: copied ${r.copied}, removed ${r.removed} stale; ${syncPairs().length} files in sync`);
  }
}
