// Opt-in live check of `bee stream` (skipped by default; it needs an authenticated bee CLI).
//   BEE_STREAM_LIVE=1 npx vitest run test/hub-bee-live.test.ts
// It spawns the stream for 12 s and checks that the process stays up and every line it emits
// parses. It prints event types and counts only, never text.
import { describe, expect, it } from "vitest";
import { spawnBeeStream, type BeeEvent } from "../src/hub/bee.js";

describe.skipIf(!process.env.BEE_STREAM_LIVE)("bee stream (live)", () => {
  it("connects and parses events", async () => {
    const events: BeeEvent[] = [];
    const exits: unknown[] = [];
    const h = spawnBeeStream({ onEvent: (e) => events.push(e), log: (e, d) => e === "bee.stream.exit" && exits.push(d) });
    await new Promise((r) => setTimeout(r, 12_000));
    h.stop();
    const types = events.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
    console.log("bee stream event types:", types);
    expect(exits).toHaveLength(0);
  }, 20_000);
});
