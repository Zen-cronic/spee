// The TV app's reducer (tv/web/src/mirror/reducer.ts, synced verbatim to tv/vega): seq
// order with gaps and duplicates, rebasing on hub.state, screen auto-switching and the room-scoped
// meters history.
import { describe, expect, it } from "vitest";
import { backAction, drillInProgress, drillPhase, drillSteps, GAP_WAIT_MS, initialMirror, mirrorReducer, PRACTICE_HISTORY, RECAP_VISIBLE_MS, ROUND_OVER_MS, type DrillStage, type DrillState, type MirrorAction, type MirrorState, type SeqEvent } from "../tv/web/src/mirror/reducer.js";
import { loadFixtureV2 } from "../src/hub/fixtureV2.js";
import { roundLastLine, WITH_BEE_STAGES, withBee } from "../tv/web/src/mirror/format.js";

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
  it("a hub restart (new bootId) resets the sequence, so seq 1.. applies again (review H8)", () => {
    const base = { mode: "demo", dataLabel: "SYNTHETIC DEMO DATA", state: "idle", narration: "", verdictReady: false, retryAfterMs: null, session: null, openCard: null, lastAttempt: null, deck: null, bee: { replay: true, pendingVerifications: 0, lastEventAt: null, counters: {} } } as any;
    let s = run(initialMirror(), { type: "hubState", state: { ...base, bootId: "boot_a", lastSeq: 0 }, now: 0 });
    for (let i = 1; i <= 340; i++) s = run(s, { type: "event", event: focus(i, i % 2 ? "week" : "transfer"), now: i });
    expect(s.lastSeq).toBe(340);
    // reconnect to the same hub: events up to its lastSeq are in the snapshot
    s = run(s, { type: "hubState", state: { ...base, bootId: "boot_a", lastSeq: 345 }, now: 400 });
    s = run(s, { type: "event", event: focus(345, "live"), now: 401 }, { type: "event", event: focus(346, "practice"), now: 402 });
    expect(s.lastSeq).toBe(346);
    expect(views(s)).toBe("practice");
    expect(s.restarts).toBe(0);
    // the hub restarted: seq is back at 1
    s = run(s, { type: "hubState", state: { ...base, bootId: "boot_b", lastSeq: 0 }, now: 500 });
    expect(s.restarts).toBe(1);
    s = run(s, { type: "event", event: focus(1, "transfer"), now: 501 }, { type: "event", event: focus(2, "live"), now: 502 });
    expect(s.lastSeq).toBe(2);
    expect(views(s)).toBe("live");
    expect(s.duplicates).toBe(1); // only seq 345, which the reconnect snapshot already covered
  });
});

describe("one list of the stages with Bee (review L191)", () => {
  it("the drill panel, a drill in progress and Round over's last line all read it", () => {
    expect(WITH_BEE_STAGES).toEqual(["provisional", "checking", "verified"]);
    const stages: DrillStage[] = ["idle", "card", "provisional", "checking", "verified", "unverified", "graded"];
    for (const stage of stages) {
      const d = { ...initialMirror().drill, card: { id: "k1" } as any, stage } as DrillState;
      expect(drillPhase(d) === "checking", stage).toBe(withBee(stage));
      expect(drillInProgress(d), stage).toBe(stage === "card" || withBee(stage));
      expect(roundLastLine({ graded: null, stage, previewSource: null }) === "Bee is still checking your last line. Its result lands here.", stage).toBe(withBee(stage));
    }
  });
});

describe("Back (review M18)", () => {
  it("closes the recap, then goes home, then lets the platform exit from the root screen", () => {
    expect(backAction({ recapVisible: true, view: "week" })).toBe("dismissRecap");
    expect(backAction({ recapVisible: false, view: "live" })).toBe("home");
    expect(backAction({ recapVisible: false, view: "week" })).toBe("exit");
  });
});

