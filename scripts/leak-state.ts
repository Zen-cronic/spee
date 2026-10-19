// Which of the hub's own state files `npm run leak-check` screens for other-speaker text (see
// scripts/leak-check.ts, point 7). readJsonSafe (src/hub/atomic.ts) keeps a copy of each file at
// <file>.bak on every load and moves a file that does not parse to <file>.corrupt-<time>, so those
// copies can hold text the current file no longer does: they are screened too.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const STATE_FILE_RE = /\.json(\.bak|\.corrupt-\d+)?$/;

const files = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : STATE_FILE_RE.test(d.name) ? [join(dir, d.name)] : [])) : [];

// real/hub-attempts.json, its copies next to it, and every state file (and copy) under real/live.
export function hubStateFiles(root = "."): string[] {
  const real = join(root, "real");
  const attempts = existsSync(real) ? readdirSync(real).filter((n) => /^hub-attempts\.json(\.bak|\.corrupt-\d+)?$/.test(n)).sort().map((n) => join(real, n)) : [];
  return [...attempts, ...files(join(real, "live"))];
}
