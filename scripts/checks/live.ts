// Contract-check module for the live plugin (packet A). STUB: reports "pending" until packet A
// replaces it. To check: demo hedge streak -> nudge.sent -> second streak nudge.skipped (cooldown) -> idle -> recap.ready; GET /api/coach/now reflects the recap; live.window at most 1 per 3 s.
import type { CheckCtx, CheckResult } from "./types.js";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  void ctx;
  return { name: "live", passed: 0, failed: 0, pending: true, note: "stub: packet A has not landed" };
}
