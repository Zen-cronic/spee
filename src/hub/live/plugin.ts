// Live coaching plugin (packet A): the realtime window, nudge policy, wrist, recaps and coachNow.
// Routes (docs/CONTRACT.md "Routes (v2)"):
//   GET  /api/live           LiveState
//   POST /api/live/mode      {enabled, minutes?, by?, rules?} -> LiveModeResponse, then live.mode
//   GET  /api/recaps?limit=  RecapList (newest first)
//   GET  /api/recaps/<id>    Recap | 404 unknown_recap
//   GET  /api/coach/now      CoachNow (deterministic; no model call)
//   POST /api/demo/live      {script?} -> 202 DemoLiveResponse (demo only)
//
// It listens to the hub's internal Bee events (core.ts `bee.line` / `bee.conversation`), which
// come from the hub's one `bee stream` subscriber (live) or the demo replay; there is no second
// stream. Wrist channel: demo -> replay; live -> Bee to-dos (COACH_WRIST=replay for a dry run;
// also replay when the hub runs with --no-bee). Recap phrasing: template, or Claude Haiku on
// Bedrock when COACH_RECAP_LLM=1 in live mode. See docs/live.md.
import { join } from "node:path";
import { NUDGE_RULES, type DemoLiveResponse, type DemoLiveScript, type LiveModeRequest, type NudgeRule } from "../contract.js";
import type { HubPlugin, PluginCtx } from "../plugin.js";
import { matchRoute } from "../plugin.js";
import { DEFAULT_TIMINGS } from "../bee.js";
import { corpusWpm, DEFAULT_WPM } from "./baseline.js";
import { DEMO_SCRIPTS, predictedSteps, scheduleScript } from "./demoScripts.js";
import { LiveEngine } from "./engine.js";
import { MODE_MAX_MINUTES } from "./policy.js";
import { loadPrinciples, type Principles } from "./principles.js";
import type { PhraseFn } from "./recapPrompt.js";
import { BeeTodoWrist, REPLAY_TODO_MS, ReplayWrist, type ExecFn, type Wrist } from "./wrist.js";

