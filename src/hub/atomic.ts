// Crash-safe JSON state files for the hub (deck, attempts). A write goes to <path>.tmp and is then
// renamed over <path>, so a kill mid-write leaves the previous file intact. On load, a good file is
// copied to <path>.bak; a file that does not parse is moved aside to <path>.corrupt-<time> and the
// .bak is used instead and written back to <path>, so one bad write never stops the hub from starting
// and the next start finds the recovered file. All of these sit next to the state file, in the same
// git-ignored directory. A missing <path> is a deliberate reset: the fallback, not the .bak.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// `mode` (for example 0o600 for secrets) is given to the tmp file when it is created: a leftover tmp
// is removed first and the new one is opened exclusively, so the data never sits in a file that is
// readable more widely, even for a moment.
export function writeJsonAtomic(path: string, data: unknown, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n", { flag: "wx", ...(opts.mode === undefined ? {} : { mode: opts.mode }) });
  if (opts.mode !== undefined) chmodSync(tmp, opts.mode); // the umask can only narrow it; set it exactly
  renameSync(tmp, path);
}

// Copy `from` over `path` atomically, with `from`'s mode.
function restore(from: string, path: string): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const mode = statSync(from).mode & 0o777;
  writeFileSync(tmp, readFileSync(from), { flag: "wx", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// Delete the backup and the moved-aside copies of a state file (for example the old tokens after a
// rotation, so a later damaged file cannot bring them back).
export function removeCopies(path: string): string[] {
  const dir = dirname(path);
  const base = basename(path);
  const gone: string[] = [];
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const n of names) {
    if (n !== `${base}.bak` && !n.startsWith(`${base}.corrupt-`)) continue;
    rmSync(join(dir, n), { force: true });
    gone.push(n);
  }
  return gone;
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
        try {
          restore(`${path}.bak`, path);
          warn(`${path} did not parse; moved it to ${aside} and restored ${path}.bak`);
        } catch {
          warn(`${path} did not parse; moved it to ${aside} and loaded ${path}.bak (it could not be copied back)`);
        }
        return v;
      } catch {
        /* fall through */
      }
    }
    warn(`${path} did not parse; moved it to ${aside} and started empty`);
    return fallback();
  }
}
