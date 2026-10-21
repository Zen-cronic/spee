// Alexa request checks. Every POST /alexa must name one of Spee's skill ids and carry a timestamp
// within 150 s of the hub's wall clock (Alexa's replay window). A rejected request gets 400
// alexa_rejected. A public request is first checked for Amazon's signature (./signature.ts, on by
// default), and the gate already limits what a public request can reach.
//
// Spee answers to several invocation names, one development skill per name, all on this endpoint
// (docs/alexa.md, "Skill names"). The accepted ids are:
//   - ALEXA_SKILL_ID, else alexa/skill-id.json (the "speech coach" skill);
//   - each id in ALEXA_SKILL_IDS (comma-separated);
//   - each skill in alexa/skill-ids.local.json, which `npm run alexa:deploy` writes (git-ignored).
// An entry that is not an amzn1.ask.skill.* id is skipped and reported, never accepted.
import { readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
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

// The skills `npm run alexa:deploy` set up, by invocation name. Written by the deploy, read by the hub.
export const LOCAL_SKILLS_PATH = join(REPO_ROOT, "alexa/skill-ids.local.json");
const SKILL_ID_RE = /^amzn1\.ask\.skill\.[A-Za-z0-9-]+$/;
export const isSkillId = (v: unknown): v is string => typeof v === "string" && SKILL_ID_RE.test(v);
const label = (path: string) => {
  const r = relative(REPO_ROOT, path);
  return !r || r.startsWith("..") ? basename(path) : r;
};

// { skills: { "<invocation name>": "<skill id>" } }. A missing file is no skills; a file that does not
// parse, or an entry that is not a skill id, is skipped with a warning.
export function readLocalSkills(path = LOCAL_SKILLS_PATH): { skills: Record<string, string>; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { skills: {}, warnings: [] };
  }
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { skills: {}, warnings: [`${label(path)} does not parse; none of its skills are accepted`] };
  }
  const raw = j && typeof j === "object" ? (j as { skills?: unknown }).skills : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { skills: {}, warnings: [`${label(path)} has no "skills" object; none of its skills are accepted`] };
  const skills: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [name, id] of Object.entries(raw)) {
    if (isSkillId(id)) skills[name] = id;
    else warnings.push(`${label(path)}: the skill for "${name}" is not an amzn1.ask.skill.* id; skipped`);
  }
  return { skills, warnings };
}

export interface SkillIds {
  ids: string[]; // every accepted skill id, without duplicates
  names: Record<string, string>; // skill id -> invocation name, where the deploy recorded one
  sources: string[]; // where the ids came from (never the ids themselves)
  warnings: string[];
}

// ALEXA_SKILL_IDS: comma-separated skill ids. An entry that is not one is skipped with a warning.
export function parseSkillIdList(raw: string | undefined): { ids: string[]; warnings: string[] } {
  const list = (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const warnings: string[] = [];
  const ids = list.filter((id, i) => isSkillId(id) || void warnings.push(`ALEXA_SKILL_IDS: entry ${i + 1} is not an amzn1.ask.skill.* id; skipped`));
  return { ids, warnings };
}

export function resolveSkillIds(env: Record<string, string | undefined> = process.env, paths: { config?: string; local?: string } = {}): SkillIds {
  const ids = new Set<string>();
  const sources: string[] = [];
  const warnings: string[] = [];
  const primary = env.ALEXA_SKILL_ID?.trim();
  ids.add(resolveSkillId(env, paths.config));
  sources.push(primary ? "ALEXA_SKILL_ID" : label(paths.config ?? SKILL_CONFIG_PATH));
  const listed = parseSkillIdList(env.ALEXA_SKILL_IDS);
  listed.ids.forEach((id) => ids.add(id));
  warnings.push(...listed.warnings);
  if (listed.ids.length + listed.warnings.length) sources.push("ALEXA_SKILL_IDS");
  const local = readLocalSkills(paths.local);
  warnings.push(...local.warnings);
  const names: Record<string, string> = {};
  for (const [name, id] of Object.entries(local.skills)) {
    ids.add(id);
    names[id] = name;
  }
  if (Object.keys(local.skills).length) sources.push(label(paths.local ?? LOCAL_SKILLS_PATH));
  return { ids: [...ids], names, sources, warnings };
}

// resolveSkillIds, read again whenever the local file changes, so the skills a deploy creates while
// the hub runs are accepted without a restart.
export function skillIdSource(env: Record<string, string | undefined> = process.env, paths: { config?: string; local?: string } = {}): () => SkillIds {
  const local = paths.local ?? LOCAL_SKILLS_PATH;
  let cache: { sig: string; value: SkillIds } | null = null;
  const sig = () => {
    try {
      const st = statSync(local);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "none";
    }
  };
  return () => {
    const now = sig();
    if (!cache || cache.sig !== now) cache = { sig: now, value: resolveSkillIds(env, paths) };
    return cache.value;
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

// `skillId`: the one accepted id, or the list of them. Both application ids in the request must be
// the same accepted id.
export function verifyAlexaRequest(body: unknown, opts: { skillId: string | readonly string[]; now: number; toleranceMs?: number }): VerifyResult {
  if (!body || typeof body !== "object") return { ok: false, reason: "not an Alexa request envelope" };
  const env = body as Partial<AlexaRequestEnvelope>;
  if (!env.request || typeof env.request !== "object" || typeof env.request.type !== "string") return { ok: false, reason: "not an Alexa request envelope (no request.type)" };
  const ids = [env.session?.application?.applicationId, env.context?.System?.application?.applicationId].filter((x): x is string => typeof x === "string");
  if (!ids.length) return { ok: false, reason: "no application id" };
  const accepted: readonly string[] = typeof opts.skillId === "string" ? [opts.skillId] : opts.skillId;
  if (ids.some((id) => id !== ids[0]) || !accepted.includes(ids[0]!)) return { ok: false, reason: "wrong skill id" };
  const ts = Date.parse(String(env.request.timestamp ?? ""));
  if (!Number.isFinite(ts)) return { ok: false, reason: "no request timestamp" };
  if (Math.abs(opts.now - ts) > (opts.toleranceMs ?? ALEXA_TIMESTAMP_TOLERANCE_MS)) return { ok: false, reason: "timestamp outside the 150 s window" };
  return { ok: true };
}

// The progressive-response API endpoints Alexa hands out (NA, EU, FE). The skill only ever POSTs a
// directive to one of these, so a forged request cannot point the hub at another host.
export const ALEXA_API_ENDPOINT_RE = /^https:\/\/api(\.(eu|fe))?\.amazonalexa\.com\/?$/;
export const isAlexaApiEndpoint = (url: string | undefined): boolean => !!url && ALEXA_API_ENDPOINT_RE.test(url);
