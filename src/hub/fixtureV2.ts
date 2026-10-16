// Fixture mode (`npm run hub -- --demo --fixture-v2`, lead-owned): the v2 live and mirror demo
// routes answer from the frozen examples in fixtures/contract-v2/, so the TV, the phone, Alexa and
// MCP can be built before the live engine lands. It runs before the plugins, so it keeps working
// unchanged after packet A replaces the live stub. Every payload is synthetic (wearer "Ada").
//
//   GET  /api/live             live.json
//   POST /api/live/mode        live-mode-on.json or live-mode-off.json (by `enabled`); publishes live.mode
//   GET  /api/recaps           recaps.json
//   GET  /api/recaps/<id>      recap.json for its id, else 404 unknown_recap
//   GET  /api/coach/now        coach-now.json
//   POST /api/demo/live        demo-live.json (202); replays events-live.json, scaled by --pace
//   POST /api/demo/mirror      demo-mirror.json (202); practice-meters.json frames to the screens
//                              at 10 Hz (not paced), then events-practice.json
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { RoomTopic, SequencedTopic } from "./contract.js";
import { matchRoute, type PluginCtx } from "./plugin.js";
import { REPO_ROOT } from "./static.js";

export const FIXTURE_V2_DIR = join(REPO_ROOT, "fixtures/contract-v2");
export const FIXTURE_V2_FILES = [
  "live.json",
  "live-mode-on.json",
  "live-mode-off.json",
  "recap.json",
  "recaps.json",
  "coach-now.json",
  "demo-live.json",
  "events-live.json",
  "practice-meters.json",
  "events-practice.json",
  "demo-mirror.json",
  "requests.json",
  "mcp-tools.json",
  "alexa-how-am-i-doing.json",
] as const;
export type FixtureV2File = (typeof FIXTURE_V2_FILES)[number];

export const loadFixtureV2 = (dir = FIXTURE_V2_DIR): Record<FixtureV2File, any> =>
  Object.fromEntries(FIXTURE_V2_FILES.map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))])) as Record<FixtureV2File, any>;

type Step = { atMs: number; topic: SequencedTopic; payload: Record<string, unknown> };

export function createFixtureRouter(ctx: PluginCtx, dir = FIXTURE_V2_DIR) {
  const fx = loadFixtureV2(dir);
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, Math.max(0, ms));
    timers.add(t);
  };
  const routes = ["GET /api/live", "POST /api/live/mode", "GET /api/recaps", "GET /api/recaps/<id>", "GET /api/coach/now", "POST /api/demo/live", "POST /api/demo/mirror"];
  return {
    routes,
    owns: (plugin: string) => plugin === "live" || plugin === "mirror",
    async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const method = req.method ?? "GET";
      const path = url.pathname;
      const hit = routes.find((r) => matchRoute(r, method, path));
      if (!hit) return false;
      switch (hit) {
        case "GET /api/live":
          return ctx.json(res, 200, fx["live.json"]), true;
        case "POST /api/live/mode": {
          const b = await ctx.readJson(req);
          if (typeof b.enabled !== "boolean") return ctx.json(res, 400, { error: "bad_request", message: "enabled (boolean) is required" }), true;
          const r = b.enabled ? fx["live-mode-on.json"] : fx["live-mode-off.json"];
          ctx.publish("live.mode", { mode: r.mode });
          return ctx.json(res, 200, r), true;
        }
        case "GET /api/recaps":
          return ctx.json(res, 200, fx["recaps.json"]), true;
        case "GET /api/recaps/<id>": {
          const id = matchRoute(hit, method, path)!.id;
          if (id === fx["recap.json"].id) return ctx.json(res, 200, fx["recap.json"]), true;
          return ctx.json(res, 404, { error: "unknown_recap", message: `no recap ${id}` }), true;
        }
        case "GET /api/coach/now":
          return ctx.json(res, 200, fx["coach-now.json"]), true;
        case "POST /api/demo/live": {
          const steps = fx["events-live.json"].events as Step[];
          for (const s of steps) later(s.atMs * ctx.pace, () => ctx.publish(s.topic, s.payload));
          const r = fx["demo-live.json"];
          const scaled = ctx.pace === 1 ? r : { ...r, pace: ctx.pace, steps: r.steps.map((s: { atMs: number; what: string }) => ({ ...s, atMs: Math.round(s.atMs * ctx.pace) })) };
          return ctx.json(res, 202, scaled), true;
        }
        case "POST /api/demo/mirror": {
          const b = await ctx.readJson(req);
          const room = typeof b.room === "string" ? b.room : null;
          const frames = fx["practice-meters.json"].frames as Record<string, unknown>[];
          frames.forEach((f, i) => later(i * 100, () => ctx.broadcastToScreens(room, "practice.meters" as RoomTopic, { ...f, from: "demo-phone" })));
          for (const s of fx["events-practice.json"].events as Step[]) later(frames.length * 100 + s.atMs, () => ctx.publish(s.topic, s.payload));
          const rooms = room ? (ctx.bridge.rooms.has(room.toUpperCase()) ? 1 : 0) : ctx.bridge.rooms.size;
          return ctx.json(res, 202, { ...fx["demo-mirror.json"], rooms }), true;
        }
      }
      return false;
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
