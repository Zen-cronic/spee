// The if-then wrist cue (POST /api/coach/cue): one fixed line, at most WRIST_TEXT_MAX characters,
// through the same wrist queue as nudges and recaps (kind "cue"), so a Bee to-do alarm buzzes the
// Watch before a conversation. The coaching skill times it; the hub never reads a calendar for it.
//
// Code decides, from structured fields only:
//   - opt-in: COACH_CUES=1 in live mode (the demo hub always answers, on the replay wrist);
//   - only a pre-registered DRILLED habit (CUE_HABITS: hedges, filler:like) that has been practised
//     (a counted drill, so the transfer has its firstDrillAt). Never the control (restart): a cue
//     about it would be practice and would spoil the check. Never an unpractised habit;
//   - the habit cued is the practised one with the higher latest rate (ties: CUE_HABITS order);
//   - dedupe on the alarm: a cue for the same habit whose alarm is within CUE_DEDUPE_MS of an
//     earlier cue's alarm is that cue again (deduped: true), and no second to-do. When it was asked
//     for does not matter, so the cues for meetings 14 min or more apart (the skill cues 8 to 12 min
//     before each) never meet. A request while a send for the habit is in flight waits for its
//     outcome: a failed send is reported as failed, never as already set;
//   - at most CUE_CAP_PER_DAY cues a local day; never for an alarm in quiet hours;
//   - the text is CUE_TEXT (rules.ts): never a calendar title, never a transcript line.
// Ledger: <stateDir>/live/cues.json (ids, the fixed text, alarm times; live mode only).
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../atomic.js";
import { CUE_HABITS, type CueResponse, type ErrorBody } from "../contract.js";
import type { CoachHub } from "../core.js";
import { maskOut } from "../mask.js";
import { localDate } from "../../real/deck.js";
import { clockTime, DEFAULT_POLICY, inQuietHours } from "./policy.js";
import { CUE_TEXT, type CueHabit } from "./rules.js";
import type { Wrist } from "./wrist.js";

export const CUE_DEDUPE_MS = 10 * 60_000; // two alarms closer than this are one cue
export const CUE_CAP_PER_DAY = 3;
export const CUE_MAX_MINUTES = 180;
const KEEP_MS = 7 * 24 * 3600_000;

type Log = (event: string, data?: Record<string, unknown>) => void;
type TransferLike = { habits: { habit: string; role: "drilled" | "control"; firstDrillAt: number | null; before: { words: number; per100: number }; after: { words: number; per100: number } }[] } | null;

/** COACH_CUES=1 turns cues on in live mode; the demo hub always answers (replay wrist, no Bee call). */
export const cuesEnabledFor = (o: { demo: boolean; env?: Record<string, string | undefined> }): boolean => o.demo || (o.env ?? process.env).COACH_CUES === "1";

/** The habits a cue may name now: drilled (pre-registered), practised, and in CUE_HABITS. Best first. */
export function cueHabits(t: TransferLike): CueHabit[] {
  const allowed = CUE_HABITS as readonly string[];
  const latest = (h: NonNullable<TransferLike>["habits"][number]) => (h.after.words > 0 ? h.after.per100 : h.before.per100);
  return (t?.habits ?? [])
    .filter((h) => h.role === "drilled" && h.firstDrillAt != null && allowed.includes(h.habit))
    .sort((a, b) => latest(b) - latest(a) || allowed.indexOf(a.habit) - allowed.indexOf(b.habit))
    .map((h) => h.habit as CueHabit);
}

export function badCueRequest(b: Record<string, unknown>): string | null {
  if (b.inMinutes !== undefined && (typeof b.inMinutes !== "number" || !Number.isFinite(b.inMinutes) || b.inMinutes < 0 || b.inMinutes > CUE_MAX_MINUTES)) return `inMinutes must be a number from 0 to ${CUE_MAX_MINUTES}`;
  if (b.by !== undefined && (typeof b.by !== "string" || b.by.length > 40)) return "by must be a short string";
  return null;
}

interface CueRecord {
  id: string;
  habit: CueHabit;
  text: string;
  alarmAt: number | null;
  by: string;
  at: number;
  day: string;
  wrist: CueResponse["wrist"];
}

export interface CueBookOptions {
  hub: CoachHub;
  wrist: Wrist;
  enabled: boolean;
  stateDir: string | null; // persisted in live mode only
  clock?: () => number;
  transfer?: () => TransferLike; // default: the hub's pre-registered transfer
  dedupeMs?: number;
  capPerDay?: number;
  log?: Log;
}

let n = 0;
const sent = (r: CueRecord) => r.wrist.status !== "failed";

export class CueBook {
  private cues: CueRecord[] = [];
  private inFlight = new Map<CueHabit, Promise<CueRecord>>();
  private saveFailed = false;

  constructor(private o: CueBookOptions) {
    if (this.path) {
      const saved = readJsonSafe<{ cues?: CueRecord[] }>(this.path, () => ({}), (m) => this.log("cue.ledger.recovered", { message: m }));
      this.cues = Array.isArray(saved?.cues) ? saved.cues : [];
    }
  }

  get enabled() {
    return this.o.enabled;
  }
  private get path() {
    return this.o.stateDir ? join(this.o.stateDir, "live", "cues.json") : null;
  }
  private now() {
    return (this.o.clock ?? this.o.hub.clock)();
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.o.log?.(event, data);
  }

