// Live rules: which rules fire on a window, and the wrist text for each. Thresholds are relative to
// the wearer's baseline (live/baseline.ts) and come from the principles' JSON block:
//   hedge-streak  at least max(3, 2 x expected) hedges (shown as "unsure words") in 120 s
//   like-streak   at least max(4, 2 x expected) "like" fillers in 120 s
//   monologue     90 s or more
//   fast-rate     the 2-minute rate at or above wpmFast (off by default)
// where expected = the baseline rate x the wearer's words in the window. A rule acts once per
// streak: after a nudge (or a skip), only lines after that one count toward its next firing, and
// a monologue nudges once per run.
//
// The wrist text is generated from the rule and its numbers only: it never quotes a transcript.
import { WRIST_TEXT_MAX, type CoachThresholds, type CUE_HABITS, type NudgeRule } from "../contract.js";
import type { RuleEvidence, Thresholds } from "./window.js";

export type CueHabit = (typeof CUE_HABITS)[number];

export function windowThresholds(t: CoachThresholds): Thresholds {
  return { hedges: t.hedges, like: t.like, monologue: t.monologue, rate: { wpmFast: t.rate.wpmFast } };
}

// The rules that should act now: enabled, over threshold and not yet acted on.
export function firing(evidence: RuleEvidence[], enabled: (r: NudgeRule) => boolean): RuleEvidence[] {
  return evidence.filter((e) => e.over && e.fresh && enabled(e.rule));
}

const mins = (ms: number) => {
  const m = Math.round(ms / 30_000) / 2;
  return `${m % 1 ? m.toFixed(1) : m} ${m === 1 ? "minute" : "minutes"}`;
};

export function nudgeText(e: RuleEvidence): string {
  const window = mins(e.windowMs ?? 120_000);
  let t: string;
  switch (e.rule) {
    case "hedge-streak":
      t = `[coach] ${e.value} unsure words in ${window}. Say it plainly.`;
      break;
    case "like-streak":
      t = `[coach] "Like" ${e.value} times in ${window}. Pause instead.`;
      break;
    case "monologue":
      t = `[coach] You've talked ${mins(e.value)} straight. Check in.`;
      break;
    case "fast-rate":
      t = `[coach] ${e.value} words a minute. Slow down a little.`;
      break;
  }
  return clipWrist(t);
}

// The if-then wrist cues (POST /api/coach/cue, live/cue.ts): one fixed line per drilled habit a cue
// may name (CUE_HABITS). Fixed text, never a calendar title or a transcript line; each <= WRIST_TEXT_MAX.
export const CUE_TEXT: Record<CueHabit, string> = {
  hedges: '[coach] If asked for status: result first, no "I guess".',
  "filler:like": `[coach] If you need a second: pause, don't say "like".`,
};

export function clipWrist(t: string): string {
  const s = t.startsWith("[coach] ") ? t : `[coach] ${t}`;
  return s.length <= WRIST_TEXT_MAX ? s : `${s.slice(0, WRIST_TEXT_MAX - 1).trimEnd()}…`;
}
