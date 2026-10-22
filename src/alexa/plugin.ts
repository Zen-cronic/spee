// Alexa plugin: POST /alexa, the custom skill endpoint. A PUBLIC request (through the
// tunnel) must carry Amazon's request signature (./signature.ts), on by default; set
// ALEXA_VERIFY_SIGNATURE=0 to turn that off for local fixture runs only. Loopback and LAN requests are
// never signature-checked. The skill id (one of Spee's skills, ./verify.ts) and timestamp are then
// checked (400 alexa_rejected otherwise), then ./skill.ts maps the
// intent onto the hub routes through the loopback hub client. An intent with a TV view
// (skill.ts INTENT_FOCUS) also publishes `mirror.focus` by "alexa". No model call in a request; logs
// carry intent names and timings only, never what was said.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubPlugin, PluginCtx } from "../hub/plugin.js";
import { HubClient } from "../mcp/hubClient.js";
import { handleAlexa, INTENT_FOCUS, type SkillDeps } from "./skill.js";
import { ssml } from "./speech.js";
import { maskDeep, maskOut } from "../hub/mask.js";
import type { AlexaRequestEnvelope, AlexaResponseEnvelope, OutputSpeech } from "./types.js";
import { signatureVerifier, type SigResult } from "./signature.js";
import { deviceRecorder } from "./device.js";
import { aplMode, type AplMode } from "./apl.js";
import { isAlexaApiEndpoint, skillIdSource, verifyAlexaRequest, type SkillIds } from "./verify.js";

export const ALEXA_PREFIXES = ["/alexa"];
export const ALEXA_ROUTES = ["POST /alexa"];

export interface AlexaPluginOptions {
  skillId?: string | string[]; // fixed ids; default: skillIds
  skillIds?: () => SkillIds; // default: skillIdSource() (ALEXA_SKILL_ID or alexa/skill-id.json, ALEXA_SKILL_IDS, alexa/skill-ids.local.json)
  now?: () => number; // wall clock for the timestamp window and the poll budget
  sleep?: (ms: number) => Promise<void>;
  hub?: HubClient;
  pollBudgetMs?: number;
  pollEveryMs?: number;
  apiEndpointAllowed?: (url: string) => boolean; // default: the Alexa API hosts only
  fetch?: typeof fetch; // for the progressive response
  // Verify Amazon's request signature on PUBLIC requests. Default: on, unless ALEXA_VERIFY_SIGNATURE=0.
  verifySignature?: boolean | ((headers: IncomingMessage["headers"], raw: Buffer) => Promise<SigResult>);
  // Which screens get a Spee document. Default: ALEXA_APL (off | on | hub-only), else hub-only.
  aplMode?: AplMode;
}

