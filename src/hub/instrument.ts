// GET /api/instrument: Bee and meeting captions on the meetings both heard (src/real/instruments.ts
// pairMeetings over the hub's loaded sessions). Aggregates only: words and per-100 rates pooled over
// the pairs, and whether the two transcribers agree on each habit. No line text, no session id.
//
// It is what lets a screen say "Captions and Bee agree on these two habits" next to the secondary,
// captions-included before/after, and only when the pooled rates are within INSTRUMENT_TOLERANCE.
// The pre-registered check stays Bee-only (prereg/transfer.json).
import { localDate } from "../real/deck.js";
import { pairMeetings } from "../real/instruments.js";
import { wordCount } from "../real/text.js";
import { INSTRUMENT_HABITS, INSTRUMENT_MIN_WORDS, INSTRUMENT_TOLERANCE, type InstrumentClaim, type InstrumentHabit, type InstrumentResponse } from "./contract.js";
import { countHabitKey } from "./habits.js";
import type { StatSession } from "./stats.js";

const r2 = (x: number) => Math.round(x * 100) / 100;
const english = (s: StatSession) => s.lines.filter((l) => !l.uncertain && l.dom === "en").map((l) => l.text);

/** Counts for one instrument habit in some lines ("um-uh" is the two filler keys together). */
function countIn(key: (typeof INSTRUMENT_HABITS)[number], lines: string[]): number {
  const keys = key === "um-uh" ? ["filler:um", "filler:uh"] : [key];
  return lines.reduce((n, t) => n + keys.reduce((m, k) => m + countHabitKey(k, t), 0), 0);
}

/** Within tolerance: the larger of an absolute gap per 100 words and a share of the higher rate. */
export function ratesAgree(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(INSTRUMENT_TOLERANCE.per100, INSTRUMENT_TOLERANCE.relative * Math.max(a, b)) + 1e-9;
}

export function instrumentReport(sessions: StatSession[], o: { nowMs: number; tz?: string; dataLabel: string; synthetic: boolean }): InstrumentResponse {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const pairs = pairMeetings(sessions)
    .map((p) => ({ m: byId.get(p.meeting)!, b: byId.get(p.bee)! }))
    .filter((p) => p.m && p.b);
  const cap = pairs.flatMap((p) => english(p.m));
  const bee = [...new Map(pairs.map((p) => [p.b.id, p.b])).values()].flatMap(english); // a Bee conversation once, even if two meetings pair with it
  const words = { captions: cap.reduce((n, t) => n + wordCount(t), 0), bee: bee.reduce((n, t) => n + wordCount(t), 0) };
  const enough = pairs.length > 0 && words.captions >= INSTRUMENT_MIN_WORDS && words.bee >= INSTRUMENT_MIN_WORDS;
  const per100 = (n: number, w: number) => (w ? r2((n / w) * 100) : 0);
  const habits: InstrumentHabit[] = INSTRUMENT_HABITS.map((habit) => {
    const c = per100(countIn(habit, cap), words.captions);
    const b = per100(countIn(habit, bee), words.bee);
    return { habit, captionsPer100: c, beePer100: b, agree: enough ? ratesAgree(c, b) : null };
  });
  const practised = habits.filter((h) => h.habit === "hedges" || h.habit === "filler:like");
  const claim: InstrumentClaim = !pairs.length ? "no-pairs" : !enough ? "too-little-data" : practised.every((h) => h.agree) ? "practised-agree" : "practised-differ";
  const dates = pairs.map((p) => localDate(p.m.startMs, o.tz)).sort();
  return {
    dataLabel: o.dataLabel,
    synthetic: o.synthetic || pairs.some((p) => !!p.m.synthetic || !!p.b.synthetic),
    generatedAt: new Date(o.nowMs).toISOString(),
    pairs: pairs.length,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    words,
    minWords: INSTRUMENT_MIN_WORDS,
    tolerance: { ...INSTRUMENT_TOLERANCE },
    habits,
    claim,
    note: "the same meetings heard by Bee and by the meeting's captions, counted with the same habit rules; aggregates only. The pre-registered check counts Bee only.",
  };
}
