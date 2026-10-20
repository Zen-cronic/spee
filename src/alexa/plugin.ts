// Alexa plugin (packet C): POST /alexa, the custom skill endpoint. A PUBLIC request (through the
// tunnel) must carry Amazon's request signature (./signature.ts), on by default; set
// ALEXA_VERIFY_SIGNATURE=0 to turn that off for local fixture runs only. Loopback and LAN requests are
// never signature-checked. The skill id and timestamp are then checked (./verify.ts; 400
// alexa_rejected otherwise), then ./skill.ts maps the
// intent onto the hub routes through the loopback hub client. No model call in a request; logs
// carry intent names and timings only, never what was said.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubPlugin, PluginCtx } from "../hub/plugin.js";
import { HubClient } from "../mcp/hubClient.js";
import { handleAlexa, type SkillDeps } from "./skill.js";
import { ssml } from "./speech.js";
import { maskOut } from "../hub/mask.js";
import type { AlexaRequestEnvelope } from "./types.js";
import { signatureVerifier, type SigResult } from "./signature.js";
import { isAlexaApiEndpoint, resolveSkillId, verifyAlexaRequest } from "./verify.js";

export const ALEXA_PREFIXES = ["/alexa"];
export const ALEXA_ROUTES = ["POST /alexa"];

export interface AlexaPluginOptions {
  skillId?: string; // default: ALEXA_SKILL_ID, else alexa/skill-id.json
  now?: () => number; // wall clock for the timestamp window and the poll budget
  sleep?: (ms: number) => Promise<void>;
  hub?: HubClient;
  pollBudgetMs?: number;
  pollEveryMs?: number;
  apiEndpointAllowed?: (url: string) => boolean; // default: the Alexa API hosts only
  fetch?: typeof fetch; // for the progressive response
  // Verify Amazon's request signature on PUBLIC requests. Default: on, unless ALEXA_VERIFY_SIGNATURE=0.
  verifySignature?: boolean | ((headers: IncomingMessage["headers"], raw: Buffer) => Promise<SigResult>);
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

export function createAlexaPlugin(opts: AlexaPluginOptions = {}): HubPlugin {
  let skillId: string | null = null;
  let hub: HubClient | null = opts.hub ?? null;
  let served = 0;
  let rejected = 0;
  let configError: string | null = null;
  const now = opts.now ?? (() => Date.now());
  const progressive = progressiveSender({ allowed: opts.apiEndpointAllowed, fetch: opts.fetch });
  const sigOpt = opts.verifySignature ?? process.env.ALEXA_VERIFY_SIGNATURE?.trim() !== "0";
  const checkSignature = typeof sigOpt === "function" ? sigOpt : sigOpt ? signatureVerifier() : null;
  const loadSkillId = () => {
    if (skillId) return skillId;
    try {
      skillId = opts.skillId ?? resolveSkillId();
      configError = null;
    } catch (err) {
      configError = (err as Error).message;
    }
    return skillId;
  };
  return {
    name: "alexa",
    prefixes: ALEXA_PREFIXES,
    attach(ctx) {
      hub ??= new HubClient(() => ctx.selfUrl());
      loadSkillId();
      if (!checkSignature) ctx.log("alexa.signature-off", { note: "ALEXA_VERIFY_SIGNATURE=0: public /alexa requests are not signature-checked; never run a tunnel like this" });
    },
    async route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PluginCtx) {
      if (url.pathname !== "/alexa") return false;
      if (req.method !== "POST") return ctx.json(res, 405, { error: "method_not_allowed", message: "POST /alexa only" }), true;
      const id = loadSkillId();
      if (!id) return ctx.json(res, 503, { error: "alexa_unconfigured", message: configError ?? "no skill id" }), true;
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
      const v = verifyAlexaRequest(body, { skillId: id, now: now() });
      if (!v.ok) {
        rejected++;
        ctx.log("alexa.rejected", { reason: v.reason, public: ctx.isPublic(req) });
        return ctx.json(res, 400, { error: "alexa_rejected", message: v.reason }), true;
      }
      const deps: SkillDeps = {
        hub: (hub ??= new HubClient(() => ctx.selfUrl())),
        now,
        sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        progressive,
        log: ctx.log,
        pollBudgetMs: opts.pollBudgetMs,
        pollEveryMs: opts.pollEveryMs,
      };
      const out = await handleAlexa(body as unknown as AlexaRequestEnvelope, deps);
      served++;
      ctx.json(res, 200, out.envelope);
      return true;
    },
    describe: () => ({
      owner: "packet C",
      status: configError ? "degraded" : "ready",
      routes: ALEXA_ROUTES,
      note: configError
        ? `no skill id: ${configError}`
        : `skill id from ${opts.skillId ? "options" : process.env.ALEXA_SKILL_ID ? "ALEXA_SKILL_ID" : "alexa/skill-id.json"}; signature check ${checkSignature ? "on (public requests)" : "OFF (ALEXA_VERIFY_SIGNATURE=0)"}; ${served} requests served, ${rejected} rejected`,
    }),
  };
}