const MAX_BODY = 64_000;
async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    n += b.length;
    if (n > MAX_BODY) throw new Error("body too large");
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// POST {apiEndpoint}/v1/directives with VoicePlayer.Speak (fire and forget; 1.5 s cap).
export function progressiveSender(opts: { allowed?: (url: string) => boolean; fetch?: typeof fetch } = {}) {
  const allowed = opts.allowed ?? isAlexaApiEndpoint;
  const doFetch = opts.fetch ?? fetch;
  return async (env: AlexaRequestEnvelope, speech: string): Promise<boolean> => {
    const sys = env.context?.System;
    const ep = sys?.apiEndpoint?.replace(/\/+$/, "");
    if (!ep || !sys?.apiAccessToken || !env.request.requestId || !allowed(ep)) return false;
    try {
      const r = await doFetch(`${ep}/v1/directives`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sys.apiAccessToken}` },
        body: JSON.stringify({ header: { requestId: env.request.requestId }, directive: { type: "VoicePlayer.Speak", speech: ssml(maskOut(speech, "speech")) } }),
        signal: AbortSignal.timeout(1500),
      });
      return r.status >= 200 && r.status < 300;
    } catch {
      return false;
    }
  };
}

// The skill's answer masked for speech where Alexa speaks it (outputSpeech, the reprompt) and in the
// session attributes (ids). A directive goes out as built: the APL datasource is already masked for a
// screen (apl.ts renderDirective), and the document's expressions and resource names ("@lime",
// "@coral") are not words, so masking them would break the screen.
export function maskSpoken(env: AlexaResponseEnvelope): AlexaResponseEnvelope {
  const speech = (o: OutputSpeech): OutputSpeech => ({ ...o, ...(o.text != null ? { text: maskOut(o.text, "speech") } : {}), ...(o.ssml != null ? { ssml: maskOut(o.ssml, "speech") } : {}) });
  const r = env.response;
  return {
    ...env,
    ...(env.sessionAttributes ? { sessionAttributes: maskDeep(env.sessionAttributes, "speech") } : {}),
    response: { ...r, ...(r.outputSpeech ? { outputSpeech: speech(r.outputSpeech) } : {}), ...(r.reprompt ? { reprompt: { outputSpeech: speech(r.reprompt.outputSpeech) } } : {}) },
  };
}

export function createAlexaPlugin(opts: AlexaPluginOptions = {}): HubPlugin {
  let hub: HubClient | null = opts.hub ?? null;
  let served = 0;
  let rejected = 0;
  let configError: string | null = null;
  const now = opts.now ?? (() => Date.now());
  const progressive = progressiveSender({ allowed: opts.apiEndpointAllowed, fetch: opts.fetch });
  const newDevice = deviceRecorder();
  const rawApl = process.env.ALEXA_APL?.trim();
  const apl: AplMode = opts.aplMode ?? aplMode(rawApl);
  const aplNote = `APL ${apl}${apl === "hub-only" ? " (Echo Show screens; a Fire TV gets voice only, so the Spee app stays in front)" : apl === "on" ? " (every screen, the Fire TV too)" : " (no screens)"}`;
  const sigOpt = opts.verifySignature ?? process.env.ALEXA_VERIFY_SIGNATURE?.trim() !== "0";
  const checkSignature = typeof sigOpt === "function" ? sigOpt : sigOpt ? signatureVerifier() : null;
  const fixed: SkillIds | null = opts.skillId === undefined ? null : { ids: [opts.skillId].flat(), names: {}, sources: ["options"], warnings: [] };
  const source = opts.skillIds ?? (fixed ? () => fixed : skillIdSource());
  let last: SkillIds | null = null;
  const answered = new Set<string>(); // skills that have passed the checks, each logged once
  // The accepted ids (re-read when the deploy writes alexa/skill-ids.local.json), logged as counts and
  // sources whenever they change, never the ids.
  const loadSkillIds = (log?: PluginCtx["log"]): SkillIds | null => {
    try {
      const s = source();
      configError = null;
      if (log && s !== last) {
        log("alexa.skill-ids", { accepted: s.ids.length, sources: s.sources, ...(s.warnings.length ? { warnings: s.warnings } : {}) });
        last = s;
      }
      return s;
    } catch (err) {
      configError = (err as Error).message;
      return null;
    }
  };
  return {
    name: "alexa",
    prefixes: ALEXA_PREFIXES,
    attach(ctx) {
      hub ??= new HubClient(() => ctx.selfUrl());
      loadSkillIds(ctx.log);
      ctx.log("alexa.apl", { mode: apl, ...(rawApl && !opts.aplMode && rawApl.toLowerCase() !== apl ? { ignored: "ALEXA_APL must be off, on or hub-only" } : {}) });
      if (!checkSignature) ctx.log("alexa.signature-off", { note: "ALEXA_VERIFY_SIGNATURE=0: public /alexa requests are not signature-checked; never run a tunnel like this" });
    },
    async route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PluginCtx) {
      if (url.pathname !== "/alexa") return false;
      if (req.method !== "POST") return ctx.json(res, 405, { error: "method_not_allowed", message: "POST /alexa only" }), true;
      const skills = loadSkillIds(ctx.log);
      if (!skills) return ctx.json(res, 503, { error: "alexa_unconfigured", message: configError ?? "no skill id" }), true;
      let raw: Buffer;
      try {
        raw = await rawBody(req);
      } catch {
        return ctx.json(res, 400, { error: "alexa_rejected", message: "body too large" }), true;
      }
      let body: Record<string, unknown> = {};
      try {
        const j = JSON.parse(raw.toString("utf8") || "{}");
        if (j && typeof j === "object" && !Array.isArray(j)) body = j;
      } catch {
        body = {};
      }
      if (checkSignature && ctx.isPublic(req)) {
        const sig = await checkSignature(req.headers, raw);
        if (!sig.ok) {
          rejected++;
          ctx.log("alexa.rejected", { reason: sig.reason, public: true, signature: true });
          return ctx.json(res, 400, { error: "alexa_rejected", message: sig.reason }), true;
        }
      }
      const v = verifyAlexaRequest(body, { skillId: skills.ids, now: now() });
      if (!v.ok) {
        rejected++;
        ctx.log("alexa.rejected", { reason: v.reason, public: ctx.isPublic(req) });
        return ctx.json(res, 400, { error: "alexa_rejected", message: v.reason }), true;
      }
      const envelope = body as unknown as AlexaRequestEnvelope;
      // Which invocation name was used: the first request through each skill logs its name (as the
      // deploy recorded it), so a name tried on a device shows up in the hub log.
      const appId = envelope.session?.application?.applicationId ?? envelope.context?.System?.application?.applicationId;
      if (appId && !answered.has(appId)) {
        answered.add(appId);
        ctx.log("alexa.skill", { name: skills.names[appId] ?? null });
      }
      const device = newDevice(envelope);
      if (device) ctx.log("alexa.device", { ...device });
      const deps: SkillDeps = {
        hub: (hub ??= new HubClient(() => ctx.selfUrl())),
        now,
        sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        progressive,
        log: ctx.log,
        pollBudgetMs: opts.pollBudgetMs,
        pollEveryMs: opts.pollEveryMs,
        aplMode: apl,
      };
      const out = await handleAlexa(envelope, deps);
      served++;
      const focus = INTENT_FOCUS[out.routed.intent];
      if (focus) ctx.publish("mirror.focus", { view: focus.view, by: "alexa", reason: focus.reason, recapId: null, takeId: null });
      ctx.json(res, 200, maskSpoken(out.envelope), { premasked: true });
      return true;
    },
    // A local skills file that could not be read is degraded, not ready: every skill the deploy
    // recorded in it is refused until it is fixed (alexa:deploy stops on it too).
    describe: () => {
      const s = loadSkillIds();
      const skipped = s ? s.warnings.length - (s.unread ? 1 : 0) : 0;
      return {
        owner: "Alexa skill",
        status: configError || s?.unread ? "degraded" : "ready",
        routes: ALEXA_ROUTES,
        note: !s
          ? `no skill id: ${configError}`
          : `${s.ids.length} skill id${s.ids.length === 1 ? "" : "s"} from ${s.sources.join(", ")}${skipped ? ` (${skipped} skipped)` : ""}${s.unread ? `; ${s.unread} could not be read, so the skills in it are refused` : ""}; signature check ${checkSignature ? "on (public requests)" : "OFF (ALEXA_VERIFY_SIGNATURE=0)"}; ${aplNote}; ${served} requests served, ${rejected} rejected`,
      };
    },
  };
}
