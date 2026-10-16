// The Speaking Mirror reducer (tv/web/src/mirror/reducer.ts, synced verbatim to tv/vega): seq
// order with gaps and duplicates, rebasing on hub.state, screen auto-switching and the room-scoped
// meters history.
import { describe, expect, it } from "vitest";
import { GAP_WAIT_MS, initialMirror, mirrorReducer, PRACTICE_HISTORY, RECAP_VISIBLE_MS, type MirrorAction, type MirrorState, type SeqEvent } from "../tv/web/src/mirror/reducer.js";
import { loadFixtureV2 } from "../src/hub/fixtureV2.js";

const fx = loadFixtureV2();
const ev = (seq: number, topic: string, payload: Record<string, unknown> = {}): SeqEvent => ({ topic, payload: { seq, at: 1792517400000 + seq, ...payload } });
const run = (s: MirrorState, ...actions: MirrorAction[]) => actions.reduce(mirrorReducer, s);
const focus = (seq: number, view: string, extra: Record<string, unknown> = {}) => ev(seq, "mirror.focus", { view, by: "phone-1", reason: null, recapId: null, takeId: null, ...extra });
const views = (s: MirrorState) => s.view;

describe("seq order", () => {
  it("applies in order and drops duplicates", () => {
    let s = initialMirror();
    s = run(s, { type: "event", event: focus(5, "transfer"), now: 0 }, { type: "event", event: focus(6, "live"), now: 1 }, { type: "event", event: focus(6, "week"), now: 2 }, { type: "event", event: focus(4, "week"), now: 3 });
    expect(s.lastSeq).toBe(6);
    expect(s.applied).toBe(2);
    expect(s.duplicates).toBe(2);
    expect(views(s)).toBe("live");
  });
  it("holds an event that arrives ahead of a gap, then applies both in order when the gap fills", () => {
    let s = run(initialMirror(), { type: "event", event: focus(10, "week"), now: 0 });
    s = run(s, { type: "event", event: focus(12, "practice"), now: 10 });
    expect(s.lastSeq).toBe(10);
    expect(s.pending.map((e) => e.payload.seq)).toEqual([12]);
    expect(views(s)).toBe("week");
    s = run(s, { type: "event", event: focus(12, "practice"), now: 11 }); // duplicate of a pending event
    expect(s.duplicates).toBe(1);
    s = run(s, { type: "event", event: focus(11, "transfer"), now: 20 });
    expect(s.lastSeq).toBe(12);
    expect(s.pending).toEqual([]);
    expect(views(s)).toBe("practice"); // 11 (transfer) then 12 (practice)
    expect(s.gaps).toBe(0);
  });
  it("gives up on a gap after GAP_WAIT_MS on a tick, applies the waiting events in order and counts the gap", () => {
    let s = run(initialMirror(), { type: "event", event: focus(1, "week"), now: 0 });
    s = run(s, { type: "event", event: focus(4, "live"), now: 100 }, { type: "event", event: focus(3, "transfer"), now: 150 });
    s = run(s, { type: "tick", now: 100 + GAP_WAIT_MS - 1 });
    expect(s.lastSeq).toBe(1);
    s = run(s, { type: "tick", now: 100 + GAP_WAIT_MS });
    expect(s.lastSeq).toBe(4);
    expect(s.gaps).toBe(1);
    expect(views(s)).toBe("live");
    s = run(s, { type: "event", event: focus(2, "practice"), now: 5000 }); // the late one is stale now
    expect(s.duplicates).toBe(1);
    expect(views(s)).toBe("live");
  });
  it("hub.state on a reconnect rebases: newer events apply at once, older ones are still duplicates", () => {
    const hubState = { mode: "demo", dataLabel: "SYNTHETIC DEMO DATA (invented; not anyone's real results)", state: "idle", narration: "", verdictReady: false, retryAfterMs: null, session: null, openCard: null, lastAttempt: null, deck: { date: "2026-10-20", total: 6, dueNow: 4, boxes: {}, dueByDate: {}, nextDueDate: null }, bee: { replay: true, pendingVerifications: 0, lastEventAt: null, counters: {} } } as any;
    let s = run(initialMirror(), { type: "event", event: focus(20, "week"), now: 0 }, { type: "hubState", state: hubState, now: 1 });
    expect(s.lastSeq).toBeNull();
    expect(s.synthetic).toBe(true);
    expect(s.dataLabel).toMatch(/^SYNTHETIC/);
    s = run(s, { type: "event", event: focus(18, "live"), now: 2 }, { type: "event", event: focus(27, "transfer"), now: 3 });
    expect(s.duplicates).toBe(1);
    expect(s.lastSeq).toBe(27);
    expect(views(s)).toBe("transfer");
  });
});

