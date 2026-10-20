// Static mounts (src/hub/static.ts): built files, the single-page fallback, the not-built hint,
// and path traversal refused.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";
import { createStaticPlugin, safeSegments, type StaticMount } from "../src/hub/static.js";
import { createPlugins } from "../src/hub/plugins.js";
import { raw } from "./helpers-http.js";

let s: HubServer;
let root: string;
const SECRET = "SECRET-OUTSIDE-THE-MOUNT";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "static-"));
  mkdirSync(join(root, "phone/assets"), { recursive: true });
  writeFileSync(join(root, "phone/index.html"), "<!doctype html><title>phone</title>");
  writeFileSync(join(root, "phone/assets/app.js"), "console.log('phone')");
  writeFileSync(join(root, "phone/.env"), "NOPE=1");
  writeFileSync(join(root, "secret.txt"), SECRET);
  symlinkSync(join(root, "secret.txt"), join(root, "phone/link.txt"));
  const mounts: StaticMount[] = [
    { prefix: "/p/", dir: "phone", build: "npm run web:phone:build", public: true },
    { prefix: "/sim/", dir: "sim-not-built", build: "npm run web:sim:build", public: true },
  ];
  const plugins = createPlugins().map((p) => (p.name === "static" ? createStaticPlugin({ mounts, root }) : p));
  s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), plugins, pairToken: "p".repeat(20), mcpToken: "m".repeat(20) });
});
afterAll(async () => s.close());

describe("static mounts", () => {
  it("serves built files with a content type", async () => {
    const r = await raw(s.port, "/p/assets/app.js");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
    expect(r.text).toContain("phone");
    expect((await raw(s.port, "/p/assets/app.js", { method: "HEAD" })).status).toBe(200);
  });
  it("falls back to index.html for app routes (/p/<code>?k=...) and redirects the bare mount", async () => {
    const r = await raw(s.port, "/p/HJ3H?k=abc");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<title>phone</title>");
    expect((await raw(s.port, "/p/")).text).toContain("<title>phone</title>");
    const bare = await raw(s.port, "/p?k=abc");
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe("/p/?k=abc");
    expect((await raw(s.port, "/p/assets/missing.js")).status).toBe(404);
  });
  it("answers 404 not_built with the build command when the directory is missing", async () => {
    const r = await raw(s.port, "/sim/");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toMatchObject({ error: "not_built", build: "npm run web:sim:build" });
  });
  it("refuses path traversal, encoded slashes, dotfiles and symlinks out of the mount", async () => {
    for (const p of ["/p/..%2fsecret.txt", "/p/%2e%2e/secret.txt", "/p/%2e%2e%2fsecret.txt", "/p/..%5csecret.txt", "/p/assets/..%2f..%2fsecret.txt", "/p/.env", "/p/%00", "/p/link.txt", "/sim/..%2f..%2fpackage.json", "/p/..%252fsecret.txt"]) {
      const r = await raw(s.port, p);
      expect(r.text, p).not.toContain(SECRET);
      expect(r.text, p).not.toContain("speaking-mirror");
      expect([400, 404], p).toContain(r.status);
    }
    expect(JSON.parse((await raw(s.port, "/p/..%2fsecret.txt")).text).error).toBe("bad_path");
    expect(JSON.parse((await raw(s.port, "/p/link.txt")).text).error).toBe("bad_path");
    const dot = await raw(s.port, "/p/../secret.txt"); // the URL parser resolves it to /secret.txt: not a mount
    expect(dot.status).toBe(404);
    expect(dot.text).not.toContain(SECRET);
  });
  it("serves GET and HEAD only", async () => {
    expect((await raw(s.port, "/p/assets/app.js", { method: "POST" })).status).toBe(405);
  });
  it("safeSegments rejects unsafe segments", () => {
    expect(safeSegments("assets/app.js")).toEqual(["assets", "app.js"]);
    for (const x of ["..", "%2e%2e", "a/%2e%2e/b", "%2f", "a%5cb", "%00", ".git/config", "%E0%A4%A"]) expect(safeSegments(x), x).toBeNull();
  });
});
