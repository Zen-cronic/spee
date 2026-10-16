// Contract-check module for the mcp plugin (packet C). STUB: reports "pending" until packet C
// replaces it. To check: MCP over /mcp: tools/list matches MCP_TOOLS; start_drill -> card.open on the TV -> submit_attempt -> Bee replay -> get_verdict graded; errors come back as isError.
import type { CheckCtx, CheckResult } from "./types.js";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  void ctx;
  return { name: "mcp", passed: 0, failed: 0, pending: true, note: "stub: packet C has not landed" };
}