describe("stale screens (review M19, M20, M22, M23)", () => {
  it("conversation.ended drops the live window so the ended state shows", () => {
    const w = { conversationId: "c1", wearer: { wpm: 120 } } as any;
    const s = run(initialMirror(), { type: "event", event: ev(1, "live.window", { window: w }), now: 0 }, { type: "event", event: ev(2, "conversation.ended", { conversationId: "c1", recap: "pending", wearerWords: 10, startedAt: 0, endedAt: 1000 }), now: 1 });
    expect(s.live.window).toBeNull();
    expect(s.live.ended?.conversationId).toBe("c1");
  });
  it("session.ended closes an unattempted card, and keeps a final verdict with the summary", () => {
    const card = { id: "k1", resay: "x" } as any;
    const summary = { passed: 1, failed: 0, unverified: 0 } as any;
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card }), now: 0 }, { type: "event", event: ev(2, "session.ended", { summary }), now: 1 });
    expect(s.drill.card).toBeNull();
    expect(s.drill.summary).toEqual(summary);
    s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card }), now: 0 }, { type: "event", event: ev(2, "attempt.graded", { attempt: { id: "a1", status: "graded", final: { pass: true, grade: { reasons: [] } } }, card }), now: 1 }, { type: "event", event: ev(3, "session.ended", { summary }), now: 2 });
    expect(s.drill.card?.id).toBe("k1");
    expect(s.drill.stage).toBe("graded");
    expect(s.drill.summary).toEqual(summary);
  });
  it("a verdict that lands after session.ended stays, and the hub's re-sent summary replaces the old one", () => {
    const card = { id: "k1", resay: "x" } as any;
    const summary = { sessionId: "s1", passed: 0, failed: 0, unverified: 0, pending: 1, beeOverrules: 0 } as any;
    const prov = { attempt: { id: "a1", provisional: { source: "phone", text: "x", grade: { pass: false, reasons: [] } } }, card };
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card }), now: 0 }, { type: "event", event: ev(2, "attempt.provisional", prov), now: 1 }, { type: "event", event: ev(3, "session.ended", { summary }), now: 2 });
    expect(s.drill.stage).toBe("provisional"); // still with Bee, not closed
    expect(s.drill.summary?.pending).toBe(1);
    s = run(s, { type: "event", event: ev(4, "attempt.graded", { attempt: { id: "a1", cardId: "k1", status: "graded", agreement: "bee-overrules", final: { pass: true, grade: { reasons: [] } } }, card }), now: 3 });
    expect(s.drill.stage).toBe("graded");
    expect(s.drill.summary).toEqual(summary); // the TV does not count on its own
    const settled = { ...summary, passed: 1, pending: 0, beeOverrules: 1 };
    s = run(s, { type: "event", event: ev(5, "session.ended", { summary: settled }), now: 4 });
    expect(s.drill.stage).toBe("graded");
    expect(s.drill.card?.id).toBe("k1");
    expect(s.drill.summary).toEqual(settled);
  });
  it("a late verdict for the previous card never replaces the card that is open now", () => {
    const c1 = { id: "c1", resay: "one" } as any;
    const c2 = { id: "c2", resay: "two" } as any;
    const prov = { attempt: { id: "a1", cardId: "c1", provisional: { source: "phone", text: "one", grade: { pass: true, reasons: [] } } }, card: c1 };
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card: c1 }), now: 0 }, { type: "event", event: ev(2, "attempt.provisional", prov), now: 1 }, { type: "event", event: ev(3, "card.open", { card: c2 }), now: 2 });
    expect(s.drill).toMatchObject({ stage: "card", card: { id: "c2" } });
    const deck = { total: 6, dueNow: 2 } as any;
    s = run(s, { type: "event", event: ev(4, "attempt.verified", { attemptId: "a1", cardId: "c1", status: "verified", beeText: "one" }), now: 3 }, { type: "event", event: ev(5, "attempt.graded", { attempt: { id: "a1", cardId: "c1", status: "graded", final: { pass: true, grade: { reasons: [] } } }, card: c1, deck }), now: 4 });
    expect(s.drill).toMatchObject({ stage: "card", card: { id: "c2" }, attemptId: null, graded: null, verified: null });
    expect(s.drill.deck).toEqual(deck); // the deck summary still moves
  });
  it("a Bee-only attempt (no phone or Alexa preview) marks \"You said it\" done on the tracker", () => {
    const c1 = { id: "c1", resay: "We ship the export on Friday." } as any;
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card: c1 }), now: 0 });
    expect(drillSteps(s.drill)).toEqual({ heard: "now", checked: "todo", graded: "todo" });
    s = run(s, { type: "event", event: ev(2, "attempt.verified", { attemptId: "a1", cardId: "c1", status: "verified", via: "stream", beeText: "We ship the export on Friday.", reason: "Bee tagged the wearer saying the open card (no phone/Alexa preview)" }), now: 1 });
    expect(s.drill.provisional).toBeNull();
    expect(drillSteps(s.drill)).toEqual({ heard: "done", checked: "done", graded: "now" });
    const failed = { reasons: ['FAIL habit: kept the habit (hedges: "i guess", "i think"): "i think"'], checks: [{ rule: "nonempty", ok: true, detail: "" }, { rule: "habit", ok: false, detail: "" }], habit: { kind: "hedge", label: 'hedges: "i guess", "i think"', hits: 1, found: ["i think"] }, fillers: [], missing: [], required: [] };
    s = run(s, { type: "event", event: ev(3, "attempt.graded", { attempt: { id: "a1", cardId: "c1", status: "graded", provisional: null, bee: { text: "I think we ship the export on Friday.", via: "stream" }, final: { source: "bee", pass: false, grade: failed } }, card: c1 }), now: 2 });
    expect(drillSteps(s.drill)).toEqual({ heard: "done", checked: "done", graded: "bad" });
    // The verdict's words come from what Bee heard, not from the card's label.
    expect(s.drill.graded?.failure).toEqual({ rule: "habit", words: ["i think"] });
    // With a preview, and while Bee checks without one.
    expect(drillSteps({ stage: "provisional", provisional: { source: "phone", text: "x", pass: true, reasons: [] }, verified: null, graded: null }).heard).toBe("done");
    expect(drillSteps({ stage: "checking", provisional: null, verified: null, graded: null }).heard).toBe("done");
    expect(drillSteps({ stage: "idle", provisional: null, verified: null, graded: null }).heard).toBe("todo");
  });
  it("Bee still checking the previous card's attempt never puts the open card into checking", () => {
    const c1 = { id: "c1", resay: "one" } as any;
    const c2 = { id: "c2", resay: "two" } as any;
    const prov = { attempt: { id: "a1", cardId: "c1", provisional: { source: "phone", text: "one", grade: { pass: true, reasons: [] } } }, card: c1 };
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card: c1 }), now: 0 }, { type: "event", event: ev(2, "attempt.provisional", prov), now: 1 }, { type: "event", event: ev(3, "card.open", { card: c2 }), now: 2 });
    // 30 s later the hub starts polling for a1, then gives up on it.
    s = run(s, { type: "event", event: ev(4, "attempt.status", { attemptId: "a1", cardId: "c1", status: "polling", reason: "stream timed out" }), now: 3 });
    expect(s.drill).toMatchObject({ stage: "card", card: { id: "c2" }, attemptId: null, checking: null });
    s = run(s, { type: "event", event: ev(5, "attempt.verified", { attemptId: "a1", cardId: "c1", status: "unverified", reason: "gave up" }), now: 4 }, { type: "event", event: ev(6, "session.ended", { summary: { sessionId: "s1" } }), now: 5 });
    // Nobody attempted c2, so the session's end closes it and the summary shows.
    expect(s.drill).toMatchObject({ stage: "idle", card: null });
    // The open card's own attempt still gets its checking state.
    s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card: c2 }), now: 0 }, { type: "event", event: ev(2, "attempt.status", { attemptId: "a2", cardId: "c2", status: "polling", reason: "r" }), now: 1 });
    expect(s.drill).toMatchObject({ stage: "checking", attemptId: "a2", checking: { reason: "r" } });
  });
  it("DRILLS TODAY reads today's tally from the hub.state snapshot, then stats.updated, never an older count", () => {
    const today = { attempts: 2, counted: 2, passed: 1, unverified: 0, beeOverrules: 0 };
    const snap = (lastSeq: number, practiceToday: unknown) => ({ type: "hubState", state: { mode: "live", dataLabel: "x", bootId: "b1", lastSeq, state: "idle", narration: "", verdictReady: false, retryAfterMs: null, session: null, openCard: null, lastAttempt: null, deck: null, practiceToday, bee: {} } as any, now: 0 }) as MirrorAction;
    let s = run(initialMirror(), snap(4, { ...today, passed: 0 }));
    expect(s.practiceToday?.passed).toBe(0);
    s = run(s, { type: "event", event: ev(5, "stats.updated", { dataLabel: "x", practiceToday: today, weekPer100: {}, transferHeadline: null, deck: null }), now: 0 });
    expect(s.practiceToday).toEqual(today);
    expect(s.statsVersion).toBe(1);
    // A stats.updated the snapshot already reflects (seq at or below its lastSeq) is not applied again.
    s = run(initialMirror(), snap(6, today), { type: "event", event: ev(5, "stats.updated", { dataLabel: "x", practiceToday: { ...today, passed: 0 }, weekPer100: {}, transferHeadline: null, deck: null }), now: 0 });
    expect(s.practiceToday).toEqual(today);
    // The local day turned on the hub: its stats.updated carries a zero tally.
    const zero = { attempts: 0, counted: 0, passed: 0, unverified: 0, beeOverrules: 0 };
    s = run(s, { type: "event", event: ev(7, "stats.updated", { dataLabel: "x", practiceToday: zero, weekPer100: {}, transferHeadline: null, deck: null }), now: 1 });
    expect(s.practiceToday).toEqual(zero);
  });
  it("a phone's focus from another room is ignored; a screen's or Alexa's reaches every room", () => {
    let s = run(initialMirror(), { type: "room", code: "HJ3H" }, { type: "event", event: focus(1, "practice", { takeId: "t-other", room: "AB2C" }), now: 0 });
    expect(views(s)).toBe("week");
    expect(s.practice.takeId).toBeNull();
    s = run(s, { type: "event", event: focus(2, "practice", { takeId: "t-mine", room: "hj3h" }), now: 1 });
    expect(views(s)).toBe("practice");
    s = run(s, { type: "event", event: focus(3, "transfer", { by: "alexa", room: null }), now: 2 });
    expect(views(s)).toBe("transfer");
  });
  it("a practice summary from another room is ignored", () => {
    const sum = (room: string) => ({ summary: { takeId: `t-${room}`, room, from: "phone", startedAt: 0, endedAt: 1, words: 3, provisional: true } });
    let s = run(initialMirror(), { type: "room", code: "HJ3H" }, { type: "event", event: ev(1, "practice.summary", sum("AB2C")), now: 0 });
    expect(s.practice.summary).toBeNull();
    s = run(s, { type: "event", event: ev(2, "practice.summary", sum("HJ3H")), now: 1 });
    expect(s.practice.summary?.takeId).toBe("t-HJ3H");
  });
  it("a recap request is cleared when the fetch finishes, found or not", () => {
    let s = run(initialMirror(), { type: "event", event: ev(1, "mirror.focus", { view: "recap", by: "alexa", reason: "asked", recapId: null, takeId: null }), now: 0 });
    expect(s.recapWanted).toBe("latest");
    s = run(s, { type: "recapFetched", ok: false });
    expect(s.recapWanted).toBeNull();
    s = run(s, { type: "event", event: ev(2, "mirror.focus", { view: "recap", by: "alexa", reason: "asked", recapId: null, takeId: null }), now: 1 });
    expect(s.recapWanted).toBe("latest");
    s = run(s, { type: "recap", recap: { id: "rcp_1" } as any, show: true, now: 2 });
    expect(s.recapWanted).toBeNull();
    expect(s.recapVisible).toBe(true);
  });
});

