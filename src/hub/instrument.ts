// GET /api/instrument: Bee and meeting captions on the meetings both heard (src/real/instruments.ts
// pairMeetings over the hub's loaded sessions). Aggregates only: words, counts, per-100 rates and
// their 95% intervals pooled over the pairs (transcriberRates), and whether the two transcribers
// gave similar numbers on each habit. No line text, no session id.
//
// "Similar" needs enough of each habit to mean something: both sides hold INSTRUMENT_MIN_COUNT of
// it or INSTRUMENT_ENOUGH_WORDS words, the two intervals overlap, and the rates are within
// INSTRUMENT_TOLERANCE. Otherwise the habit is not compared (null). Captions that are copies of
// Bee's own lines (the synthetic demo) are never compared. The pre-registered check stays Bee-only
// (prereg/transfer.json).
import { localDate } from "../real/deck.js";
import { pairMeetings, transcriberRates } from "../real/instruments.js";
import { INSTRUMENT_ENOUGH_WORDS, INSTRUMENT_HABITS, INSTRUMENT_MIN_COUNT, INSTRUMENT_MIN_WORDS, INSTRUMENT_TOLERANCE, type InstrumentClaim, type InstrumentHabit, type InstrumentResponse } from "./contract.js";
import type { Rate, StatSession } from "./stats.js";

/** Within tolerance: the larger of an absolute gap per 100 words and a share of the higher rate. */
export function ratesAgree(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(INSTRUMENT_TOLERANCE.per100, INSTRUMENT_TOLERANCE.relative * Math.max(a, b)) + 1e-9;
}

const overlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

/** One habit compared: null with too little of it on either side, else intervals overlap and rates within tolerance. */
export function habitAgrees(c: Rate, cWords: number, b: Rate, bWords: number): boolean | null {
  if (cWords < INSTRUMENT_MIN_WORDS || bWords < INSTRUMENT_MIN_WORDS) return null;
  const enough = (c.count >= INSTRUMENT_MIN_COUNT && b.count >= INSTRUMENT_MIN_COUNT) || (cWords >= INSTRUMENT_ENOUGH_WORDS && bWords >= INSTRUMENT_ENOUGH_WORDS);
  if (!enough) return null;
  return overlap(c.ci95, b.ci95) && ratesAgree(c.per100, b.per100);
}

export function instrumentReport(sessions: StatSession[], o: { nowMs: number; tz?: string; dataLabel: string; synthetic: boolean }): InstrumentResponse {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Each pair's Bee lines are the ones inside that meeting's window, and no Bee line is in two pairs.
  const pairs = pairMeetings(sessions).pairs.map((p) => ({ ...p, m: byId.get(p.meeting)!, b: p.bee.map((id) => byId.get(id)!) }));
  const copies = pairs.filter((p) => p.m.copyOf != null).length;
  const cap = transcriberRates(pairs.flatMap((p) => p.captionLines));
  const bee = transcriberRates(pairs.flatMap((p) => p.beeLines));
  const weak = pairs.filter((p) => p.match === "nearest-start").length;
  const words = { captions: cap.words, bee: bee.words };
  const habits: InstrumentHabit[] = INSTRUMENT_HABITS.map((habit) => {
    const c = cap.habits[habit];
    const b = bee.habits[habit];
    return { habit, captionsPer100: c.per100, beePer100: b.per100, captions: { count: c.count, ci95: c.ci95 }, bee: { count: b.count, ci95: b.ci95 }, agree: copies ? null : habitAgrees(c, cap.words, b, bee.words) };
  });
  const practised = habits.filter((h) => h.habit === "hedges" || h.habit === "filler:like");
  const claim: InstrumentClaim = !pairs.length ? "no-pairs" : practised.some((h) => h.agree === null) ? "too-little-data" : practised.every((h) => h.agree) ? "practised-agree" : "practised-differ";
  const dates = pairs.map((p) => localDate(p.m.startMs, o.tz)).sort();
  return {
    dataLabel: o.dataLabel,
    synthetic: o.synthetic || pairs.some((p) => !!p.m.synthetic || p.b.some((b) => !!b.synthetic)),
    generatedAt: new Date(o.nowMs).toISOString(),
    pairs: pairs.length,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    words,
    minWords: INSTRUMENT_MIN_WORDS,
    minCount: INSTRUMENT_MIN_COUNT,
    enoughWords: INSTRUMENT_ENOUGH_WORDS,
    tolerance: { ...INSTRUMENT_TOLERANCE },
    habits,
    claim,
    note: `the same meetings heard by Bee and by the meeting's captions, Bee's lines cut to each meeting's time, counted with the same habit rules; aggregates only. The pre-registered check counts Bee only.${weak ? ` ${weak} of the ${pairs.length} matched by start time only, a weaker match: an end time was missing.` : ""}${copies ? ` ${copies} of the ${pairs.length} have synthetic captions copied from Bee's own lines, so the two are not compared.` : ""}`,
  };
}
