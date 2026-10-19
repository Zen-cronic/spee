// A verdict Bee delivers after its drill session ended: the hub re-sends the session summary with
// the attempt settled (overrules included), so the TV and the phone never keep "still with Bee".
import { describe, expect, it } from "vitest";
import type { Attempt, HubEvent } from "../src/hub/core.js";
import { demoSetup } from "../src/hub/setup.js";

const verify = (hub: unknown, a: Attempt, beeText: string) =>
  (hub as { onVerification: (v: unknown) => void }).onVerification({ attemptId: a.id, cardId: a.cardId, status: "verified", via: "stream", speakerScore: 0.9, beeUtteranceIds: [], beeText, coverage: 1, latencyMs: 9000, reason: "wearer-tagged line" });

describe("a late verdict after the session ended", () => {
  it("re-sends session.ended with the attempt settled, Bee's overrule included", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const events: HubEvent[] = [];
    hub.on("event", (e: HubEvent) => events.push(e));
    const { card } = hub.startSession({ by: "tv" });
    const a = hub.submit({ text: "something else entirely", source: "phone" }) as Attempt;
    expect(a.provisional?.grade.pass).toBe(false);
    const first = hub.endSession()!;
    expect(first.pending).toBe(1);
    verify(hub, a, card!.resay);
    const ended = events.filter((e) => e.topic === "session.ended").map((e) => e.payload.summary as typeof first);
    expect(ended).toHaveLength(2);
    expect(ended[1]).toMatchObject({ sessionId: first.sessionId, pending: 0, passed: 1, beeOverrules: 1 });
    const order = events.map((e) => e.topic);
    expect(order.lastIndexOf("session.ended")).toBeGreaterThan(order.lastIndexOf("attempt.graded"));
    hub.dispose();
  });
  it("stays quiet once another drill has started, so its card is not closed on the screens", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const events: HubEvent[] = [];
    const { card } = hub.startSession({ by: "tv" });
    const a = hub.submit({ text: card!.resay, source: "phone" }) as Attempt;
    hub.endSession();
    hub.openCard({ by: "tv" });
    hub.on("event", (e: HubEvent) => events.push(e));
    verify(hub, a, card!.resay);
    expect(events.map((e) => e.topic)).not.toContain("session.ended");
    hub.dispose();
  });
});
