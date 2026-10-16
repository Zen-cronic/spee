// Contract-check module for the mirror plugin (packet B). STUB: reports "pending" until packet B
// replaces it. To check: practice.meters from the phone reach the room's screens only (never SSE, recent or the mic); practice.summary and mirror.focus are sequenced; POST /api/demo/mirror.
import type { CheckCtx, CheckResult } from "./types.js";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  void ctx;
  return { name: "mirror", passed: 0, failed: 0, pending: true, note: "stub: packet B has not landed" };
}
