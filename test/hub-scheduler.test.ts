// Leitner practice scheduling for the hub. Synthetic cards only.
import { describe, expect, it } from "vitest";
import type { HubCard } from "../src/hub/cards.js";
import { applyResult, dueCards, nextDue, summarize, type HubDeck } from "../src/hub/scheduler.js";

const NOW = Date.parse("2026-10-20T13:30:00-04:00");
const TODAY = "2026-10-20";
const card = (id: string, box: number, due: string, extra: Partial<HubCard> = {}): HubCard => ({
  id, kind: "error", lang: "en", type: "EN_HEDGE_STACK", key: `u:${id}`, session: "s", said: "x", fix: "y", resay: "y.", why: "", line: "", score: 1, box, due, added: "2026-10-15", relapses: 0, lastSeenSession: "s", ...extra,
});

describe("hub scheduler", () => {
  it("orders due cards: lowest box, then relapses, then least recently practised", () => {
    const deck: HubDeck = { cards: [card("b2", 2, TODAY), card("b1", 1, TODAY, { lastAttemptAt: NOW - 1000 }), card("b1-old", 1, TODAY, { lastAttemptAt: NOW - 9000 }), card("future", 1, "2026-10-21"), card("relapsed", 1, TODAY, { relapses: 2, lastAttemptAt: NOW })] };
    expect(dueCards(deck, TODAY).map((c) => c.id)).toEqual(["relapsed", "b1-old", "b1", "b2"]);
    expect(nextDue(deck, TODAY, "relapsed")!.id).toBe("b1-old");
    expect(nextDue({ cards: [card("only", 1, TODAY)] }, TODAY, "only")!.id).toBe("only");
  });
  it("a pass on a due card moves it up a box with the Leitner interval", () => {
    const deck: HubDeck = { cards: [card("c", 2, TODAY)] };
    expect(applyResult(deck, "c", true, NOW)).toEqual({ from: 2, to: 3, dueBefore: TODAY, dueAfter: "2026-10-24", scheduled: true });
    expect(deck.cards[0]!.passes).toBe(1);
  });
  it("a pass on a card that is not due is practice only", () => {
    const deck: HubDeck = { cards: [card("c", 3, "2026-10-25")] };
    expect(applyResult(deck, "c", true, NOW)).toMatchObject({ from: 3, to: 3, dueAfter: "2026-10-25", scheduled: false });
  });
  it("a fail drops the card to box 1, due again today behind other due cards", () => {
    const deck: HubDeck = { cards: [card("c", 3, "2026-10-25"), card("d", 1, TODAY, { lastAttemptAt: NOW - 60_000 })] };
    expect(applyResult(deck, "c", false, NOW)).toMatchObject({ from: 3, to: 1, dueAfter: TODAY, scheduled: true });
    expect(nextDue(deck, TODAY)!.id).toBe("d");
  });
  it("summarizes boxes and due counts", () => {
    const s = summarize({ cards: [card("a", 1, TODAY), card("b", 2, "2026-10-19"), card("c", 5, "2026-11-30")] }, TODAY);
    expect(s).toMatchObject({ total: 3, dueNow: 2, boxes: { "1": 1, "2": 1, "3": 0, "4": 0, "5": 1 }, nextDueDate: "2026-11-30" });
    expect(s.dueByDate[TODAY]).toBe(2);
  });
});
