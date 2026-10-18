// Pre-meeting nudge: the next calendar event (Bee's today brief via `bee today --json`), the
// wearer's top habit this week, and one warm-up card for it. Calendar titles are served live and
// never persisted.
import { execFile } from "node:child_process";
import { trackChild } from "./processGuards.js";
import { promisify } from "node:util";
import { localDate } from "../real/deck.js";
import { dueCards } from "./scheduler.js";
import { habitOf } from "./cards.js";
import type { CoachHub } from "./core.js";
import type { HabitKind } from "./habits.js";

export interface CalendarEvent {
  title: string;
  startsAt: number; // epoch ms
}
export type CalendarFn = () => Promise<{ events: CalendarEvent[]; source: string; note?: string }>;

const execFileP = promisify(execFile);

const pickTime = (o: Record<string, unknown>): number | null => {
  for (const k of ["start", "start_time", "startTime", "start_date", "starts_at", "begin"]) {
    const v = o[k];
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return Date.parse(v);
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).dateTime ?? (v as Record<string, unknown>).date;
      if (typeof inner === "string" && !Number.isNaN(Date.parse(inner))) return Date.parse(inner);
    }
  }
  return null;
};

// Live: `bee today --json` -> { calendar_events: [...], emails: [...], timezone }. The event shape is
// not documented and the operator's calendar was empty when this was written (2026-10-16), so
// fields are read defensively. Emails are ignored.
export function beeCalendar(bin = process.env.BEE_BIN ?? "bee", timeoutMs = 10_000): CalendarFn {
  let cache: { at: number; value: Awaited<ReturnType<CalendarFn>> } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.value;
    try {
      const p = execFileP(bin, ["today", "--json"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
      trackChild(p.child);
      const { stdout } = await p;
      const o = JSON.parse(stdout) as { calendar_events?: unknown[] };
      const events = (o.calendar_events ?? [])
        .map((e) => e as Record<string, unknown>)
        .map((e) => ({ title: String(e.title ?? e.summary ?? e.name ?? "Calendar event"), startsAt: pickTime(e) }))
        .filter((e): e is CalendarEvent => e.startsAt != null);
      const value = { events, source: "bee today", note: events.length ? undefined : "Bee's today brief has no calendar events (connect a calendar in the Bee app)" };
      cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      return { events: [], source: "bee today", note: `bee today failed: ${(err as Error).message.split("\n")[0]}` };
    }
  };
}

export const HERO_MIN_COUNT = 3;
const HABIT_FOR: Record<string, HabitKind> = { hedges: "hedge", vague: "vague", fillers: "filler", restarts: "restart" };

export async function buildBrief(hub: CoachHub, calendar: CalendarFn) {
  const now = hub.clock();
  const cal = await calendar();
  const next = cal.events.filter((e) => e.startsAt >= now - 5 * 60_000).sort((a, b) => a.startsAt - b.startsAt)[0] ?? null;
  let st = hub.stats({ kind: "week" });
  let range = "week";
  if (!st.habits.words) (st = hub.stats({ kind: "all" })), (range = "all");
  const h = st.habits;
  // Hero habits (hedges, vague answers) win when they have at least HERO_MIN_COUNT occurrences;
  // fillers and restarts are the fallback.
  const rank = (keys: readonly ("hedges" | "vague" | "fillers" | "restarts")[]) => keys.map((k) => ({ key: k, per100: h[k].per100, count: h[k].count })).sort((a, b) => b.per100 - a.per100);
  const hero = rank(["hedges", "vague"]).filter((x) => x.count >= HERO_MIN_COUNT);
  const rest = rank(["fillers", "restarts"]).filter((x) => x.count > 0);
  const top = hero[0] ?? rest[0] ?? null;
  const due = dueCards(hub.deck, hub.today());
  const want = top ? HABIT_FOR[top.key] : undefined;
  const warm = due.find((c) => habitOf(c).kind === want) ?? hub.deck.cards.find((c) => habitOf(c).kind === want) ?? due[0] ?? null;
  const mins = next ? Math.round((next.startsAt - now) / 60_000) : null;
  const label: Record<string, string> = { hedges: "hedging", vague: "vague answers", fillers: "fillers", restarts: "restarts" };
  const nudge = [
    next ? `${next.title} in ${mins} min.` : "No meeting on your calendar soon.",
    top ? `Your top habit this ${range === "week" ? "week" : "period"}: ${label[top.key]} (${top.per100} per 100 words).` : "Not enough of your speech yet to pick a habit.",
    warm ? `Warm up: say "${warm.resay}" once, cleanly.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    dataLabel: hub.dataLabel,
    generatedAt: new Date(now).toISOString(),
    event: next ? { title: next.title, startsAt: new Date(next.startsAt).toISOString(), startsInMin: mins, date: localDate(next.startsAt, hub.tz), source: cal.source } : null,
    eventNote: cal.note ?? null,
    topHabit: top ? { key: top.key, label: label[top.key], per100: top.per100, count: top.count, words: h.words, range, source: st.source } : null,
    warmup: warm ? hub.view(warm) : null,
    nudge,
  };
}
