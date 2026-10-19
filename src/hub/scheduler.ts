// Practice scheduler over the Leitner deck (src/real/deck.ts).
//   next due:  due cards (due <= today), lowest box first, then most relapses, then the one
//              practised least recently, then the deck's ranking score.
//   pass:      a due card moves up a box (markReviewed: box + 1, due = today + interval).
//              A card that was not due is practice only: recorded, no box change.
//   fail:      the card drops to box 1 and stays due today, behind the other due cards.
// Only a final grade (of Bee's wearer-tagged text) is applied; a provisional phone/Alexa grade never is.
// Persistence: the deck JSON (real/deck.json in live mode; out/demo/deck.json in demo mode).
import { readJsonSafe, writeJsonAtomic } from "./atomic.js";
import { addDays, INTERVALS_DAYS, localDate, markReviewed } from "../real/deck.js";
import type { HubCard } from "./cards.js";

export interface HubDeck {
  cards: HubCard[];
}

export interface BoxChange {
  from: number;
  to: number;
  dueBefore: string;
  dueAfter: string;
  scheduled: boolean; // false = practice on a card that was not due (no box change)
}

export function loadHubDeck(path: string): HubDeck {
  return readJsonSafe<HubDeck>(path, () => ({ cards: [] }));
}

// tmp + rename: a kill mid-write keeps the previous deck (src/hub/atomic.ts).
export function saveHubDeck(path: string, deck: HubDeck) {
  writeJsonAtomic(path, deck);
}

export function dueCards(deck: HubDeck, today: string): HubCard[] {
  return deck.cards
    .filter((c) => c.due <= today)
    .sort(
      (a, b) =>
        a.box - b.box ||
        b.relapses - a.relapses ||
        (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0) ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
    );
}

// The next card to open. `exclude` (usually the card just attempted) is skipped when another is due.
export function nextDue(deck: HubDeck, today: string, exclude?: string): HubCard | null {
  const due = dueCards(deck, today);
  return due.find((c) => c.id !== exclude) ?? due[0] ?? null;
}

export function applyResult(deck: HubDeck, id: string, pass: boolean, nowMs: number, tz?: string): BoxChange | null {
  const c = deck.cards.find((x) => x.id === id);
  if (!c) return null;
  const today = localDate(nowMs, tz);
  const before = { from: c.box, dueBefore: c.due };
  const wasDue = c.due <= today;
  c.lastAttemptAt = nowMs;
  if (pass) {
    c.passes = (c.passes ?? 0) + 1;
    if (wasDue) markReviewed(deck as { cards: HubCard[] }, id, nowMs, tz); // the same zone as `today`
  } else {
    c.fails = (c.fails ?? 0) + 1;
    c.box = 1;
    c.due = today;
  }
  return { ...before, to: c.box, dueAfter: c.due, scheduled: wasDue || !pass };
}

export interface DeckSummary {
  date: string;
  total: number;
  dueNow: number;
  boxes: Record<string, number>; // "1".."5" -> cards
  dueByDate: Record<string, number>; // next 7 days
  nextDueDate: string | null;
}

export function summarize(deck: HubDeck, today: string): DeckSummary {
  const boxes: Record<string, number> = {};
  for (let b = 1; b <= INTERVALS_DAYS.length; b++) boxes[String(b)] = 0;
  for (const c of deck.cards) boxes[String(c.box)] = (boxes[String(c.box)] ?? 0) + 1;
  const dueByDate: Record<string, number> = {};
  for (let d = 0; d < 7; d++) dueByDate[addDays(today, d)] = 0;
  for (const c of deck.cards) {
    const key = c.due <= today ? today : c.due;
    if (key in dueByDate) dueByDate[key]!++;
  }
  const future = deck.cards.map((c) => c.due).filter((d) => d > today).sort();
  return { date: today, total: deck.cards.length, dueNow: deck.cards.filter((c) => c.due <= today).length, boxes, dueByDate, nextDueDate: future[0] ?? null };
}
