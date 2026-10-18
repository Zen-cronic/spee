// Crash-safe JSON state files for the hub (deck, attempts). A write goes to <path>.tmp and is then
// renamed over <path>, so a kill mid-write leaves the previous file intact. On load, a good file is
// copied to <path>.bak; a file that does not parse is moved aside to <path>.corrupt-<time> and the
// .bak is used instead, so one bad write never stops the hub from starting. All of these sit next
// to the state file, in the same git-ignored directory.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  renameSync(tmp, path);
}

export function readJsonSafe<T>(path: string, fallback: () => T, warn: (msg: string) => void = (m) => console.error(`hub: ${m}`)): T {
  if (!existsSync(path)) return fallback();
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as T;
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      /* a backup is best effort */
    }
    return v;
  } catch {
    const aside = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, aside);
    } catch {
      /* leave it */
    }
    if (existsSync(`${path}.bak`)) {
      try {
        const v = JSON.parse(readFileSync(`${path}.bak`, "utf8")) as T;
        warn(`${path} did not parse; moved it to ${aside} and loaded ${path}.bak`);
        return v;
      } catch {
        /* fall through */
      }
    }
    warn(`${path} did not parse; moved it to ${aside} and started empty`);
    return fallback();
  }
}
