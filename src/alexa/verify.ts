// Alexa request checks (packet C). Every POST /alexa must name this skill's application id and carry
// a timestamp within 150 s of the hub's wall clock (Alexa's replay window). A rejected request gets
// 400 alexa_rejected. Full certificate-chain signature verification is a stretch item
// (docs/alexa.md); the gate already limits what a public request can reach.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../hub/static.js";
import type { AlexaRequestEnvelope } from "./types.js";

export const ALEXA_TIMESTAMP_TOLERANCE_MS = 150_000;
export const SKILL_CONFIG_PATH = join(REPO_ROOT, "alexa/skill-id.json");

export interface SkillConfig {
  skillId: string;
  stage: string;
  askProfile: string;
  locales: string[];
}

export function readSkillConfig(path = SKILL_CONFIG_PATH): SkillConfig {
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillConfig>;
  if (typeof j.skillId !== "string" || !j.skillId.startsWith("amzn1.ask.skill.")) throw new Error(`${path}: skillId must be an amzn1.ask.skill.* id`);
  return { skillId: j.skillId, stage: j.stage ?? "development", askProfile: j.askProfile ?? "default", locales: j.locales ?? ["en-CA", "en-US"] };
}

// ALEXA_SKILL_ID from the environment, else alexa/skill-id.json.
export function resolveSkillId(env: Record<string, string | undefined> = process.env, path = SKILL_CONFIG_PATH): string {
  return env.ALEXA_SKILL_ID?.trim() || readSkillConfig(path).skillId;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyAlexaRequest(body: unknown, opts: { skillId: string; now: number; toleranceMs?: number }): VerifyResult {
  if (!body || typeof body !== "object") return { ok: false, reason: "not an Alexa request envelope" };
  const env = body as Partial<AlexaRequestEnvelope>;
  if (!env.request || typeof env.request !== "object" || typeof env.request.type !== "string") return { ok: false, reason: "not an Alexa request envelope (no request.type)" };
  const ids = [env.session?.application?.applicationId, env.context?.System?.application?.applicationId].filter((x): x is string => typeof x === "string");
  if (!ids.length) return { ok: false, reason: "no application id" };
  if (ids.some((id) => id !== opts.skillId)) return { ok: false, reason: "wrong skill id" };
  const ts = Date.parse(String(env.request.timestamp ?? ""));
  if (!Number.isFinite(ts)) return { ok: false, reason: "no request timestamp" };
  if (Math.abs(opts.now - ts) > (opts.toleranceMs ?? ALEXA_TIMESTAMP_TOLERANCE_MS)) return { ok: false, reason: "timestamp outside the 150 s window" };
  return { ok: true };
}

// The progressive-response API endpoints Alexa hands out (NA, EU, FE). The skill only ever POSTs a
// directive to one of these, so a forged request cannot point the hub at another host.
export const ALEXA_API_ENDPOINT_RE = /^https:\/\/api(\.(eu|fe))?\.amazonalexa\.com\/?$/;
export const isAlexaApiEndpoint = (url: string | undefined): boolean => !!url && ALEXA_API_ENDPOINT_RE.test(url);
