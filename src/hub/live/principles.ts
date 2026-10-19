// Coaching principles: coach/principles.local.md (the operator's own notes, gitignored) when it
// exists, else the committed generic coach/principles.template.md. The fenced JSON block at the
// end sets the thresholds (CoachThresholds); the prose is the rubric for the optional model recap.
//
// PRIVACY. The text is held in memory and injected into the recap prompt at runtime only. It is
// never logged, served, put in an event or written to disk. describe() reports which file is in
// use and how many shingles it has, nothing more. A model phrasing that shares any 5-word shingle
// with the principles is rejected (sharesShingle), and the template phrasing is used instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoachThresholds } from "../contract.js";
import { REPO_ROOT } from "../static.js";

export const LOCAL_PRINCIPLES = "coach/principles.local.md";
export const TEMPLATE_PRINCIPLES = "coach/principles.template.md";

// The template's numbers, used when no file parses.
export const DEFAULT_THRESHOLDS: CoachThresholds = {
  version: 1,
  rate: { wpmSlow: 110, wpmFast: 175, fastRateNudge: false },
  pause: { minPauseMs: 250, longPauseMs: 2000 },
  volume: { quietDbfs: -35, loudDbfs: -12 },
  pitch: { minHz: 70, maxHz: 400, monotoneSemitones: 3 },
  hedges: { streakMin: 3, windowMs: 120_000, expectedMultiplier: 2 },
  like: { streakMin: 4, windowMs: 120_000, expectedMultiplier: 2 },
  monologue: { nudgeMs: 90_000 },
  recap: { minWearerWords: 60, momentMaxWords: 12, idleEndMs: 90_000 },
};

export interface Principles {
  source: "local" | "template" | "builtin";
  thresholds: CoachThresholds;
  thresholdsFrom: "file" | "default";
  // Runtime only: the rubric prose (without the JSON block). Never log or serve it.
  readonly rubric: string;
  readonly shingleCount: number;
  sharesShingle(text: string): boolean;
}

export const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const shingles = (s: string, k = 5): string[] => {
  const t = fold(s).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + k <= t.length; i++) out.push(t.slice(i, i + k).join(" "));
  return out;
};
// Shingles made only of these words are not distinctive ("i don't know if the").
const FUNCTION = new Set("i you we it the a an and to of is that this in on for be do don't know if it's i'm so but um uh like yeah okay oh at with your as are or not can".split(" "));

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function validThresholds(o: unknown): o is CoachThresholds {
  const t = o as CoachThresholds;
  return (
    !!t &&
    t.version === 1 &&
    num(t.rate?.wpmFast) &&
    num(t.rate?.wpmSlow) &&
    typeof t.rate?.fastRateNudge === "boolean" &&
    num(t.pause?.minPauseMs) &&
    num(t.hedges?.streakMin) &&
    num(t.hedges?.windowMs) &&
    num(t.hedges?.expectedMultiplier) &&
    num(t.like?.streakMin) &&
    num(t.like?.windowMs) &&
    num(t.like?.expectedMultiplier) &&
    num(t.monologue?.nudgeMs) &&
    num(t.recap?.minWearerWords) &&
    num(t.recap?.momentMaxWords) &&
    num(t.recap?.idleEndMs)
  );
}

// The last ```json block of the file, if it parses as CoachThresholds.
export function parseThresholds(md: string): CoachThresholds | null {
  const blocks = [...md.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  try {
    const o = JSON.parse(last[1]!);
    return validThresholds(o) ? { ...DEFAULT_THRESHOLDS, ...o } : null;
  } catch {
    return null;
  }
}

export function principlesFromText(md: string | null, source: Principles["source"]): Principles {
  const th = md ? parseThresholds(md) : null;
  const rubric = (md ?? "").replace(/```json[\s\S]*?```/g, "").trim();
  // Link targets are public references, not private wording.
  const set = new Set(shingles(rubric.replace(/https?:\/\/\S+/g, " ")).filter((g) => !g.split(" ").every((w) => FUNCTION.has(w))));
  return {
    source,
    thresholds: th ?? DEFAULT_THRESHOLDS,
    thresholdsFrom: th ? "file" : "default",
    rubric,
    shingleCount: set.size,
    sharesShingle: (text: string) => shingles(text).some((g) => set.has(g)),
  };
}

export function loadPrinciples(root = REPO_ROOT): Principles {
  const local = join(root, LOCAL_PRINCIPLES);
  if (existsSync(local)) return principlesFromText(readFileSync(local, "utf8"), "local");
  const tpl = join(root, TEMPLATE_PRINCIPLES);
  if (existsSync(tpl)) return principlesFromText(readFileSync(tpl, "utf8"), "template");
  return principlesFromText(null, "builtin");
}
