// Live coaching plugin (packet A): the realtime window, nudge policy, wrist, recaps and coachNow.
// Routes (docs/CONTRACT.md "Routes (v2)"):
//   GET  /api/live           LiveState
//   POST /api/live/mode      {enabled, minutes?, by?, rules?} -> LiveModeResponse, then live.mode
//   GET  /api/recaps?limit=  RecapList (newest first)
//   GET  /api/recaps/<id>    Recap | 404 unknown_recap
//   GET  /api/coach/now      CoachNow (deterministic; no model call)
//   GET  /api/coach/facts    BeeMemory: the goal fact in Bee and Bee's counts (live/facts.ts; COACH_FACTS=1)
//   POST /api/coach/cue      {inMinutes?, by?} -> CueResponse: one if-then wrist cue (live/cue.ts; COACH_CUES=1)
//   POST /api/demo/live      {script?} -> 202 DemoLiveResponse (demo only)
//   GET  /api/settings       SettingsResponse: the conversation settings, per-setting rates (secondary view)
//   POST /api/sessions/<id>/setting  {setting} -> SettingResponse, then stats.updated (src/hub/settings.ts)
//
// It listens to the hub's internal Bee events (core.ts `bee.line` / `bee.conversation`), which
// come from the hub's one `bee stream` subscriber (live) or the demo replay; there is no second
// stream. Wrist channel: demo -> replay; live -> Bee to-dos (COACH_WRIST=replay for a dry run;
// also replay when the hub runs with --no-bee). Recap phrasing: template, or Claude Haiku on
// Bedrock when COACH_RECAP_LLM=1 in live mode. See docs/live.md.
import { join } from "node:path";
import { NUDGE_RULES, type DemoLiveResponse, type DemoLiveScript, type LiveModeRequest, type NudgeRule, type Recap, type SettingResponse } from "../contract.js";
import { isSetting, rewordRecapSetting, sameConversation, SettingsBook } from "../settings.js";
import { parseSource } from "../stats.js";
import type { HubPlugin, PluginCtx } from "../plugin.js";
import { matchRoute } from "../plugin.js";
import { DEFAULT_TIMINGS } from "../bee.js";
import { corpusWpm, DEFAULT_WPM } from "./baseline.js";
import { DEMO_SCRIPTS, predictedSteps, scheduleScript } from "./demoScripts.js";
import { LiveEngine } from "./engine.js";
import { CueBook, cuesEnabledFor } from "./cue.js";
import { BeeFacts, factsModeFor, type BeeFactsOptions, type FactsMode } from "./facts.js";
import { MODE_MAX_MINUTES } from "./policy.js";
import { loadPrinciples, type Principles } from "./principles.js";
import type { PhraseFn } from "./recapPrompt.js";
import { BeeTodoWrist, REPLAY_TODO_MS, ReplayWrist, type ExecFn, type Wrist } from "./wrist.js";

