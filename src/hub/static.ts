// Static mounts (lead-owned): the built web surfaces, served by the hub so one port (and one
// tunnel) carries everything.
//   /tv/   -> tv/web/dist      the web TV mirror (packet B; LAN only)
//   /p/    -> dist/web/phone   the phone page, /p/<code>#k=<PAIR_TOKEN> (packet B; public)
//   /sim/  -> dist/web/sim     the Alexa+ simulator (packet C; public)
// A mount whose directory does not exist answers 404 not_built with the build command. Paths with
// no file extension fall back to the mount's index.html (single-page apps). Dot segments, encoded
// slashes, backslashes, NUL bytes, dotfiles and symlinks out of the mount are refused.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubPlugin, PluginCtx } from "./plugin.js";
import { underPrefix } from "./plugin.js";

export interface StaticMount {
  prefix: string; // ends with "/"
  dir: string; // relative to the repo root (or absolute)
  build: string; // the command that creates it
  public: boolean; // reachable through a tunnel (the gate decides; this is documentation)
}

export const STATIC_MOUNTS: StaticMount[] = [
  { prefix: "/tv/", dir: "tv/web/dist", build: "npm run tv:web:build", public: false },
  { prefix: "/p/", dir: "dist/web/phone", build: "npm run web:build", public: true },
  { prefix: "/sim/", dir: "dist/web/sim", build: "npm run web:build", public: true },
];

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const jsonOut = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

// Decode the part of the path below the mount into safe segments, or null when it is unsafe.
export function safeSegments(rest: string): string[] | null {
  const out: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (s === "." || s === ".." || s.startsWith(".") || /[/\\\0]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, mounts: StaticMount[] = STATIC_MOUNTS, root: string = REPO_ROOT): Promise<boolean> {
  const path = url.pathname;
  const m = mounts.find((x) => underPrefix(path, x.prefix));
  if (!m) return false;
  const method = req.method ?? "GET";
  if (method === "OPTIONS") return false; // the generic OPTIONS answer
  if (method !== "GET" && method !== "HEAD") {
    jsonOut(res, 405, { error: "method_not_allowed", message: `${m.prefix} serves GET and HEAD only` });
    return true;
  }
  if (path === m.prefix.slice(0, -1)) {
    res.writeHead(301, { location: `${m.prefix}${url.search}` });
    res.end();
    return true;
  }
  const segs = safeSegments(path.slice(m.prefix.length));
  if (!segs) {
    jsonOut(res, 400, { error: "bad_path", message: "path not allowed" });
    return true;
  }
  const dir = m.dir.startsWith("/") ? m.dir : join(root, m.dir);
  if (!existsSync(dir)) {
    jsonOut(res, 404, { error: "not_built", message: `${m.prefix} is served from ${m.dir}, which does not exist yet: run ${m.build}`, mount: m.prefix, dir: m.dir, build: m.build });
    return true;
  }
  let file = join(dir, ...segs);
  if (!isFile(file) && isFile(join(file, "index.html"))) file = join(file, "index.html");
  if (!isFile(file)) {
    const last = segs.at(-1) ?? "";
    if (last.includes(".")) {
      jsonOut(res, 404, { error: "not_found", message: `no file ${m.prefix}${segs.join("/")}` });
      return true;
    }
    file = join(dir, "index.html"); // single-page app fallback (/p/<code>)
    if (!isFile(file)) {
      jsonOut(res, 404, { error: "not_built", message: `${m.dir}/index.html is missing: run ${m.build}`, mount: m.prefix, dir: m.dir, build: m.build });
      return true;
    }
  }
  const realDir = realpathSync(dir);
  const realFile = realpathSync(file);
  if (!realFile.startsWith(realDir + sep)) {
    jsonOut(res, 400, { error: "bad_path", message: "path not allowed" });
    return true;
  }
  const type = TYPES[extname(realFile).toLowerCase()] ?? "application/octet-stream";
  const html = type.startsWith("text/html");
  res.writeHead(200, { "content-type": type, "content-length": statSync(realFile).size, "cache-control": html ? "no-cache" : "public, max-age=300", "x-content-type-options": "nosniff" });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  // pipeline() destroys the file stream when the client goes away mid-download (review L39); pipe() did not.
  await pipeline(createReadStream(realFile), res).catch(() => res.destroy());
  return true;
}

export function createStaticPlugin(opts: { mounts?: StaticMount[]; root?: string } = {}): HubPlugin {
  const mounts = opts.mounts ?? STATIC_MOUNTS;
  const root = opts.root ?? REPO_ROOT;
  return {
    name: "static",
    prefixes: mounts.map((m) => m.prefix),
    route: (req: IncomingMessage, res: ServerResponse, url: URL, _ctx: PluginCtx) => serveStatic(req, res, url, mounts, root),
    describe: () => {
      const built = mounts.map((m) => `${m.prefix} ${existsSync(m.dir.startsWith("/") ? m.dir : join(root, m.dir)) ? "built" : `not built (${m.build})`}`);
      return { owner: "lead", status: "ready", routes: mounts.map((m) => `GET ${m.prefix}*`), note: built.join("; ") };
    },
  };
}
