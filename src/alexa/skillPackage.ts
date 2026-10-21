// One Alexa skill package per invocation name, generated from the one checked-in package
// (alexa/skill-package). Alexa takes one invocation name per skill and locale, so Spee's names are
// separate development skills that share everything else: the manifest (display name, listing,
// endpoint, screens) and the interaction model (intents and samples). Only the invocation name
// differs, and the example phrases and testing instructions are rewritten to use it, so the skills
// never drift apart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../hub/static.js";

// In priority order. "speech coach" is the existing skill (alexa/skill-id.json), the one tested on a
// real device; the others are extra development skills that alexa:deploy creates.
export const DEFAULT_INVOCATION_NAMES = ["speech coach", "spee coach", "spee"];
export const SKILL_PACKAGE_DIR = join(REPO_ROOT, "alexa/skill-package");

export interface LocaleListing {
  name: string;
  examplePhrases?: string[];
  [k: string]: unknown;
}
export interface SkillManifest {
  manifest: {
    publishingInformation: { locales: Record<string, LocaleListing>; testingInstructions?: string; [k: string]: unknown };
    apis: { custom: { endpoint: { uri: string; sslCertificateType: string }; [k: string]: unknown }; [k: string]: unknown };
    [k: string]: unknown;
  };
}
export interface InteractionModel {
  interactionModel: {
    languageModel: { invocationName: string; intents: { name: string; slots?: unknown[]; samples?: string[] }[]; [k: string]: unknown };
    [k: string]: unknown;
  };
}
export interface SkillPackage {
  invocationName: string;
  manifest: SkillManifest;
  models: Record<string, InteractionModel>; // by locale
}

// The checked-in package. Every locale's model must carry the same invocation name.
export function loadSkillPackage(locales: string[], dir = SKILL_PACKAGE_DIR): SkillPackage {
  const manifest = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")) as SkillManifest;
  const models: Record<string, InteractionModel> = {};
  for (const l of locales) models[l] = JSON.parse(readFileSync(join(dir, `interactionModels/custom/${l}.json`), "utf8")) as InteractionModel;
  const names = new Set(Object.values(models).map((m) => m.interactionModel.languageModel.invocationName));
  if (names.size !== 1) throw new Error(`${dir}: the locales do not share one invocation name`);
  return { invocationName: [...names][0]!, manifest, models };
}

export const normalizeName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// Amazon's rules for an English invocation name ("Choose the invocation name for a custom skill"):
// lower-case letters, spaces, possessive apostrophes and the periods of a spelled-out abbreviation;
// no launch phrase, connecting word or wake word, and not "skill" or "app". A problem stops the name
// before any ask call. One word is allowed only for a registered brand, so a one-word name is tried
// (the build may refuse it) and flagged.
const LAUNCH = ["run", "start", "play", "resume", "use", "launch", "ask", "open", "tell", "load", "begin", "enable"];
const CONNECTING = ["to", "from", "in", "using", "with", "about", "for", "that", "by", "if", "and", "whether"];
const BARRED = ["alexa", "amazon", "echo", "skill", "app"];
export function checkInvocationName(name: string): { problems: string[]; oneWord: boolean } {
  const problems: string[] = [];
  if (!/^[a-z][a-z'. ]*[a-z.]$/.test(name)) problems.push("use lower-case letters and spaces only");
  const words = name.split(" ").filter(Boolean);
  for (const w of words) {
    const bare = w.replace(/'s$|\.$/, "");
    if (LAUNCH.includes(bare)) problems.push(`"${w}" is a launch phrase`);
    else if (CONNECTING.includes(bare)) problems.push(`"${w}" is a connecting word`);
    else if (BARRED.includes(bare)) problems.push(`"${w}" is not allowed in an invocation name`);
  }
  return { problems, oneWord: words.length === 1 };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// `text` with every whole-word `from` (any case) replaced by `to`.
export const swapName = (text: string, from: string, to: string) => text.replace(new RegExp(`\\b${escapeRe(from)}\\b`, "gi"), to);

// The package for one invocation name: the checked-in one with this name, and `endpoint` when given.
export function packageFor(base: SkillPackage, name: string, endpoint?: string): SkillPackage {
  const manifest = structuredClone(base.manifest);
  const pub = manifest.manifest.publishingInformation;
  for (const listing of Object.values(pub.locales)) {
    if (listing.examplePhrases) listing.examplePhrases = listing.examplePhrases.map((p) => swapName(p, base.invocationName, name));
  }
  if (pub.testingInstructions) pub.testingInstructions = swapName(pub.testingInstructions, base.invocationName, name);
  if (endpoint) manifest.manifest.apis.custom.endpoint = { uri: endpoint, sslCertificateType: "Wildcard" };
  const models: Record<string, InteractionModel> = {};
  for (const [locale, m] of Object.entries(base.models)) {
    const copy = structuredClone(m);
    copy.interactionModel.languageModel.invocationName = name;
    models[locale] = copy;
  }
  return { invocationName: name, manifest, models };
}

// Whether an example phrase is one Alexa accepts for this skill: "Alexa, open <name>", or "Alexa, ask
// <name> [to] <a sample utterance of the model>" (the listing's rule: each phrase uses the skill's
// own invocation name and one of its samples).
export function examplePhraseOk(phrase: string, name: string, model: InteractionModel): boolean {
  const p = normalizeName(phrase.replace(/[?!.]$/, ""));
  if (p === `alexa, open ${name}`) return true;
  const m = new RegExp(`^alexa, ask ${escapeRe(name)} (?:to )?(.+)$`).exec(p);
  if (!m) return false;
  const samples = model.interactionModel.languageModel.intents.flatMap((i) => i.samples ?? []).map(normalizeName);
  return samples.includes(m[1]!);
}
