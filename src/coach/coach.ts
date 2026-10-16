// Pre-registered drilled/control split, drill cards, and a Leitner schedule driven by
// re-performance checks in later Bee recordings.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "../analyze/extract.js";
import type { Lang } from "../analyze/taxonomy.js";

export interface Prereg {
  lang: Lang;
  registered_at: string;
  cutover_ms: number;
  basis: string;
  pre_items_sha256: string;
  seed: string;
  recurring: Record<string, number>; // type -> distinct pre-cutover sessions with a detection
  drilled: string[];
  control: string[];
}

const usable = (i: Item) => i.citation_valid && i.excerpt_grounded && !i.asr_suspect;

export function recurringTypes(preItems: Item[], minSessions = 2): Record<string, number> {
  const sessions = new Map<string, Set<string>>();
  for (const i of preItems.filter(usable)) {
    if (!sessions.has(i.error_type)) sessions.set(i.error_type, new Set());
    sessions.get(i.error_type)!.add(i.session_id);
  }
  return Object.fromEntries([...sessions].filter(([, s]) => s.size >= minSessions).map(([t, s]) => [t, s.size]).sort());
}

// Seeded Fisher-Yates; seed is a hash of the pre-cutover evidence, so it is fixed before any
// post-cutover data exists and cannot be re-rolled without changing the evidence.
export function registerSplit(lang: Lang, preItems: Item[], cutoverMs: number, dir = "prereg"): { prereg: Prereg; reused: boolean } {
  const evidence = preItems
    .filter(usable)
    .map((i) => `${i.utterance_id}|${i.error_type}`)
    .sort()
    .join("\n");
  const sha = createHash("sha256").update(evidence).digest("hex");
  const file = join(dir, `${lang}-split.json`);
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8")) as Prereg;
    if (prev.pre_items_sha256 === sha) return { prereg: prev, reused: true };
    if (process.env.PREREG_FORCE !== "1")
      throw new Error(`${file} was registered on different pre-cutover evidence. Refusing to re-split (set PREREG_FORCE=1 to override and disclose it).`);
  }
  const recurring = recurringTypes(preItems);
  const types = Object.keys(recurring).sort();
  const seed = createHash("sha256").update(`split|${lang}|${sha}`).digest("hex");
  let a = parseInt(seed.slice(0, 8), 16);
  const rng = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const shuffled = [...types];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const half = Math.ceil(shuffled.length / 2);
  const prereg: Prereg = {
    lang,
    registered_at: new Date().toISOString(),
    cutover_ms: cutoverMs,
    basis: "error types detected (citation-valid, grounded, not ASR-suspect) in >= 2 distinct pre-cutover sessions, all channels, cleaned variant",
    pre_items_sha256: sha,
    seed,
    recurring,
    drilled: shuffled.slice(0, half).sort(),
    control: shuffled.slice(half).sort(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(prereg, null, 2) + "\n");
  return { prereg, reused: false };
}

export interface DrillCard {
  id: string;
  lang: Lang;
  error_type: string;
  source_utterance: string;
  said: string;
  fix: string;
  resay: string;
  why: string;
}

export function drillCards(lang: Lang, preItems: Item[], drilled: string[]): DrillCard[] {
  const cards: DrillCard[] = [];
  for (const t of drilled) {
    const cands = preItems.filter((i) => usable(i) && i.error_type === t).sort((a, b) => (a.session_kind === b.session_kind ? b.startMs - a.startMs : a.session_kind === "voice_note" ? -1 : 1));
    for (const i of cands.slice(0, 2))
      cards.push({ id: `${t}:${i.utterance_id}`, lang, error_type: t, source_utterance: i.utterance_id, said: i.excerpt, fix: i.correction, resay: i.resay_prompt, why: i.explanation });
  }
  return cards;
}

const DAY = 86_400_000;
const INTERVALS = [1, 2, 4, 8, 16];
export interface ScheduleEvent {
  card: string;
  day: string;
  event: "review" | "relapse";
  box: number;
  next_due: string;
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (ms: number) => Math.floor((ms - 4 * 3600_000) / DAY) * DAY + 4 * 3600_000; // EDT midnight

export function leitner(cards: DrillCard[], postItems: Item[], startMs: number, endMs: number): ScheduleEvent[] {
  const ev: ScheduleEvent[] = [];
  const relapse = new Map<string, Set<number>>(); // type -> days with a recurrence
  for (const i of postItems.filter(usable)) {
    if (!relapse.has(i.error_type)) relapse.set(i.error_type, new Set());
    relapse.get(i.error_type)!.add(dayOf(i.startMs));
  }
  for (const c of cards) {
    let box = 0;
    let due = dayOf(startMs);
    for (let d = dayOf(startMs); d <= endMs; d += DAY) {
      if (relapse.get(c.error_type)?.has(d)) {
        box = 0;
        due = d + DAY;
        ev.push({ card: c.id, day: iso(d), event: "relapse", box: 1, next_due: iso(due) });
        continue;
      }
      if (d >= due) {
        box = Math.min(box + 1, INTERVALS.length - 1);
        due = d + INTERVALS[box]! * DAY;
        ev.push({ card: c.id, day: iso(d), event: "review", box: box + 1, next_due: iso(due) });
      }
    }
  }
  return ev;
}
