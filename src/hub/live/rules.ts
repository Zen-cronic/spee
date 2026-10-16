// Live rules: which rules fire on a window, and the wrist text for each. Thresholds are relative to
// the wearer's baseline (live/baseline.ts) and come from the principles' JSON block:
//   hedge-streak  at least max(3, 2 x expected) hedges in 120 s
//   like-streak   at least max(4, 2 x expected) "like" fillers in 120 s
//   monologue     90 s or more
//   fast-rate     the 2-minute rate at or above wpmFast (off by default)
// where expected = the baseline rate x the wearer's words in the window. A rule acts once per
// streak: after a nudge (or a skip), only lines after that one count toward its next firing, and
// a monologue nudges once per run.
//
// The wrist text is generated from the rule and its numbers only: it never quotes a transcript.
import { WRIST_TEXT_MAX, type CoachThresholds, type NudgeRule } from "../contract.js";
import type { RuleEvidence, Thresholds } from "./window.js";

export function windowThresholds(t: CoachThresholds): Thresholds {
  return { hedges: t.hedges, like: t.like, monologue: t.monologue, rate: { wpmFast: t.rate.wpmFast } };
}

// The rules that should act now: enabled, over threshold and not yet acted on.
export function firing(evidence: RuleEvidence[], enabled: (r: NudgeRule) => boolean): RuleEvidence[] {
  return evidence.filter((e) => e.over && e.fresh && enabled(e.rule));
}

const mins = (ms: number) => {
  const m = Math.round(ms / 30_000) / 2;
  return `${m % 1 ? m.toFixed(1) : m} min`;
};

export function nudgeText(e: RuleEvidence): string {
  const window = mins(e.windowMs ?? 120_000);
  let t: string;
  switch (e.rule) {
    case "hedge-streak":
      t = `[coach] ${e.value} hedges in ${window}. Say it plainly.`;
      break;
    case "like-streak":
      t = `[coach] ${e.value} "like"s in ${window}. Pause instead.`;
      break;
    case "monologue":
      t = `[coach] ${mins(e.value)} without a break. Check in.`;
      break;
    case "fast-rate":
      t = `[coach] ${e.value} words a minute. Slow down.`;
      break;
  }
  return clipWrist(t);
}

export function clipWrist(t: string): string {
  const s = t.startsWith("[coach] ") ? t : `[coach] ${t}`;
  return s.length <= WRIST_TEXT_MAX ? s : `${s.slice(0, WRIST_TEXT_MAX - 1).trimEnd()}…`;
}
