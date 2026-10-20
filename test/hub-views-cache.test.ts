// The drill-stripped sessions and each source's selection are computed once per version of the
// data, shared by /api/stats, /api/transfer and /api/settings, and recomputed when sessions or
// attempts change. Synthetic demo data only.
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ dedup: 0 }));
vi.mock("../src/real/instruments.js", async (orig) => {
  const m = await orig<typeof import("../src/real/instruments.js")>();
  return { ...m, meetingDedup: (...a: Parameters<typeof m.meetingDedup>) => (calls.dedup++, m.meetingDedup(...a)) };
});

const { CoachHub } = await import("../src/hub/core.js");
const { buildPrereg, buildSessions, DEMO_TZ } = await import("../src/hub/demoData.js");
const { SettingsBook } = await import("../src/hub/settings.js");

function hub() {
  const now = Date.parse("2026-10-20T13:30:00-04:00");
  const h = new CoachHub({ mode: "demo", clock: () => now, tz: DEMO_TZ, deck: { cards: [] }, deckPath: null, attemptsPath: null, sessions: buildSessions(), prereg: buildPrereg(), preregPath: "test", wearer: { minScore: 0.5 } as never, attempts: [] } as never);
  h.drillEvents = () => [{ at: Date.parse("2026-10-15T12:00:00-04:00"), habitKeys: ["hedges", "filler:like"] }];
  return h;
}

describe("shared session views", () => {
  it("one meeting dedup for the settings report, the transfer and the stats with captions", () => {
    const h = hub();
    calls.dedup = 0;
    new SettingsBook({ hub: h, stateDir: null }).report("all");
    h.transfer("all");
    h.stats({ kind: "week" }, "all");
    h.stats({ kind: "all" }, "all");
    expect(calls.dedup).toBe(1);
    expect(h.sessionsFor("all")).toBe(h.sessionsFor("all"));
    h.dispose();
  });

  it("recomputed after addSessions and after an attempt changes", () => {
    const h = hub();
    const first = h.everydaySessions();
    expect(h.everydaySessions()).toBe(first);
    h.addSessions([{ id: "new-1", kind: "conversation", startMs: Date.parse("2026-10-20T10:00:00-04:00"), lines: [{ key: "u:x1", text: "The export is ready for launch today.", dom: "en", uncertain: false, spokenAt: Date.parse("2026-10-20T10:00:05-04:00") }] }]);
    const second = h.everydaySessions();
    expect(second).not.toBe(first);
    expect(second.some((s) => s.id === "new-1")).toBe(true);
    // the same sentence becomes a drill line once an attempt holds it
    h.attempts.push({ id: "att_c", cardId: "c", sessionId: null, status: "polling", counted: false, createdAt: Date.parse("2026-10-20T10:00:10-04:00"), settledAt: null, provisional: { source: "phone", text: "the export is ready for launch today", speechEndAt: Date.parse("2026-10-20T10:00:08-04:00"), grade: {} as never }, bee: null, final: null, agreement: null, reason: "", box: null });
    expect(h.everydaySessions().find((s) => s.id === "new-1")!.lines).toEqual([]);
    h.dispose();
  });

  it("checks the cache in O(1): no attempt is read again until the data changes", () => {
    const h = hub();
    let reads = 0;
    const many = Array.from({ length: 200 }, (_, i) => {
      const a = { id: `att_${i}`, cardId: "c", sessionId: null, status: "graded", counted: true, createdAt: Date.parse("2026-10-20T09:00:00-04:00") + i * 1000, settledAt: null, provisional: null, final: null, agreement: null, reason: "", box: null } as Record<string, unknown>;
      const bee = { text: "a line that no session holds at all", utteranceIds: [i], speakerScore: 0.9, via: "stream", latencyMs: 1000, coverage: null, replay: false };
      Object.defineProperty(a, "bee", { get: () => (reads++, bee), enumerable: true });
      return a;
    });
    h.attempts.push(...(many as never[]));
    h.everydaySessions();
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) (h.everydaySessions(), h.sessionsFor("all"), h.drillLines());
    expect(reads).toBe(afterFirst);
    h.dataChanged();
    h.everydaySessions();
    expect(reads).toBeGreaterThan(afterFirst);
    h.dispose();
  });
});
