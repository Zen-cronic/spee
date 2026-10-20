// The wearer's baseline: what the live rules and the recap compare against.
//
// Habit rates come from the hub's Bee sessions (kind "conversation": drills and voice notes are
// excluded, and drill lines are left out as in the transfer: CoachHub.everydaySessions), this week
// when it has at least MIN_BASELINE_WORDS, else every Bee conversation. The
// rate of speech comes from Bee line timing in real/corpus.json (start/end of each wearer line);
// the measured median on 2026-10-16 was 140 wpm, which is also the fallback and the demo value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveBaseline } from "../contract.js";
import type { CoachHub } from "../core.js";
import { wordCount } from "../../real/text.js";

export const MIN_BASELINE_WORDS = 400;
export const DEFAULT_WPM = 140; // real median, 2026-10-16

export interface Baseline extends LiveBaseline {
  vaguePer100: number;
  restartsPer100: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function computeBaseline(hub: CoachHub, opts: { wpm: number | null; synthetic: boolean }): Baseline {
  let st = hub.stats({ kind: "week" });
  let range = "week";
  if (st.habits.words < MIN_BASELINE_WORDS) {
    const all = hub.stats({ kind: "all" });
    if (all.habits.words > st.habits.words) (st = all), (range = "all Bee conversations");
  }
  const h = st.habits;
  const per100 = (n: number) => (h.words ? r2((n / h.words) * 100) : 0);
  return {
    source: `bee ${range} (non-drill conversations${opts.synthetic ? "; synthetic" : ""})`,
    range: range === "week" ? "week" : "all",
    words: h.words,
    hedgesPer100: h.hedges.per100,
    likesPer100: per100(h.fillers.breakdown.like ?? 0),
    fillersPer100: h.fillers.per100,
    wpm: opts.wpm,
    vaguePer100: h.vague.per100,
    restartsPer100: h.restarts.per100,
  };
}

// Median words per minute of the wearer's English Bee lines in real/corpus.json (lines of at
// least 2 s and 4 words; implausible rates are dropped). null when there are too few lines.
export function corpusWpm(dir = "real"): number | null {
  const p = join(dir, "corpus.json");
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as { lines?: { kind?: string; dom?: string; uncertain?: boolean; start?: number | null; end?: number | null; text?: string }[] };
    const rates = (c.lines ?? [])
      .filter((l) => l.kind === "conversation" && l.dom === "en" && !l.uncertain && l.start != null && l.end != null && l.end - l.start >= 2)
      .map((l) => ({ words: wordCount(l.text ?? ""), s: l.end! - l.start! }))
      .filter((x) => x.words >= 4)
      .map((x) => (x.words / x.s) * 60)
      .filter((w) => w >= 60 && w <= 320)
      .sort((a, b) => a - b);
    if (rates.length < 10) return null;
    return Math.round(rates[Math.floor(rates.length / 2)]!);
  } catch {
    return null;
  }
}