describe("screens switch on events", () => {
  const story = fx["events-live.json"].events as { topic: string; payload: Record<string, unknown> }[];
  it("the live story shows the live window, keeps the nudge with its hops, then raises the recap", () => {
    let s = initialMirror();
    let wpm = 0;
    story.forEach((e, i) => {
      s = mirrorReducer(s, { type: "event", event: ev(100 + i, e.topic, e.payload), now: i * 10 });
      if (s.live.window) wpm = s.live.window.wearer.wpm ?? 0;
    });
    expect(s.view).toBe("live");
    expect(wpm).toBeGreaterThan(0);
    expect(s.live.window).toBeNull(); // conversation.ended: the ended state shows, not stale numbers
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
    s = run(s, { type: "event", event: ev(6, "attempt.graded", { attempt: { ...attempt, status: "graded", counted: true, final: { source: "bee", pass: false, grade: { reasons: ["FAIL fillers: 1 filler"] } }, agreement: "bee-overrules", box: { from: 2, to: 1, dueAfter: "2026-10-22" }, bee: { text: "Um, the migration is not done yet.", replay: true } }, card, deck: null }), now: 5 });
    expect(s.drill.stage).toBe("graded");
    expect(s.drill.graded).toMatchObject({ pass: false, agreement: "bee-overrules", boxFrom: 2, boxTo: 1, dueAfter: "2026-10-22" });
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

describe("a lone card closed by Bee's pass", () => {
  const card = { id: "demo:filler-like", resay: "The dashboard loads slowly on Mondays." } as any;
  const pass = { id: "att_1", cardId: card.id, status: "graded", counted: true, agreement: "bee-only", provisional: null, bee: { text: card.resay, via: "stream", speakerScore: 0.82, latencyMs: 6000, replay: true }, final: { source: "bee", pass: true, grade: { reasons: [], checks: [] } }, box: { from: 1, to: 2, dueAfter: "2026-10-22" } } as any;
  const snap = (lastAttempt: unknown, openCard: unknown = null) => ({ type: "hubState", state: { mode: "demo", dataLabel: "x", bootId: "b1", lastSeq: 9, state: "idle", narration: "", verdictReady: false, retryAfterMs: null, session: null, openCard, lastAttempt, deck: null, bee: {} } as any, now: 0 }) as MirrorAction;
  it("keeps the verdict on screen when hub.state closes the card it just passed", () => {
    let s = run(initialMirror(), snap(null, card), { type: "event", event: ev(10, "attempt.graded", { attempt: pass, card }), now: 1 });
    expect(s.drill).toMatchObject({ stage: "graded", graded: { pass: true } });
    s = run(s, snap(pass));
    expect(s.drill.card?.id).toBe(card.id);
    expect(s.drill).toMatchObject({ stage: "graded", graded: { pass: true, boxTo: 2 } });
  });
  it("a screen that joins after the close shows no drill; a failed attempt is never kept", () => {
    expect(run(initialMirror(), snap(pass)).drill).toMatchObject({ card: null, stage: "idle" });
    const fail = { ...pass, final: { ...pass.final, pass: false } };
    const s = run(initialMirror(), snap(null, card), { type: "event", event: ev(10, "attempt.graded", { attempt: fail, card }), now: 1 }, snap(fail));
    expect(s.drill).toMatchObject({ card: null, stage: "idle" });
  });
});

describe("stale refetches and older recaps", () => {
  const mode = (enabled: boolean, changedAt: number) => ({ ...(fx["live.json"] as any).mode, enabled, changedAt });
  const live = (m: unknown) => ({ ...(fx["live.json"] as any), mode: m });
  it("a GET /api/live built before the socket's live.mode does not turn live coaching back on", () => {
    let s = run(initialMirror(), { type: "liveState", live: live(mode(true, 1000)) });
    s = run(s, { type: "event", event: ev(1, "live.mode", { mode: mode(false, 2000) }), now: 0 });
    s = run(s, { type: "liveState", live: live(mode(true, 1000)) }); // the slow response lands last
    expect(s.live.mode?.enabled).toBe(false);
    // a refetch of the same change still refreshes the counts
    s = run(s, { type: "liveState", live: live({ ...mode(false, 2000), sent: { lastHour: 3, today: 9 } }) });
    expect(s.live.mode?.sent).toEqual({ lastHour: 3, today: 9 });
  });
  it("the latest recap is the newest conversation's: an older one shown on request does not replace it", () => {
    const r = fx["recap.json"] as any;
    const newer = { ...r, id: "rcp_new", conversationId: "c-new", endedAt: r.endedAt + 600_000 };
    let s = run(initialMirror(), { type: "event", event: ev(1, "recap.ready", { recap: newer }), now: 0 });
    s = run(s, { type: "recap", recap: r, show: true, now: 1 }); // "show my recap" for the older one
    expect(s.recap?.id).toBe(r.id);
    expect(s.latestRecap?.id).toBe("rcp_new");
  });
});

describe("Round over (packet S)", () => {
  const card = { id: "k1", resay: "The migration is not done yet." } as any;
  const summary = { sessionId: "s1", by: "alexa", cards: 2, attempts: 2, counted: 2, passed: 1, failed: 1, unverified: 0, pending: 0, beeOverrules: 1, perCard: [] } as any;
  const graded = (agreement: string, pass: boolean) => ({ attempt: { id: "a1", cardId: "k1", status: "graded", agreement, provisional: { source: "phone", text: "x", grade: { pass: !pass, reasons: [] } }, final: { pass, grade: { reasons: [] } }, bee: { text: "Um, the migration is not done yet." } }, card });
  it("session.ended after an overrule → drillPhase 'over', with the overruled verdict kept beside the tally", () => {
    let s = run(initialMirror(), { type: "event", event: ev(1, "session.started", { session: { id: "s1", by: "alexa" } }), now: 0 }, { type: "event", event: ev(2, "card.open", { card, sessionId: "s1" }), now: 1 });
    expect(drillPhase(s.drill)).toBe("line");
    s = run(s, { type: "event", event: ev(3, "attempt.graded", graded("bee-overrules", false)), now: 2 });
    expect(drillPhase(s.drill)).toBe("result");
    s = run(s, { type: "event", event: ev(4, "session.ended", { summary }), now: 3 });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill.graded).toMatchObject({ pass: false, agreement: "bee-overrules" });
    expect(s.drill.summary?.beeOverrules).toBe(1);
    // not the same screen as the result before it (the tv-07 duplicate of tv-06)
    expect(drillPhase(s.drill)).not.toBe("result");
  });
  it("an unattempted card closed by the end is over too; a new round starts over at a line", () => {
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card }), now: 0 }, { type: "event", event: ev(2, "session.ended", { summary }), now: 1 });
    expect(s.drill.card).toBeNull();
    expect(drillPhase(s.drill)).toBe("over");
    s = run(s, { type: "event", event: ev(3, "session.started", { session: { id: "s2", by: "alexa" } }), now: 2 });
    expect(drillPhase(s.drill)).toBe("idle");
    s = run(s, { type: "event", event: ev(4, "card.open", { card, sessionId: "s2" }), now: 3 });
    expect(drillPhase(s.drill)).toBe("line");
  });
  it("Round over shows right after the round, then yields to the idle panel with the lines due after ROUND_OVER_MS; a re-sent summary never brings it back", () => {
    const deck = { date: "2026-10-20", total: 6, dueNow: 3, boxes: {}, dueByDate: {}, nextDueDate: null };
    const T = 1_792_600_000_000;
    let s = run(initialMirror(), { type: "event", event: ev(1, "session.started", { session: { id: "s1", by: "alexa" } }), now: T - 60_000 }, { type: "event", event: ev(2, "card.open", { card, sessionId: "s1", deck }), now: T - 50_000 });
    s = run(s, { type: "event", event: ev(3, "attempt.graded", graded("agree", true)), now: T - 10_000 }, { type: "event", event: ev(4, "session.ended", { summary }), now: T });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill.overAt).toBe(T);
    s = run(s, { type: "tick", now: T + ROUND_OVER_MS - 1 });
    expect(drillPhase(s.drill)).toBe("over"); // still the filmed beat
    // Bee settles a late try: the hub re-sends the summary, which replaces it and keeps the clock
    s = run(s, { type: "event", event: ev(5, "session.ended", { summary: { ...summary, passed: 2, failed: 0 } }), now: T + 60_000 });
    expect(s.drill.summary?.passed).toBe(2);
    expect(s.drill.overAt).toBe(T);
    const before = s;
    expect(run(s, { type: "tick", now: T + ROUND_OVER_MS - 1 })).toBe(before); // nothing to redraw yet
    s = run(s, { type: "tick", now: T + ROUND_OVER_MS });
    expect(drillPhase(s.drill)).toBe("idle");
    expect(s.drill).toMatchObject({ summary: null, card: null, graded: null, stage: "idle", deck: { dueNow: 3 }, overAt: null });
    s = run(s, { type: "event", event: ev(6, "session.ended", { summary: { ...summary, passed: 2, failed: 0 } }), now: T + ROUND_OVER_MS + 5 });
    expect(drillPhase(s.drill)).toBe("idle");
    // the next round's end shows Round over again
    s = run(s, { type: "event", event: ev(7, "session.started", { session: { id: "s2", by: "alexa" } }), now: T + ROUND_OVER_MS + 10 }, { type: "event", event: ev(8, "session.ended", { summary: { ...summary, sessionId: "s2" } }), now: T + ROUND_OVER_MS + 20 });
    expect(drillPhase(s.drill)).toBe("over");
  });
  it("a verdict Bee settles after the round for an earlier line updates the tally only: Round over's last line stays the last line opened", () => {
    const k2 = { id: "k2", resay: "The dashboard loads slowly on Mondays." } as any;
    const prov = { attempt: { id: "a1", cardId: "k1", provisional: { source: "phone", text: "x", grade: { pass: true, reasons: [] } } }, card };
    // k1 said and still with Bee; k2 opened last and never said
    let s = run(initialMirror(), { type: "event", event: ev(1, "session.started", { session: { id: "s1", by: "alexa" } }), now: 0 }, { type: "event", event: ev(2, "card.open", { card, sessionId: "s1" }), now: 1 }, { type: "event", event: ev(3, "attempt.provisional", prov), now: 2 });
    s = run(s, { type: "event", event: ev(4, "card.open", { card: k2, sessionId: "s1" }), now: 3 }, { type: "event", event: ev(5, "session.ended", { summary: { ...summary, pending: 1 } }), now: 4 });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ card: null, stage: "idle", overCard: "k2" });
    const deck = { date: "2026-10-21", total: 6, dueNow: 2, boxes: {}, dueByDate: {}, nextDueDate: null };
    s = run(s, { type: "event", event: ev(6, "attempt.verified", { attemptId: "a1", cardId: "k1", status: "verified", via: "stream" }), now: 5 }, { type: "event", event: ev(7, "attempt.graded", { ...graded("agree", true), deck }), now: 6 });
    expect(s.drill).toMatchObject({ graded: null, verified: null, stage: "idle", deck: { dueNow: 2 } }); // never "Last line: passed"
    s = run(s, { type: "event", event: ev(8, "session.ended", { summary: { ...summary, passed: 2, failed: 0, pending: 0 } }), now: 7 });
    expect(s.drill.summary?.passed).toBe(2); // the re-sent summary still updates the tally
    expect(drillPhase(s.drill)).toBe("over");
  });
  it("Bee still checking at the end stays over, and the late verdict lands in it", () => {
    const prov = { attempt: { id: "a1", provisional: { source: "phone", text: "x", grade: { pass: true, reasons: [] } } }, card };
    let s = run(initialMirror(), { type: "event", event: ev(1, "card.open", { card }), now: 0 }, { type: "event", event: ev(2, "attempt.provisional", prov), now: 1 });
    expect(drillPhase(s.drill)).toBe("checking");
    s = run(s, { type: "event", event: ev(3, "session.ended", { summary: { ...summary, pending: 1 } }), now: 2 });
    expect(drillPhase(s.drill)).toBe("over");
    s = run(s, { type: "event", event: ev(4, "attempt.graded", graded("agree", true)), now: 3 });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill.graded?.pass).toBe(true);
  });
});

