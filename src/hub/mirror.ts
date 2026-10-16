// Mirror plugin (packet B): relays practice.meters from a room's mic to that room's screens
// (ctx.broadcastToScreens, <= 20 Hz), publishes practice.summary and mirror.focus, and serves
// POST /api/demo/mirror. STUB until packet B lands: the route answers 501 and onApp ignores the
// practice topics. Packet B replaces this file's body and keeps the export name
// `createMirrorPlugin`, the prefixes and the routes (src/hub/contract.ts, docs/CONTRACT.md v2).
import { stubPlugin, type HubPlugin } from "./plugin.js";

export const MIRROR_PREFIXES = ["/api/demo/mirror"];
export const MIRROR_ROUTES = ["POST /api/demo/mirror"];
export const MIRROR_TOPICS = ["practice.meters", "practice.summary", "mirror.focus"];

export function createMirrorPlugin(): HubPlugin {
  return stubPlugin({ name: "mirror", owner: "packet B", prefixes: MIRROR_PREFIXES, routes: MIRROR_ROUTES, topics: MIRROR_TOPICS, note: "stub: answers 501 not_implemented; practice.* and mirror.focus app frames are ignored" });
}
