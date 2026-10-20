// The v1 payload types copied import-free into src/hub/contract.ts must match the hub's own types,
// so the TV apps and the simulator can copy contract.ts and still be right. A mismatch is a tsc
// error in this file (npx tsc --noEmit); the runtime assertion just keeps vitest honest.
import { describe, expect, it } from "vitest";
import type * as C from "../src/hub/contract.js";
import type { Attempt, CoachHub, DrillSession } from "../src/hub/core.js";
import type { CardView } from "../src/hub/cards.js";
import type { GradeResult, Check } from "../src/hub/grade.js";
import type { Habit } from "../src/hub/habits.js";
import type { BoxChange, DeckSummary } from "../src/hub/scheduler.js";
import type { FirstSignal, HabitRates, Period, Rate, TransferClaim, TransferHabit, TransferReport } from "../src/hub/stats.js";
import type { buildBrief } from "../src/hub/brief.js";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assignable<A, B> = [A] extends [B] ? true : false;

const mutual: Record<string, true> = {
  habit: true satisfies Mutual<Habit, C.Habit>,
  card: true satisfies Mutual<CardView, C.CardView>,
  check: true satisfies Mutual<Check, C.GradeCheck>,
  grade: true satisfies Mutual<GradeResult, C.GradeResult>,
  box: true satisfies Mutual<BoxChange, C.BoxChange>,
  deck: true satisfies Mutual<DeckSummary, C.DeckSummary>,
  attempt: true satisfies Mutual<Attempt, C.Attempt>,
  session: true satisfies Mutual<DrillSession, C.DrillSession>,
  rate: true satisfies Mutual<Rate, C.Rate>,
  habitRates: true satisfies Mutual<HabitRates, C.HabitRates>,
  period: true satisfies Mutual<Period, C.Period>,
  transferHabit: true satisfies Mutual<TransferHabit, C.TransferHabit>,
  transferClaim: true satisfies Mutual<TransferClaim, C.TransferClaim>,
  firstSignal: true satisfies Mutual<FirstSignal, C.FirstSignal>,
};
// What the routes return conforms to the contract type a surface reads.
const conforms: Record<string, true> = {
  summary: true satisfies Assignable<ReturnType<CoachHub["sessionSummary"]>, C.SessionSummary>,
  state: true satisfies Assignable<ReturnType<CoachHub["sessionState"]> & { mode: "live" | "demo"; dataLabel: string }, C.HubState>,
  verdict: true satisfies Assignable<NonNullable<ReturnType<CoachHub["verdict"]>>, C.VerdictResponse>,
  stats: true satisfies Assignable<ReturnType<CoachHub["stats"]>, C.StatsResponse>,
  transfer: true satisfies Assignable<{ dataLabel: string } & TransferReport, C.TransferResponse>,
  brief: true satisfies Assignable<Awaited<ReturnType<typeof buildBrief>>, C.Brief>,
};

describe("contract.ts v1 types", () => {
  it("mirror the hub's own types", () => {
    expect(Object.values({ ...mutual, ...conforms }).every((v) => v === true)).toBe(true);
  });
});