export const LIVE_PREFIXES = ["/api/live", "/api/recaps", "/api/coach", "/api/demo/live"];
export const LIVE_ROUTES = ["GET /api/live", "POST /api/live/mode", "GET /api/recaps", "GET /api/recaps/<id>", "GET /api/coach/now", "POST /api/demo/live"];
export const LIVE_TOPICS = ["conversation.started", "live.window", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready", "live.mode"];

export interface LivePluginOptions {
  wrist?: (ctx: PluginCtx) => Wrist; // inject (tests)
  exec?: ExecFn; // BeeTodoWrist's CLI runner (tests)
  phrase?: PhraseFn | null; // recap phrasing (tests); default: env COACH_RECAP_LLM=1 in live mode
  principles?: Principles;
  onEngine?: (e: LiveEngine) => void;
}

const SCRIPTS = Object.keys(DEMO_SCRIPTS) as DemoLiveScript[];

export function badModeRequest(b: Record<string, unknown>): string | null {
  if (typeof b.enabled !== "boolean") return "enabled (boolean) is required";
  if (b.minutes !== undefined && (typeof b.minutes !== "number" || !Number.isFinite(b.minutes) || b.minutes < 1 || b.minutes > MODE_MAX_MINUTES)) return `minutes must be a number from 1 to ${MODE_MAX_MINUTES}`;
  if (b.by !== undefined && (typeof b.by !== "string" || b.by.length > 40)) return "by must be a short string";
  if (b.rules !== undefined) {
    if (!b.rules || typeof b.rules !== "object" || Array.isArray(b.rules)) return "rules must be an object of rule -> boolean";
    for (const [k, v] of Object.entries(b.rules)) if (!(NUDGE_RULES as readonly string[]).includes(k) || typeof v !== "boolean") return `rules: ${k} must be one of ${NUDGE_RULES.join(", ")} with a boolean`;
  }
  return null;
}

// Claude Haiku 4.5 on Bedrock, loaded only when enabled (the AWS SDK stays out of demo and tests).
async function bedrockPhrase(): Promise<PhraseFn> {
  const { callTool } = await import("../../llm/bedrock.js");
  return (o) => callTool(o);
}

export function createLivePlugin(opts: LivePluginOptions = {}): HubPlugin {
  let engine: LiveEngine | null = null;
  let principles: Principles | null = null;
  let wrist: Wrist | null = null;

  const pickWrist = (ctx: PluginCtx): Wrist => {
    if (opts.wrist) return opts.wrist(ctx);
    const choice = process.env.COACH_WRIST ?? (ctx.demo || !ctx.setup.stream ? "replay" : "bee-todo");
    if (choice === "bee-todo" && !ctx.demo) return new BeeTodoWrist({ exec: opts.exec, clock: ctx.hub.clock, ledgerPath: ctx.stateDir ? join(ctx.stateDir, "live", "todos.json") : null, log: ctx.log });
    return new ReplayWrist({ clock: ctx.hub.clock, pace: ctx.pace });
  };

  return {
    name: "live",
    prefixes: LIVE_PREFIXES,
    attach(ctx) {
      principles = opts.principles ?? loadPrinciples();
      wrist = pickWrist(ctx);
      const wantLlm = opts.phrase === undefined && !ctx.demo && process.env.COACH_RECAP_LLM === "1";
      const e = new LiveEngine({
        hub: ctx.hub,
        publish: (t, d) => ctx.publish(t, d),
        pace: ctx.pace,
        demo: ctx.demo,
        stateDir: ctx.stateDir,
        wrist,
        principles,
        baselineWpm: ctx.demo ? DEFAULT_WPM : (corpusWpm(ctx.stateDir ?? "real") ?? DEFAULT_WPM),
        log: ctx.log,
        phrase: opts.phrase ?? null,
        loadState: !ctx.demo,
      });
      engine = e;
      if (wantLlm) void bedrockPhrase().then((p) => e.setPhrase(p), (err) => ctx.log("live.llm.unavailable", { error: (err as Error).message }));
      ctx.hub.onBee({ line: (l) => e.onLine(l), conversation: (c) => e.onConversation(c), todoDeleted: (t) => e.onTodoDeleted(t) });
      wrist.start();
      opts.onEngine?.(e);
      ctx.log("live.attached", { wrist: wrist.channel, principles: principles.source, thresholds: principles.thresholdsFrom, phrasing: wantLlm ? "llm" : e.phrasing });
    },
    async route(req, res, url, ctx) {
      const e = engine;
      if (!e) return false;
      const method = req.method ?? "GET";
      const path = url.pathname;
      const hit = LIVE_ROUTES.find((r) => matchRoute(r, method, path));
      if (!hit) return false;
      switch (hit) {
        case "GET /api/live":
          return ctx.json(res, 200, e.state()), true;
        case "POST /api/live/mode": {
          const b = await ctx.readJson(req);
          const bad = badModeRequest(b);
          if (bad) return ctx.json(res, 400, { error: "bad_request", message: bad }), true;
          const r: LiveModeRequest = { enabled: b.enabled as boolean, minutes: b.minutes as number | undefined, by: (b.by as string | undefined) ?? "http", rules: b.rules as Partial<Record<NudgeRule, boolean>> | undefined };
          return ctx.json(res, 200, e.setMode(r)), true;
        }
        case "GET /api/recaps": {
          const raw = Number(url.searchParams.get("limit") ?? 10);
          const limit = Math.max(1, Math.min(50, Number.isFinite(raw) ? Math.floor(raw) : 10));
          return ctx.json(res, 200, { dataLabel: ctx.hub.dataLabel, synthetic: ctx.demo, recaps: e.recapList(limit) }), true;
        }
        case "GET /api/recaps/<id>": {
          const id = matchRoute(hit, method, path)!.id!;
          const r = e.recap(id);
          return r ? ctx.json(res, 200, r) : ctx.json(res, 404, { error: "unknown_recap", message: `no recap ${id}` }), true;
        }
        case "GET /api/coach/now":
          return ctx.json(res, 200, e.coachNow()), true;
        case "POST /api/demo/live": {
          const b = await ctx.readJson(req);
          const director = ctx.setup.demo;
          if (!ctx.demo || !director) return ctx.json(res, 400, { error: "demo_only", message: "POST /api/demo/live replays a synthetic conversation and is only available in demo mode" }), true;
          const script = (b.script ?? "story") as DemoLiveScript;
          if (!SCRIPTS.includes(script)) return ctx.json(res, 400, { error: "bad_request", message: `script must be one of ${SCRIPTS.join(", ")}` }), true;
          const sched = scheduleScript(DEMO_SCRIPTS[script]);
          const { conversationId } = director.replayConversation(sched);
          const th = principles!.thresholds;
          const steps = predictedSteps(sched, { idleEndMs: th.recap.idleEndMs, tagWaitMs: DEFAULT_TIMINGS.tagWaitMs, wristMs: REPLAY_TODO_MS }).map((s) => ({ ...s, atMs: Math.round(s.atMs * ctx.pace) }));
          ctx.log("live.demo", { script, conversationId });
          const out: DemoLiveResponse = { replay: true, script, conversationId, description: DEMO_SCRIPTS[script].description, pace: ctx.pace, steps };
          return ctx.json(res, 202, out), true;
        }
      }
      return false;
    },
    describe() {
      const w = wrist?.status();
      return {
        owner: "packet A",
        status: !engine ? "off" : w && !w.healthy ? "degraded" : "ready",
        routes: LIVE_ROUTES,
        topics: LIVE_TOPICS,
        note: engine ? `wrist: ${w?.channel}${w && !w.healthy ? " (circuit open)" : ""}; principles: ${principles?.source}; recap phrasing: ${engine.phrasing}` : "not attached",
      };
    },
    stop() {
      engine?.stop();
    },
  };
}
