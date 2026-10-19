// The hub state files leak-check screens (scripts/leak-state.ts): the copies readJsonSafe leaves
// behind (.bak, .corrupt-<time>) are screened like the files themselves. Synthetic files only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hubStateFiles } from "../scripts/leak-state.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

it("screens each state file's .bak and .corrupt-<time> copies, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "leak-state-"));
  dirs.push(root);
  mkdirSync(join(root, "real", "live", "sub"), { recursive: true });
  const put = (p: string) => writeFileSync(join(root, p), "{}");
  for (const p of ["real/hub-attempts.json", "real/hub-attempts.json.bak", "real/hub-attempts.json.corrupt-1792517400000", "real/other.json", "real/live/recaps.json", "real/live/recaps.json.bak", "real/live/nudges.json.corrupt-1792517400000", "real/live/sub/todos.json.bak", "real/live/notes.txt", "real/live/recaps.json.tmp-1", "real/live/x.json.corrupt-abc"]) put(p);
  const got = hubStateFiles(root).map((f) => f.slice(root.length + 1)).sort();
  expect(got).toEqual(["real/hub-attempts.json", "real/hub-attempts.json.bak", "real/hub-attempts.json.corrupt-1792517400000", "real/live/nudges.json.corrupt-1792517400000", "real/live/recaps.json", "real/live/recaps.json.bak", "real/live/sub/todos.json.bak"].sort());
  expect(hubStateFiles(join(root, "missing"))).toEqual([]);
});