  private save() {
    const p = this.path;
    if (!p) return;
    const keepFrom = this.now() - KEEP_MS;
    this.cues = this.cues.filter((c) => c.at >= keepFrom).slice(-200);
    try {
      writeJsonAtomic(p, { note: "If-then wrist cues the coach sent (its fixed text only)", cues: this.cues });
      this.saveFailed = false;
    } catch (err) {
      if (!this.saveFailed) this.log("cue.ledger.save-failed", { error: (err as Error).message });
      this.saveFailed = true;
    }
  }

  private narrate(r: CueRecord, deduped: boolean): string {
    const tz = this.o.hub.tz;
    const at = r.alarmAt != null ? clockTime(r.alarmAt, tz) : null;
    const line = r.text.replace(/^\[coach\] /, "");
    // A failed send never reads as "already set".
    if (r.wrist.status === "failed") return "I couldn't put the cue on your wrist: Bee didn't take the to-do.";
    if (deduped) {
      // Never "already set for" an alarm that has gone off.
      const now = this.now();
      if (r.alarmAt != null && r.alarmAt > now) return `That cue is already set for ${at}, so I didn't send another.`;
      const ago = r.alarmAt != null ? Math.round((now - r.alarmAt) / 60_000) : 0;
      return `That cue went off ${ago >= 1 ? `${ago} min ago` : "just now"}, so I didn't send another.`;
    }
    if (r.wrist.status === "replay") return `Demo cue, no Bee call: the wrist alarm would go off${at ? ` at ${at}` : ""}. ${line}`;
    return `Cue set: your wrist alarm goes off${at ? ` at ${at}` : ""}. ${line}`;
  }

  private ok(r: CueRecord, deduped: boolean): { status: number; body: CueResponse } {
    return { status: 200, body: { cue: { id: r.id, habit: r.habit, text: r.text, alarmAt: r.alarmAt, by: r.by }, wrist: { ...r.wrist }, deduped, narration: this.narrate(r, deduped) } };
  }
  private err(status: number, error: string, message: string): { status: number; body: ErrorBody } {
    return { status, body: { error, message } };
  }

  async request(b: Record<string, unknown>): Promise<{ status: number; body: CueResponse | ErrorBody }> {
    const bad = badCueRequest(b);
    if (bad) return this.err(400, "bad_request", bad);
    if (!this.o.enabled) return this.err(409, "cues_off", "wrist cues are off: start the hub with COACH_CUES=1");
    const habit = cueHabits((this.o.transfer ?? (() => this.o.hub.transfer()))())[0];
    if (!habit) return this.err(409, "no_practised_habit", "no practised habit to cue yet: a cue only names a drilled habit you have practised (never the one you don't practise)");
    const now = this.now();
    const inMinutes = (b.inMinutes as number | undefined) ?? 0;
    const target = inMinutes > 0 ? now + Math.round(inMinutes * 60_000) : null;
    const tz = this.o.hub.tz;
    const q = DEFAULT_POLICY.quietHours;
    if (inQuietHours(target ?? now, q, tz)) return this.err(409, "quiet_hours", `quiet hours (${String(q.startHour).padStart(2, "0")}:00 to ${String(q.endHour).padStart(2, "0")}:00): no cues`);
    // A send for this habit already in flight: wait for its outcome. A failed send is that outcome
    // (deduped: false, never "already set"); a cue that went out is checked below like any other.
    for (let flying = this.inFlight.get(habit); flying; flying = this.inFlight.get(habit)) {
      const r = await flying;
      if (!sent(r)) return this.ok(r, false);
    }
    // The alarm this cue would get (the wrist lead when it is for now), against each earlier alarm.
    const alarm = target ?? this.now() + this.o.wrist.status().leadMs;
    const same = [...this.cues].reverse().find((c) => c.habit === habit && sent(c) && c.alarmAt != null && Math.abs(c.alarmAt - alarm) < (this.o.dedupeMs ?? CUE_DEDUPE_MS));
    if (same) return this.ok(same, true);
    const today = localDate(now, tz);
    const cap = this.o.capPerDay ?? CUE_CAP_PER_DAY;
    if (this.cues.filter((c) => c.day === today && sent(c)).length >= cap) return this.err(429, "cue_cap", `${cap} cues today already (the cap is ${cap} a day)`);
    if (this.o.wrist.circuitOpenUntil() != null) return this.err(503, "wrist_down", "the wrist channel failed 3 times in a row; it is retried later");
    const by = (b.by as string | undefined) ?? "http";
    const id = `cue_${now.toString(36)}${(n++ % 1296).toString(36).padStart(2, "0")}`;
    const text = CUE_TEXT[habit];
    const p = this.o.wrist.send({ kind: "cue", refId: id, text: maskOut(text, "screen"), alarmAt: target ?? undefined }).then((w): CueRecord => {
      const r: CueRecord = { id, habit, text, alarmAt: w.alarmAt, by, at: now, day: today, wrist: { channel: w.channel, status: w.status, todoId: w.todoId, error: w.error } };
      this.cues.push(r);
      this.save();
      this.log("live.cue", { id, habit, status: w.status, todoId: w.todoId, by });
      return r;
    }).finally(() => this.inFlight.delete(habit)); // gone before anyone waiting on it resumes
    this.inFlight.set(habit, p);
    return this.ok(await p, false);
  }

  describe(): string {
    return this.o.enabled ? "on" : "off";
  }
}
