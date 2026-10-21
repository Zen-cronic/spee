// A round's summary counts each line once (`lines`), by its best result, beside the per-try counts:
// a line missed and then passed on a retry is one line passed, so a screen's tally under "1 of 2
// lines passed." never reads "1 passed, 2 not yet".
import { describe, expect, it } from "vitest";
import type { Attempt, HubEvent } from "../src/hub/core.js";
import { demoSetup } from "../src/hub/setup.js";

const DUE = ["demo:hedge-i-guess", "demo:vague-referent", "demo:vague-status", "demo:filler-like"]; // due on the demo day
// Bee hears the attempt (its text), or never tags it (null: unverified).
const heard = (hub: unknown, a: Attempt, beeText: string | null) =>
  (hub as { onVerification: (v: unknown) => void }).onVerification(
    beeText === null
      ? { attemptId: a.id, cardId: a.cardId, status: "unverified", via: null, speakerScore: null, beeUtteranceIds: [], beeText: null, coverage: null, latencyMs: null, reason: "never tagged" }
      : { attemptId: a.id, cardId: a.cardId, status: "verified", via: "stream", speakerScore: 0.9, beeUtteranceIds: [], beeText, coverage: 1, latencyMs: 9000, reason: "wearer-tagged line" },
  );

describe("a round's lines", () => {
  it("count each line once by its best result, while the per-try counts stay as they were", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const events: HubEvent[] = [];
    hub.on("event", (e: HubEvent) => events.push(e));
    const { card: a } = hub.startSession({ by: "tv", size: 4 });
    const [b, c, d] = DUE.filter((id) => id !== a!.id);
    const say = (resay: string) => hub.submit({ text: resay, source: "phone" }) as Attempt;
    // line A: not yet, then passed on a retry
    heard(hub, say(a!.resay), `Um, ${a!.resay}`);
    heard(hub, say(a!.resay), a!.resay);
    // line B: not yet, then a retry still with Bee
    const vb = hub.openCard({ cardId: b, by: "tv" })!;
    heard(hub, say(vb.resay), `Um, ${vb.resay}`);
    const retry = say(vb.resay);
    // line C: Bee didn't catch it
    const vc = hub.openCard({ cardId: c, by: "tv" })!;
    heard(hub, say(vc.resay), null);
    // line D: opened, never said
    hub.openCard({ cardId: d, by: "tv" });
    const s = hub.endSession()!;
    expect(s).toMatchObject({ cards: 4, attempts: 5, counted: 3, passed: 1, failed: 2, unverified: 1, pending: 1 });
    expect(s.lines).toEqual({ passed: 1, failed: 1, unverified: 1, pending: 0, untried: 1 });
    expect(s.perCard.map((p) => [p.attempts, p.passed])).toEqual([[2, 1], [1, 0], [0, 0], [0, 0]]);
    // each line names its result, the key of `lines` it counts toward (the TV colours its segment by it)
    expect(s.perCard.map((p) => p.line)).toEqual(["passed", "failed", "unverified", "untried"]);
    // Bee passes line B's retry after the round: the summary the hub re-sends has it passed
    heard(hub, retry, vb.resay);
    const resent = events.filter((e) => e.topic === "session.ended").at(-1)!.payload.summary as typeof s;
    expect(resent).toMatchObject({ sessionId: s.sessionId, passed: 2, failed: 2, pending: 0 });
    expect(resent.lines).toEqual({ passed: 2, failed: 0, unverified: 1, pending: 0, untried: 1 });
    expect(resent.perCard.map((p) => p.line)).toEqual(["passed", "passed", "unverified", "untried"]);
    hub.dispose();
  });
  it("a line still with Bee after a try Bee didn't catch is still with Bee; the lines add up to the cards", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const { card } = hub.startSession({ by: "tv", size: 1 });
    heard(hub, hub.submit({ text: card!.resay, source: "phone" }) as Attempt, null);
    hub.submit({ text: card!.resay, source: "phone" });
    const s = hub.endSession()!;
    expect(s.lines).toEqual({ passed: 0, failed: 0, unverified: 0, pending: 1, untried: 0 });
    expect(s.perCard.map((p) => p.line)).toEqual(["pending"]);
    expect(Object.values(s.lines).reduce((x, y) => x + y, 0)).toBe(s.cards);
    hub.dispose();
  });
});
