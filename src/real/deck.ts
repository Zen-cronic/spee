// Leitner deck for real drills, persisted to gitignored real/deck.json.
// New cards enter box 1 (due tomorrow). A card relapses to box 1 when its error type recurs in a
// newer session; it moves up a box when the operator marks it reviewed (`npm run review`, later).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Drill } from "./analyze.js";

export const INTERVALS_DAYS = [1, 2, 4, 8, 16];
export const TZ = process.env.BEE_TZ ?? "America/Toronto";

export interface Card extends Drill {
  box: number; // 1..5
  due: string; // local date YYYY-MM-DD
  added: string;
  relapses: number;
  lastSeenSession: string;
}
export interface Deck {
  cards: Card[];
}

export const localDate = (ms: number, tz = TZ) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function loadDeck(path: string): Deck {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Deck) : { cards: [] };
}
export function saveDeck(path: string, deck: Deck) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(deck, null, 1) + "\n");
}

// Merge tonight's drills into the deck. Returns the relapsed cards.
export function updateDeck(deck: Deck, drills: Drill[], nowMs: number): { added: Card[]; relapsed: Card[] } {
  const today = localDate(nowMs);
  const tomorrow = addDays(today, 1);
  const byId = new Map(deck.cards.map((c) => [c.id, c]));
  const added: Card[] = [];
  const relapsed: Card[] = [];
  const typesTonight = new Map<string, string>();
  for (const d of drills) if (d.kind === "error") typesTonight.set(d.type, d.session);
  for (const c of deck.cards) {
    const s = typesTonight.get(c.type);
    if (c.kind === "error" && s && s !== c.session && c.lastSeenSession !== s) {
      c.box = 1;
      c.due = tomorrow;
      c.relapses++;
      c.lastSeenSession = s;
      relapsed.push(c);
    }
  }
  for (const d of drills) {
    if (byId.has(d.id)) continue;
    const c: Card = { ...d, box: 1, due: tomorrow, added: today, relapses: 0, lastSeenSession: d.session };
    deck.cards.push(c);
    byId.set(c.id, c);
    added.push(c);
  }
  return { added, relapsed };
}

export function dueOn(deck: Deck, date: string, n = 3): Card[] {
  // Mix: the best card of each kind first (an error, a vocabulary gap, a filler line), then one
  // card per error type, so tomorrow's drills are different skills.
  const due = deck.cards.filter((c) => c.due <= date).sort((a, b) => a.box - b.box || b.relapses - a.relapses || b.score - a.score);
  const out: Card[] = [];
  const kinds = new Set<string>();
  const types = new Set<string>();
  for (const c of due) if (out.length < n && !kinds.has(c.kind)) out.push(c), kinds.add(c.kind), types.add(c.type);
  for (const c of due) if (out.length < n && !out.includes(c) && !types.has(c.type)) out.push(c), types.add(c.type);
  for (const c of due) if (out.length < n && !out.includes(c)) out.push(c);
  return out;
}

export function markReviewed(deck: Deck, id: string, nowMs: number): Card | null {
  const c = deck.cards.find((x) => x.id === id);
  if (!c) return null;
  c.box = Math.min(c.box + 1, INTERVALS_DAYS.length);
  c.due = addDays(localDate(nowMs), INTERVALS_DAYS[c.box - 1]!);
  return c;
}