describe("Round over across a reconnect (hub.state lastSession)", () => {
  const T = 1_792_600_000_000; // this screen's clock
  const HUB = T - 86_400_000 + 4321; // the hub's clock (the demo clock runs a day behind)
  const OFFSET = HUB - T; // hub minus screen, as the bridge client estimates it
  const k1 = { id: "k1", resay: "The migration is not done yet." } as any;
  const k2 = { id: "k2", resay: "The dashboard loads slowly on Mondays." } as any;
  const deck = { date: "2026-10-20", total: 6, dueNow: 3, boxes: {}, dueByDate: {}, nextDueDate: null };
  const perCard = (l1: string, l2: string) => [{ cardId: "k1", habit: "unsure words", attempts: l1 === "passed" ? 1 : 0, passed: l1 === "passed" ? 1 : 0, box: 1, due: null, line: l1 }, { cardId: "k2", habit: "vague words", attempts: 0, passed: 0, box: 1, due: null, line: l2 }];
  // k1 said and still with Bee; k2 opened last and never said
  const summary = { sessionId: "s1", by: "alexa", startedAt: HUB - 60_000, endedAt: HUB, cards: 2, attempts: 1, counted: 0, passed: 0, failed: 0, unverified: 0, pending: 1, beeOverrules: 0, lines: { passed: 0, failed: 0, unverified: 0, pending: 1, untried: 1 }, perCard: perCard("pending", "untried") } as any;
  const settled = { ...summary, counted: 1, passed: 1, pending: 0, lines: { passed: 1, failed: 0, unverified: 0, pending: 0, untried: 1 }, perCard: perCard("passed", "untried") };
  const hubState = (lastSeq: number, lastSession: unknown, bootId = "boot_a") => ({ mode: "demo", dataLabel: "SYNTHETIC DEMO DATA (invented; not anyone's real results)", bootId, lastSeq, state: "idle", narration: "", verdictReady: false, retryAfterMs: null, session: null, openCard: null, lastAttempt: null, deck, bee: { replay: true, pendingVerifications: 1, lastEventAt: null, counters: {} }, ...(lastSession === undefined ? {} : { lastSession }) }) as any;
  const graded = (cardId: string, card: any) => ({ attempt: { id: `a_${cardId}`, cardId, status: "graded", agreement: "agree", provisional: { source: "phone", text: "x", grade: { pass: true, reasons: [] } }, final: { pass: true, grade: { reasons: [] } }, bee: { text: card.resay } }, card, deck });
  const lastLine = (s: MirrorState) => roundLastLine({ graded: s.drill.graded as any, stage: s.drill.stage, previewSource: s.drill.provisional?.source ?? null });
  const theRound = () => {
    const prov = { attempt: { id: "a_k1", cardId: "k1", provisional: { source: "phone", text: "x", grade: { pass: true, reasons: [] } } }, card: k1 };
    let s = run(initialMirror(), { type: "hubState", state: hubState(0, null), now: T - 70_000, offsetMs: OFFSET });
    s = run(s, { type: "event", event: ev(1, "session.started", { session: { id: "s1", by: "alexa" } }), now: T - 60_000 }, { type: "event", event: ev(2, "card.open", { card: k1, sessionId: "s1" }), now: T - 50_000 }, { type: "event", event: ev(3, "attempt.provisional", prov), now: T - 40_000 });
    return run(s, { type: "event", event: ev(4, "card.open", { card: k2, sessionId: "s1" }), now: T - 30_000 }, { type: "event", event: ev(5, "session.ended", { summary }), now: T });
  };

  it("R3: the TV reconnects 10 s after the round, Bee settles the earlier line at 30 s, the hub re-sends the summary: Round over stays, its last line is still the last one, and its 15 minutes still run from the round's end", () => {
    let s = theRound();
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ overAt: T, overCard: "k2", card: null });
    s = run(s, { type: "hubState", state: hubState(5, { summary, endedAt: HUB, lastCardId: "k2" }), now: T + 10_000, offsetMs: OFFSET }); // the socket reconnects
    expect(drillPhase(s.drill)).toBe("over"); // not the idle panel
    expect(s.drill).toMatchObject({ overAt: T, overCard: "k2", card: null, summary: { sessionId: "s1" } });
    s = run(s, { type: "event", event: ev(6, "attempt.graded", graded("k1", k1)), now: T + 30_000 }); // Bee settles k1, an earlier line
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ card: null, graded: null, stage: "idle" });
    s = run(s, { type: "event", event: ev(7, "session.ended", { summary: settled }), now: T + 30_001 });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill.summary?.lines.passed).toBe(1); // the tally has it
    expect(lastLine(s)).toBeNull(); // never "Last line: passed" for k1
    expect(s.drill.overAt).toBe(T); // not a fresh 15 minutes
    s = run(s, { type: "tick", now: T + ROUND_OVER_MS - 1 });
    expect(drillPhase(s.drill)).toBe("over");
    s = run(s, { type: "tick", now: T + ROUND_OVER_MS });
    expect(drillPhase(s.drill)).toBe("idle");
    // it timed out: neither a re-sent summary nor another reconnect brings it back
    s = run(s, { type: "event", event: ev(8, "session.ended", { summary: settled }), now: T + ROUND_OVER_MS + 5 });
    expect(drillPhase(s.drill)).toBe("idle");
    s = run(s, { type: "hubState", state: hubState(8, { summary: settled, endedAt: HUB, lastCardId: "k2" }), now: T + ROUND_OVER_MS + 10, offsetMs: OFFSET });
    expect(drillPhase(s.drill)).toBe("idle");
    s = run(s, { type: "event", event: ev(9, "session.ended", { summary: settled }), now: T + ROUND_OVER_MS + 20 });
    expect(drillPhase(s.drill)).toBe("idle");
  });
  it("a screen that joins after the round restores Round over from the hub, on its own clock, with the last line the hub names", () => {
    let s = run(initialMirror(), { type: "hubState", state: hubState(5, { summary, endedAt: HUB, lastCardId: "k2" }), now: T + 10_000, offsetMs: OFFSET });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ sessionId: "s1", overAt: T, overCard: "k2", card: null, stage: "idle" });
    s = run(s, { type: "event", event: ev(6, "attempt.graded", graded("k1", k1)), now: T + 30_000 }); // an earlier line: the tally only
    expect(lastLine(s)).toBeNull();
    s = run(s, { type: "event", event: ev(7, "session.ended", { summary: settled }), now: T + 30_001 });
    expect(s.drill.summary?.passed).toBe(1);
    s = run(s, { type: "event", event: ev(8, "attempt.graded", graded("k2", k2)), now: T + 40_000 }); // the last line: it lands
    expect(drillPhase(s.drill)).toBe("over");
    expect(lastLine(s)).toBe("Last line: passed. Bee heard it.");
    s = run(s, { type: "tick", now: T + ROUND_OVER_MS });
    expect(drillPhase(s.drill)).toBe("idle");
  });
  it("a round past its 15 minutes, or one this screen already timed out, is not restored, and its re-sent summary never brings it back", () => {
    let s = run(initialMirror(), { type: "hubState", state: hubState(5, { summary, endedAt: HUB }), now: T + ROUND_OVER_MS, offsetMs: OFFSET });
    expect(drillPhase(s.drill)).toBe("idle");
    s = run(s, { type: "event", event: ev(6, "session.ended", { summary: settled }), now: T + ROUND_OVER_MS + 1 });
    expect(drillPhase(s.drill)).toBe("idle");
    let t = run(theRound(), { type: "tick", now: T + ROUND_OVER_MS });
    expect(t.drill.overDone).toBe("s1");
    // the hub's clock runs behind this screen's: by the hub, the round is not 15 minutes old yet
    t = run(t, { type: "hubState", state: hubState(5, { summary, endedAt: HUB, lastCardId: "k2" }), now: T + ROUND_OVER_MS + 1, offsetMs: OFFSET - 60_000 });
    expect(drillPhase(t.drill)).toBe("idle");
  });
  // The last line, said and still with Bee when round s2 ended; Bee then passes it.
  const roundS2 = () => {
    const prov = { attempt: { id: "a_k2", cardId: "k2", provisional: { source: "phone", text: "x", grade: { pass: true, reasons: [] } } }, card: k2 };
    let s = run(theRound(), { type: "event", event: ev(6, "session.started", { session: { id: "s2", by: "alexa" } }), now: T + 1000 }, { type: "event", event: ev(7, "card.open", { card: k2, sessionId: "s2" }), now: T + 2000 }, { type: "event", event: ev(8, "attempt.provisional", prov), now: T + 3000 });
    const s2 = { ...summary, sessionId: "s2", endedAt: HUB + 4000, perCard: [{ ...perCard("pending", "pending")[1] }] };
    s = run(s, { type: "event", event: ev(9, "session.ended", { summary: s2 }), now: T + 4000 });
    return { s, settled: { ...s2, perCard: [{ ...s2.perCard[0], line: "passed" }] } };
  };
  it("Bee settled the last line while the screen was away: the hub's newest try at it lands, so Round over still says the last line passed (review L188)", () => {
    const r = roundS2();
    const settled = r.settled;
    let s = r.s;
    expect(lastLine(s)).toBe("Bee is still checking your last line. Its result lands here.");
    const lastAttempt = graded("k2", k2).attempt;
    s = run(s, { type: "hubState", state: hubState(11, { summary: settled, endedAt: HUB + 4000, lastCardId: "k2", lastAttempt }), now: T + 20_000, offsetMs: OFFSET });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ overAt: T + 4000, overCard: "k2", stage: "graded", attemptId: "a_k2" });
    expect(lastLine(s)).toBe("Last line: passed. Bee heard it.");
    // a screen that reloads gets the same last line from the hub
    const fresh = run(initialMirror(), { type: "hubState", state: hubState(11, { summary: settled, endedAt: HUB + 4000, lastCardId: "k2", lastAttempt }), now: T + 20_000, offsetMs: OFFSET });
    expect(drillPhase(fresh.drill)).toBe("over");
    expect(fresh.drill).toMatchObject({ overAt: T + 4000, overCard: "k2", card: null, stage: "graded" });
    expect(lastLine(fresh)).toBe("Last line: passed. Bee heard it.");
    // a try the hub names for another line is never read as the last line's
    const other = run(initialMirror(), { type: "hubState", state: hubState(11, { summary: settled, endedAt: HUB + 4000, lastCardId: "k2", lastAttempt: graded("k1", k1).attempt }), now: T + 20_000, offsetMs: OFFSET });
    expect(lastLine(other)).toBeNull();
    // a last line never said: no try, no sentence
    const unsaid = run(initialMirror(), { type: "hubState", state: hubState(11, { summary: settled, endedAt: HUB + 4000, lastCardId: "k2", lastAttempt: null }), now: T + 20_000, offsetMs: OFFSET });
    expect(lastLine(unsaid)).toBeNull();
  });
  it("a hub that sends no lastAttempt: the screen drops its \"still checking\" for a last line the tally says Bee settled", () => {
    const { s: ended, settled } = roundS2();
    const s = run(ended, { type: "hubState", state: hubState(11, { summary: settled, endedAt: HUB + 4000, lastCardId: "k2" }), now: T + 20_000, offsetMs: OFFSET });
    expect(drillPhase(s.drill)).toBe("over");
    expect(s.drill).toMatchObject({ overAt: T + 4000, overCard: "k2", card: null, stage: "idle" });
    expect(lastLine(s)).toBeNull();
  });
  it("a card open or a round under way wins; an older hub without lastSession keeps the Round over a screen shows, unless it restarted", () => {
    const open = { ...hubState(5, null), openCard: k1 };
    expect(drillPhase(run(theRound(), { type: "hubState", state: open, now: T + 10_000, offsetMs: OFFSET }).drill)).toBe("line");
    expect(drillPhase(run(theRound(), { type: "hubState", state: hubState(5, null), now: T + 10_000, offsetMs: OFFSET }).drill)).toBe("idle"); // a card opened and closed since
    const older = run(theRound(), { type: "hubState", state: hubState(5, undefined), now: T + 10_000 });
    expect(drillPhase(older.drill)).toBe("over");
    expect(older.drill).toMatchObject({ overAt: T, overCard: "k2" });
    expect(drillPhase(run(theRound(), { type: "hubState", state: hubState(0, undefined, "boot_b"), now: T + 10_000 }).drill)).toBe("idle");
  });
});
