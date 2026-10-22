// A round's summary counts each line once (`lines`), by its best result, beside the per-try counts:
// a line missed and then passed on a retry is one line passed, so a screen's tally under "1 of 2
// lines passed." never reads "1 passed, 2 not yet".
import { describe, expect, it } from "vitest";
import type { Attempt, HubEvent } from "../src/hub/core.js";
import { demoSetup } from "../src/hub/setup.js";
import { drillPhase, initialMirror, mirrorReducer, type MirrorState } from "../tv/web/src/mirror/reducer.js";

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
  it("the round that ended last rides in hub.state while nothing is open, with the last line opened (a line opened again is not perCard's last entry)", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const { card: a } = hub.startSession({ by: "tv", size: 3 });
    expect(hub.lastSessionState()).toBeNull(); // a round is open
    const b = DUE.find((id) => id !== a!.id)!;
    hub.openCard({ cardId: b, by: "tv" });
    hub.openCard({ cardId: a!.id, by: "tv" }); // line A again, after B
    const s = hub.endSession()!;
    const last = hub.lastSessionState()!;
    expect(last).toMatchObject({ endedAt: s.endedAt, lastCardId: a!.id, summary: { sessionId: s.sessionId, cards: 2 } });
    expect(last.summary.perCard.map((p) => p.cardId)).toEqual([a!.id, b]); // B is perCard's last entry; A was opened last
    // a lone card opened since: Round over is over, also once that card closes
    hub.openCard({ by: "tv" });
    expect(hub.lastSessionState()).toBeNull();
    hub.expireIdle(0);
    expect(hub.open).toBeNull();
    expect(hub.lastSessionState()).toBeNull();
    // the next round's end is the round that ended last
    hub.startSession({ by: "tv", size: 1 });
    const s2 = hub.endSession()!;
    expect(hub.lastSessionState()).toMatchObject({ summary: { sessionId: s2.sessionId } });
    hub.dispose();
  });
  it("a lone card opened and passed after the round: Bee settling the round's earlier try never re-sends the old round, so the TV never brings it back (review L185)", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const events: HubEvent[] = [];
    hub.on("event", (e: HubEvent) => events.push(e));
    const { card: a } = hub.startSession({ by: "tv", size: 2 });
    const tryA = hub.submit({ text: a!.resay, source: "phone" }) as Attempt; // still with Bee
    const s = hub.endSession()!;
    expect(s.lines.pending).toBe(1);
    expect(hub.lastSessionState()).not.toBeNull();
    // the wearer moves on: a lone card, passed by Bee, which closes it
    const lone = hub.openCard({ cardId: DUE.find((id) => id !== a!.id), by: "tv" })!;
    heard(hub, hub.submit({ text: lone.resay, source: "phone" }) as Attempt, lone.resay);
    expect(hub.open).toBeNull();
    expect(hub.lastSessionState()).toBeNull();
    const ended = () => events.filter((e) => e.topic === "session.ended").length;
    const before = ended();
    heard(hub, tryA, a!.resay); // Bee settles the round's try late
    expect(ended()).toBe(before); // not re-sent: that round's Round over is over
    // the TV, fed every event in order, stays on the lone card's pass
    const T = 1_800_000_000_000;
    let st: MirrorState = initialMirror();
    events.forEach((e, i) => (st = mirrorReducer(st, { type: "event", event: { topic: e.topic, payload: e.payload as any }, now: T + i * 1000 })));
    expect(drillPhase(st.drill)).toBe("result");
    expect(st.drill).toMatchObject({ summary: null, card: { id: lone.id } });
    hub.dispose();
  });
  it("while Round over is still up, Bee settling a try re-sends the round's tally", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const events: HubEvent[] = [];
    hub.on("event", (e: HubEvent) => events.push(e));
    const { card: a } = hub.startSession({ by: "tv", size: 1 });
    const tryA = hub.submit({ text: a!.resay, source: "phone" }) as Attempt;
    const s = hub.endSession()!;
    heard(hub, tryA, a!.resay);
    const sent = events.filter((e) => e.topic === "session.ended");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload.summary).toMatchObject({ sessionId: s.sessionId, pending: 0, lines: { passed: 1, pending: 0 } });
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