describe("screens switch on events", () => {
  const story = fx["events-live.json"].events as { topic: string; payload: Record<string, unknown> }[];
  it("the live story shows the live window, keeps the nudge with its hops, then raises the recap", () => {
    let s = initialMirror();
    story.forEach((e, i) => (s = mirrorReducer(s, { type: "event", event: ev(100 + i, e.topic, e.payload), now: i * 10 })));
    expect(s.view).toBe("live");
    expect(s.live.window?.wearer.wpm).toBeGreaterThan(0);
    expect(s.live.nudges).toHaveLength(1);
    expect(s.live.nudges[0]!.hops.alarmAt).toBeGreaterThan(s.live.nudges[0]!.hops.spokenAt);
    expect(s.live.skips[0]!.reason).toBe("cooldown");
    expect(s.live.ended?.reason).toBe("idle");
    expect(s.recapVisible).toBe(true);
    expect(s.recap?.id).toBe("rcp_demo_0001");
    expect(s.replay).toBe(true);
    s = run(s, { type: "tick", now: story.length * 10 + RECAP_VISIBLE_MS + 1 });
    expect(s.recapVisible).toBe(false);
  });
  it("drill events show the drill pipeline: provisional, checking with Bee, verified, graded with Bee overruling", () => {
    const card = { id: "demo:vague-status", said: "x", fix: "y" } as any;
    const attempt = { id: "att_1", cardId: card.id, status: "pending_bee", provisional: { source: "phone", text: "The migration is not done yet.", grade: { pass: true, reasons: ["ok habit"] } } };
    let s = run(
      initialMirror(),
      { type: "event", event: ev(1, "card.open", { card, by: "alexa", sessionId: "s1", deck: null }), now: 0 },
      { type: "event", event: ev(2, "attempt.provisional", { attempt, card }), now: 1 },
    );
    expect(s.view).toBe("drill");
    expect(s.drill.stage).toBe("provisional");
    expect(s.drill.provisional?.pass).toBe(true);
    s = run(s, { type: "event", event: ev(3, "attempt.status", { attemptId: "att_1", cardId: card.id, status: "polling", reason: "no tagged line" }), now: 2 });
    expect(s.drill.stage).toBe("checking");
    s = run(s, { type: "event", event: ev(4, "attempt.verified", { attemptId: "att_1", cardId: card.id, status: "verified", via: "stream", speakerScore: 0.82, latencyMs: 5900, beeText: "Um, the migration is not done yet.", replay: true, reason: "tagged" }), now: 3 });
    expect(s.drill.stage).toBe("verified");
    expect(s.drill.verified?.speakerScore).toBe(0.82);
    // a live-conversation event does not pull the screen away from a drill in progress
    s = run(s, { type: "event", event: ev(5, "conversation.started", { conversationId: "c1", startedAt: 0, replay: true }), now: 4 });
    expect(s.view).toBe("drill");
    s = run(s, { type: "event", event: ev(6, "attempt.graded", { attempt: { ...attempt, status: "graded", counted: true, final: { source: "bee", pass: false, grade: { reasons: ["FAIL fillers: 1 filler"] } }, agreement: "bee-overrules", box: { from: 2, to: 1 }, bee: { text: "Um, the migration is not done yet.", replay: true } }, card, deck: null }), now: 5 });
    expect(s.drill.stage).toBe("graded");
    expect(s.drill.graded).toMatchObject({ pass: false, agreement: "bee-overrules", boxFrom: 2, boxTo: 1 });
    expect(s.drill.provisional?.pass).toBe(true); // the preview stays beside the verdict that overruled it
    s = run(s, { type: "event", event: ev(7, "live.window", { window: (story[1]!.payload as any).window }), now: 6 });
    expect(s.view).toBe("live"); // the drill is settled
    s = run(s, { type: "event", event: ev(8, "stats.updated", { dataLabel: "SYNTHETIC DEMO DATA", deck: null }), now: 7 });
    expect(s.statsVersion).toBe(1);
  });
  it("mirror.focus shows the asked view; a recap focus raises the overlay or waits for the recap", () => {
    let s = run(initialMirror(), { type: "event", event: focus(1, "transfer", { by: "alexa" }), now: 0 });
    expect(s.view).toBe("transfer");
    expect(s.viewBy).toBe("alexa");
    s = run(s, { type: "event", event: focus(2, "recap", { recapId: "rcp_demo_0001" }), now: 1 });
    expect(s.recapVisible).toBe(false);
    expect(s.recapWanted).toBe("rcp_demo_0001");
    s = run(s, { type: "recap", recap: fx["recap.json"], show: true, now: 2 });
    expect(s.recapVisible).toBe(true);
    expect(s.recapWanted).toBeNull();
    s = run(s, { type: "event", event: focus(3, "bogus"), now: 3 });
    expect(s.view).toBe("transfer");
    s = run(s, { type: "show", view: "week" });
    expect(s.view).toBe("week");
    expect(s.recapVisible).toBe(false);
  });
});

describe("practice meters (room frames, no seq)", () => {
  const frames = fx["practice-meters.json"].frames as any[];
  it("switch to practice, keep the last 5 s, and start over on a new take", () => {
    let s = run(initialMirror(), { type: "meters", frames: frames.map((f) => ({ ...f, from: "phone-1" })), now: 0 });
    expect(s.view).toBe("practice");
    expect(s.lastSeq).toBeNull(); // meters never touch the sequence
    expect(s.practice.frames).toBe(10);
    expect(s.practice.latest?.frame).toBe(frames.at(-1).frame);
    expect(s.practice.caption).toBeTruthy();
    for (let i = 0; i < 8; i++) s = run(s, { type: "meters", frames: frames.map((f) => ({ ...f, frame: f.frame + 10 * (i + 1) })), now: i });
    expect(s.practice.history).toHaveLength(PRACTICE_HISTORY);
    s = run(s, { type: "meters", frames: [{ ...frames[0], takeId: "take_2", frame: 0, caption: null }], now: 100 });
    expect(s.practice.takeId).toBe("take_2");
    expect(s.practice.frames).toBe(1);
    expect(s.practice.caption).toBeNull();
  });
  it("a practice.summary lands on the same take", () => {
    const sum = (fx["events-practice.json"].events as any[])[1].payload;
    let s = run(initialMirror(), { type: "meters", frames: frames.slice(0, 3), now: 0 }, { type: "event", event: ev(1, "practice.summary", sum), now: 1 });
    expect(s.practice.summary?.takeId).toBe("take_demo_01");
    expect(s.practice.frames).toBe(3);
    expect(s.view).toBe("practice");
  });
});
