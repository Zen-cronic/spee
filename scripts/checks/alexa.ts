// Contract-check module for the alexa plugin (packet C). STUB: reports "pending" until packet C
// replaces it. To check: POST /alexa: Launch -> Attempt (< 1 s, pending) -> early HowDidIDo -> verdict; HowAmIDoing speaks /api/coach/now; a bad skill id or stale timestamp is rejected.
import type { CheckCtx, CheckResult } from "./types.js";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  void ctx;
  return { name: "alexa", passed: 0, failed: 0, pending: true, note: "stub: packet C has not landed" };
}
