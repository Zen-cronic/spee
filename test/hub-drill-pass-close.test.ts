// A card Bee passed stops collecting attempts: the wearer's next everyday line is not graded
// against it.
// A manual clock and Bee events shaped like the live stream (wearer-tagged, Bee-only: no preview).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BeeEvent } from "../src/hub/bee.js";
import { deriveHabit, deriveMustSay, type HubCard } from "../src/hub/cards.js";
import { CoachHub, type Attempt, type HubEvent } from "../src/hub/core.js";
import { DEMO_TZ, DEMO_WEARER } from "../src/hub/demoData.js";
import type { HubDeck } from "../src/hub/scheduler.js";
import { wearerRule } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T20:00:00-04:00");
const LIKE = "demo:filler-like"; // "The dashboard loads slowly on Mondays."
const STRAY = "The dashboard loads, like, on Mondays."; // close enough to be taken for the card, and a fail

function rig() {
  let now = T0;
  const deck = JSON.parse(readFileSync("fixtures/demo/deck.json", "utf8")) as HubDeck;
  deck.cards = deck.cards.map((c: HubCard) => ({ ...c, habit: c.habit ?? deriveHabit(c), mustSay: c.mustSay ?? deriveMustSay(c) }));
  const hub = new CoachHub({ mode: "demo", clock: () => now, tz: DEMO_TZ, deck, deckPath: null, attempts: [], attemptsPath: null, sessions: [], prereg: null, preregPath: "p", wearer: wearerRule(DEMO_WEARER, ""), replay: true });
  const events: HubEvent[] = [];
  const changed: { reason: string; cardId?: string }[] = [];
  hub.on("event", (e: HubEvent) => events.push(e));
  hub.on("state.changed", (w: { reason: string; cardId?: string }) => changed.push(w));
  let id = 500;
  // The wearer says `text` at now+atMs; Bee delivers the line and its wearer tag 6 s later.
  const say = (text: string, atMs: number) => {
    const n = ++id;
    const spoken = now + atMs;
    now = spoken + 6000;
    const utt: BeeEvent = { type: "new-utterance", conversation_uuid: "conv-1", utterance: { id: n, sample_id: `s${n}`, start: 0, end: 3, text, spoken_at: new Date(spoken).toISOString() } };
    hub.ingestBee(utt);
    hub.ingestBee({ type: "tagged-utterance", utterance_id: n, person_id: 1, person_first_name: DEMO_WEARER.first_name, speaker_score: 0.82, conversation_uuid: "conv-1" });
  };
  const graded = () => events.filter((e) => e.topic === "attempt.graded").map((e) => e.payload.attempt as Attempt);
  return { hub, events, changed, say, graded, card: (cid: string) => hub.card(cid)!, at: () => now, advance: (ms: number) => (now += ms) };
}

describe("a passed card stops collecting attempts", () => {
  it("outside a session: Bee's PASS closes the card, and the next everyday line is not graded as a FAIL", () => {
    const r = rig();
    const view = () => r.hub.view(r.card(LIKE));
    const before = { passes: view().passes, fails: view().fails };
    const c = r.hub.openCard({ cardId: LIKE, by: "tv" })!;
    r.say(c.resay, 10_000);
    expect(r.graded().map((a) => [a.agreement, a.final?.pass])).toEqual([["bee-only", true]]);
    // the card closed with the pass: screens are re-sent hub.state, which still shows the verdict
    expect(r.hub.open).toBeNull();
    expect(r.changed).toEqual([{ reason: "card-passed", cardId: LIKE }]);
    const st = r.hub.sessionState();
    expect(st.openCard).toBeNull();
    expect(st.lastAttempt?.final?.pass).toBe(true);
    expect(st.narration).toMatch(/pass, so the card is closed/);
    expect(r.hub.drillActive()).toBe(false); // live nudges are not held back by a finished card
    // the wearer goes on talking: the stray line is everyday speech, not a second, failed attempt
    r.say(STRAY, 15_000);
    expect(r.graded()).toHaveLength(1);
    expect(view()).toMatchObject({ passes: before.passes + 1, fails: before.fails });
    // a new card clears the closed one from hub.state
    r.hub.openCard({ by: "tv" });
    expect(r.hub.sessionState().lastAttempt).toBeNull();
    r.hub.dispose();
  });
  it("the stray line alone would have been graded against the open card (the rig reproduces the bug's input)", () => {
    const r = rig();
    r.hub.openCard({ cardId: LIKE, by: "tv" });
    r.say(STRAY, 10_000);
    expect(r.graded().map((a) => [a.agreement, a.final?.pass])).toEqual([["bee-only", false]]);
    r.hub.dispose();
  });
  it("after a FAIL the card stays open and the wearer can say it again", () => {
    const r = rig();
    const c = r.hub.openCard({ cardId: LIKE, by: "tv" })!;
    r.say(STRAY, 10_000);
    expect(r.hub.open?.cardId).toBe(LIKE);
    expect(r.changed).toEqual([]);
    r.say(c.resay, 5000);
    expect(r.graded().map((a) => a.final?.pass)).toEqual([false, true]);
    expect(r.hub.open).toBeNull();
    r.hub.dispose();
  });
  it("in a session: the passed card stays on screen awaiting next, takes no stray line, and next moves on", () => {
    const r = rig();
    const { card } = r.hub.startSession({ by: "alexa", size: 2 });
    r.say(card!.resay, 10_000);
    expect(r.graded().map((a) => a.final?.pass)).toEqual([true]);
    expect(r.hub.open?.cardId).toBe(card!.id); // awaits "next" (the voice flows advance on the verdict)
    expect(r.changed).toEqual([]);
    expect(r.hub.sessionState()).toMatchObject({ state: "graded", narration: "Bee heard it. That's a pass. Say next for the next card." });
    r.say(card!.resay.replace(/\.$/, ", like, you know."), 15_000);
    expect(r.graded()).toHaveLength(1);
    const n = r.hub.nextInSession();
    expect(n.card?.id).not.toBe(card!.id);
    // the new card takes Bee-only attempts again
    r.say(n.card!.resay, 10_000);
    expect(r.graded().map((a) => [a.cardId, a.final?.pass])).toEqual([[card!.id, true], [n.card!.id, true]]);
    r.hub.dispose();
  });
  it("a deliberate retry of a passed card (a preview naming it) still counts", () => {
    const r = rig();
    const c = r.hub.openCard({ cardId: LIKE, by: "tv" })!;
    r.say(c.resay, 10_000);
    const a = r.hub.submit({ text: c.resay, source: "phone", cardId: LIKE, speechEndAt: r.at() + 3000 }) as Attempt;
    expect(r.hub.open?.cardId).toBe(LIKE); // the submit reopened it
    r.say(c.resay, 0);
    expect(r.hub.attempts.find((x) => x.id === a.id)).toMatchObject({ status: "graded", agreement: "agree" });
    r.hub.dispose();
  });
});