export const LIVE_PREFIXES = ["/api/live", "/api/recaps", "/api/coach", "/api/demo/live", "/api/settings", "/api/sessions"];
export const LIVE_ROUTES = ["GET /api/live", "POST /api/live/mode", "GET /api/recaps", "GET /api/recaps/<id>", "GET /api/coach/now", "GET /api/coach/facts", "POST /api/coach/cue", "POST /api/demo/live", "GET /api/settings", "POST /api/sessions/<id>/setting"];
export const LIVE_TOPICS = ["conversation.started", "live.window", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready", "live.mode"];

export interface LivePluginOptions {
  wrist?: (ctx: PluginCtx) => Wrist; // inject (tests)
  exec?: ExecFn; // BeeTodoWrist's CLI runner (tests)
  phrase?: PhraseFn | null; // recap phrasing (tests); default: env COACH_RECAP_LLM=1 in live mode
  principles?: Principles;
  onEngine?: (e: LiveEngine) => void;
  factsMode?: FactsMode; // default: COACH_FACTS=1 in live mode with the stream ("live"), demo "demo", else "off"
  facts?: Partial<BeeFactsOptions>; // tests: clock, sleep, timings
  cues?: boolean; // default: COACH_CUES=1 in live mode; always on in demo
  onFacts?: (f: BeeFacts) => void;
  onCues?: (c: CueBook) => void;
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
  let book: SettingsBook | null = null;
  let principles: Principles | null = null;
  // A recap as served: its setting is the wearer's choice when there is one.
  // A recap made before settings existed gets the automatic tag (others heard: talk share under 1).
  const recapTag = (b: SettingsBook, r: Recap) => b.tagRecap(r) ?? b.tagConversation({ conversationId: r.conversationId, startedAt: r.startedAt, endedAt: r.endedAt, otherLines: r.metrics.talkShare != null && r.metrics.talkShare < 1 ? 1 : 0 });
  // Its headline and narration say where their usual came from when the wearer chose another setting.
  const served = (r: Recap): Recap => (book ? rewordRecapSetting({ ...r, setting: recapTag(book, r) }) : r);
  let wrist: Wrist | null = null;
  let facts: BeeFacts | null = null;
  let cues: CueBook | null = null;

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
      // The calendar (Bee's today brief) is read only when the hub talks to Bee, or in demo (injected).
      const b = new SettingsBook({ hub: ctx.hub, stateDir: ctx.stateDir, load: !ctx.demo, calendar: ctx.demo || ctx.setup.stream ? ctx.setup.calendar : null, log: ctx.log });
      book = b;
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
        settings: { tagConversation: (c) => b.tagConversation(c), baselineFor: (s) => b.baselineFor(s), tagRecap: (r) => b.tagRecap(r), onStarted: () => void b.refreshCalendar() },
      });
      engine = e;
      if (wantLlm) void bedrockPhrase().then((p) => e.setPhrase(p), (err) => ctx.log("live.llm.unavailable", { error: (err as Error).message }));
      ctx.hub.onBee({ line: (l) => e.onLine(l), conversation: (c) => e.onConversation(c), todoDeleted: (t) => e.onTodoDeleted(t) });
      wrist.start();
      opts.onEngine?.(e);
      // Bee memory and wrist cues: separate from the engine, so a Bee facts failure never touches live coaching.
      const factsMode = opts.factsMode ?? factsModeFor({ demo: ctx.demo, stream: !!ctx.setup.stream });
      facts = new BeeFacts({ hub: ctx.hub, mode: factsMode, stateDir: ctx.stateDir, exec: opts.exec, log: ctx.log, onChange: () => ctx.hub.publishStats(), ...opts.facts });
      facts.start();
      opts.onFacts?.(facts);
      cues = new CueBook({ hub: ctx.hub, wrist, enabled: opts.cues ?? cuesEnabledFor({ demo: ctx.demo }), stateDir: ctx.demo ? null : ctx.stateDir, log: ctx.log });
      opts.onCues?.(cues);
      ctx.log("live.attached", { wrist: wrist.channel, principles: principles.source, thresholds: principles.thresholdsFrom, phrasing: wantLlm ? "llm" : e.phrasing, facts: factsMode, cues: cues.describe() });
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
          return ctx.json(res, 200, { dataLabel: ctx.hub.dataLabel, synthetic: ctx.demo, recaps: e.recapList(limit).map(served) }), true;
        }
        case "GET /api/recaps/<id>": {
          const id = matchRoute(hit, method, path)!.id!;
          const r = e.recap(id);
          return r ? ctx.json(res, 200, served(r)) : ctx.json(res, 404, { error: "unknown_recap", message: `no recap ${id}` }), true;
        }
        case "GET /api/coach/now":
          return ctx.json(res, 200, e.coachNow()), true;
        case "GET /api/coach/facts":
          return ctx.json(res, 200, facts!.memory()), true;
        case "POST /api/coach/cue": {
          const r = await cues!.request(await ctx.readJson(req));
          return ctx.json(res, r.status, r.body), true;
        }
        case "GET /api/settings": {
          const source = parseSource(url.searchParams.get("source"));
          if (!source) return ctx.json(res, 400, { error: "bad_source", message: "source must be bee (default) or all" }), true;
          await book!.refreshCalendar();
          return ctx.json(res, 200, book!.report(source)), true;
        }
        case "POST /api/sessions/<id>/setting": {
          const id = matchRoute(hit, method, path)!.id!;
          const b = await ctx.readJson(req);
          if (!("setting" in b) || !(b.setting === null || isSetting(b.setting))) return ctx.json(res, 400, { error: "bad_request", message: "setting must be \"meeting\", \"work\", \"casual\" or null (back to the automatic one)" }), true;
          // A recap id, a recap's conversation id (the live stream's uuid) or a stats session id.
          const recap = e.recap(id) ?? e.recaps.find((r) => r.conversationId === id) ?? null;
          const session = ctx.hub.sessions.find((s) => s.id === id) ?? null;
          if (!recap && !session) return ctx.json(res, 404, { error: "unknown_session", message: `no conversation or recap ${id}` }), true;
          const key = recap ? recap.conversationId : id;
          book!.set(key, b.setting, recap ? { startMs: recap.startedAt, endMs: recap.endedAt } : undefined);
          const tag = recap ? recapTag(book!, recap) : book!.tagSession(id)!;
          // The recaps of this conversation (its own id, or the same time by the lookup's rule) that now show this setting.
          const ofThis = (r: Recap) => r.conversationId === key || (!!session && sameConversation([session.startMs, session.endMs ?? session.startMs], [r.startedAt, r.endedAt]));
          const recapIds = e.recaps.filter((r) => ofThis(r) && recapTag(book!, r).setting === tag.setting).map((r) => r.id);
          ctx.log("settings.set", { id: key, setting: b.setting ?? null });
          // The per-setting rates and the screens' recaps move: the screens refetch on stats.updated.
          ctx.hub.publishStats();
          const out: SettingResponse = { id: key, tag, recapIds };
          return ctx.json(res, 200, out), true;
        }
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
        note: engine ? `wrist: ${w?.channel}${w && !w.healthy ? " (circuit open)" : ""}; principles: ${principles?.source}; recap phrasing: ${engine.phrasing}; Bee facts: ${facts?.describe()}; cues: ${cues?.describe()}` : "not attached",
      };
    },
    stop() {
      facts?.stop();
      engine?.stop();
    },
  };
}
