// Conversation settings: was a Bee conversation a meeting, work talk or a casual chat? The coach
// uses the answer to compare like with like (a recap against the wearer's usual for that setting,
// and a secondary per-setting view next to the transfer check). The pre-registered transfer check
// (stats.ts `transfer`, GET /api/transfer) never reads any of this.
//
// Automatic tag: deterministic, no model, no other speaker's words. In this order:
//   1. meeting   a meeting-captions session (kind "meeting"); a Bee conversation that a captions
//                session matches by time (src/real/instruments.ts pairMeetings); or one that overlaps
//                a calendar event the hub has seen (start and end times only, never the title)
//   2. work      a weekday, inside the work hours (COACH_WORK_HOURS, default 09:00-18:00, in the
//                hub's time zone), with 2 to 4 distinct speakers (a count from the session's counts)
//   3. casual    everything else. When it is casual only because the speaker count is missing (or
//                outside 2-4) on a weekday in work hours, the tag says confidence "low".
// The wearer's choice (POST /api/sessions/<id>/setting) wins over every rule. It is kept in
// <stateDir>/live/settings.json (real/live/ in live mode, gitignored): ids, a setting and times.
import { join } from "node:path";
import { localDate } from "../real/deck.js";
import { pairMeetings } from "../real/instruments.js";
import { wordCount } from "../real/text.js";
import { readJsonSafe, writeJsonAtomic } from "./atomic.js";
import type { CalendarFn } from "./brief.js";
import { CONVERSATION_SETTINGS, SETTING_NAME, type ConversationSetting, type SettingBeforeAfter, type SettingRates, type SettingReason, type SettingsResponse, type SettingTag } from "./contract.js";
import type { CoachHub } from "./core.js";
import { habitTitle } from "./habitNames.js";
import { fromSource, habitRates, period, type SourceSel, type StatSession } from "./stats.js";

export { CONVERSATION_SETTINGS, SETTING_NAME };
export type { ConversationSetting, SettingTag };

// The setting inside a sentence: "against your usual 1.6 in meetings".
export const SETTING_WHERE: Record<ConversationSetting, string> = { meeting: "in meetings", work: "at work", casual: "in casual talk" };
// The setting as a noun phrase: "Your last conversation, a meeting, ran high on ...".
export const SETTING_NOUN: Record<ConversationSetting, string> = { meeting: "a meeting", work: "at work", casual: "a casual chat" };
// The words a setting needs before its rates are shown or used as a recap's usual (the baseline's minimum).
export const SETTING_MIN_WORDS = 400;
export const SETTINGS_FILE = join("live", "settings.json");
export const SETTINGS_NOTE = "a secondary view: the setting of each conversation, so like is compared with like; the pre-registered before and after (GET /api/transfer) does not use it";

// A calendar event's time only. Without an end, an event is taken to last CALENDAR_DEFAULT_MS.
export interface CalendarSpan {
  startsAt: number;
  endsAt?: number;
}
export const CALENDAR_DEFAULT_MS = 30 * 60_000;
export const CALENDAR_EARLY_MS = 10 * 60_000; // a conversation that starts this soon before an event belongs to it

export interface WorkHours {
  startMin: number; // minutes after local midnight
  endMin: number;
  days: number[]; // 0 = Sunday
}
export const DEFAULT_WORK_HOURS: WorkHours = { startMin: 9 * 60, endMin: 18 * 60, days: [1, 2, 3, 4, 5] };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// "09:00-18:00" -> minutes; anything else -> the default.
export function parseWorkHours(s: string | undefined | null): WorkHours {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(s ?? "");
  if (!m) return DEFAULT_WORK_HOURS;
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  if (!(a >= 0 && b <= 24 * 60 && a < b)) return DEFAULT_WORK_HOURS;
  return { ...DEFAULT_WORK_HOURS, startMin: a, endMin: b };
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
// The local weekday and minutes after midnight in `tz` (the system zone when undefined).
export function localClock(ms: number, tz?: string): { day: number; min: number } {
  const k = tz ?? "";
  let f = fmtCache.get(k);
  if (!f) fmtCache.set(k, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })));
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: WEEKDAY[p.weekday ?? "Mon"] ?? 1, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export interface TagInput {
  kind: "conversation" | "meeting" | "voice_note";
  startMs: number;
  endMs?: number | null; // known for a live conversation; a stats session has only its start
  speakers?: number | null; // distinct speakers, the wearer included
  pairedWithCaptions?: boolean;
}

function overlapsCalendar(t: TagInput, events: CalendarSpan[]): boolean {
  return events.some((e) => {
    const from = e.startsAt - CALENDAR_EARLY_MS;
    const to = e.endsAt ?? e.startsAt + CALENDAR_DEFAULT_MS;
    const end = t.endMs ?? t.startMs;
    return t.startMs < to && end >= from;
  });
}

/** The automatic setting of one conversation (pure). */
export function autoSetting(t: TagInput, o: { tz?: string; workHours?: WorkHours; calendar?: CalendarSpan[] } = {}): SettingTag {
  const wh = o.workHours ?? DEFAULT_WORK_HOURS;
  const meeting = (r: SettingReason): SettingTag => ({ setting: "meeting", source: "auto", confidence: "high", reasons: [r] });
  if (t.kind === "meeting") return meeting("captions");
  if (t.pairedWithCaptions) return meeting("paired-captions");
  if (o.calendar?.length && overlapsCalendar(t, o.calendar)) return meeting("calendar");
  const { day, min } = localClock(t.startMs, o.tz);
  if (!wh.days.includes(day)) return { setting: "casual", source: "auto", confidence: "high", reasons: ["weekend"] };
  if (min < wh.startMin || min >= wh.endMin) return { setting: "casual", source: "auto", confidence: "high", reasons: ["outside-work-hours"] };
  const n = t.speakers ?? null;
  if (n == null) return { setting: "casual", source: "auto", confidence: "low", reasons: ["speakers-unknown"] };
  if (n >= 2 && n <= 4) return { setting: "work", source: "auto", confidence: "high", reasons: ["work-hours", "speakers"] };
  return { setting: "casual", source: "auto", confidence: "low", reasons: ["speakers-out-of-range"] };
}

export const isSetting = (x: unknown): x is ConversationSetting => typeof x === "string" && (CONVERSATION_SETTINGS as readonly string[]).includes(x);
export const nextSetting = (s: ConversationSetting): ConversationSetting => CONVERSATION_SETTINGS[(CONVERSATION_SETTINGS.indexOf(s) + 1) % CONVERSATION_SETTINGS.length]!;

interface Override {
  setting: ConversationSetting;
  at: number;
  // A live conversation's span (a recap's startedAt/endedAt): the stats session Bee completes later
  // has a different id (Bee's numeric id, not the stream's uuid), so it is matched by its start time.
  startMs?: number;
  endMs?: number;
}
interface SettingsFile {
  note: string;
  overrides: Record<string, Override>;
}
const MATCH_SLACK_MS = 2 * 60_000;

export interface LiveConversation {
  conversationId: string;
  startedAt: number;
  endedAt: number;
  otherLines: number;
}

export interface SettingBaseline {
  setting: ConversationSetting;
  words: number;
  range: "week" | "all";
  hedgesPer100: number;
  likesPer100: number;
  fillersPer100: number;
  vaguePer100: number;
  restartsPer100: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

// Bee lines heard as drill attempts are not everyday speech: left out here as in the transfer.
function withoutDrillLines(hub: CoachHub, ss: StatSession[]): StatSession[] {
  const keys = new Set(hub.attempts.flatMap((a) => (a.bee?.utteranceIds ?? []).map((id) => `u:${id}`)));
  if (!keys.size) return ss;
  return ss.map((s) => (s.lines.some((l) => keys.has(l.key)) ? { ...s, lines: s.lines.filter((l) => !keys.has(l.key)) } : s));
}

/**
 * The wearer's settings: the automatic tags, the wearer's corrections (persisted), the calendar
 * times the hub has seen (memory only), per-setting baselines and the GET /api/settings report.
 */
export class SettingsBook {
  private file: SettingsFile = { note: "", overrides: {} };
  private calendar: CalendarSpan[] = [];
  private calendarAt = -Infinity;
  private version = 0;
  private cache: { sessions: StatSession[]; version: number; tags: Map<string, SettingTag> } | null = null;
  readonly workHours: WorkHours;
  private writeFailed = false;

  constructor(
    private o: {
      hub: CoachHub;
      stateDir: string | null; // persist under <stateDir>/live/settings.json (null: memory only)
      load?: boolean; // read the file at start (live mode; demo starts fresh, like its recaps)
      calendar?: CalendarFn | null;
      workHours?: WorkHours;
      log?: (event: string, data?: Record<string, unknown>) => void;
    },
  ) {
    this.workHours = o.workHours ?? parseWorkHours(process.env.COACH_WORK_HOURS);
    if (o.load && o.stateDir) {
      const f = readJsonSafe<Partial<SettingsFile>>(this.path!, () => ({}), (message) => o.log?.("settings.load.recovered", { message }));
      const ov = f && typeof f.overrides === "object" && f.overrides ? f.overrides : {};
      for (const [id, v] of Object.entries(ov)) if (v && isSetting(v.setting)) this.file.overrides[id] = v;
    }
  }

  get path(): string | null {
    return this.o.stateDir ? join(this.o.stateDir, SETTINGS_FILE) : null;
  }

  private bump() {
    this.version++;
    this.cache = null;
  }

  // Calendar times (never titles), merged with what the hub saw before. At most every 5 min; never throws.
  noteCalendar(events: CalendarSpan[]) {
    const seen = new Set(this.calendar.map((e) => `${e.startsAt}:${e.endsAt ?? ""}`));
    let added = 0;
    for (const e of events) {
      if (!Number.isFinite(e.startsAt)) continue;
      const k = `${e.startsAt}:${e.endsAt ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      this.calendar.push({ startsAt: e.startsAt, ...(e.endsAt != null && Number.isFinite(e.endsAt) ? { endsAt: e.endsAt } : {}) });
      added++;
    }
    if (this.calendar.length > 500) this.calendar = this.calendar.slice(-500);
    if (added) this.bump();
  }
  async refreshCalendar(force = false): Promise<void> {
    const fn = this.o.calendar;
    const now = this.o.hub.clock();
    if (!fn || (!force && now - this.calendarAt < 5 * 60_000)) return;
    this.calendarAt = now;
    try {
      const c = await fn();
      this.noteCalendar(c.events.map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt })));
    } catch {
      /* the calendar is one signal among several: without it the other rules still tag */
    }
  }
  calendarSpans(): CalendarSpan[] {
    return [...this.calendar];
  }

  private tagOpts() {
    return { tz: this.o.hub.tz, workHours: this.workHours, calendar: this.calendar };
  }

  private overrideFor(id: string, startMs: number, endMs?: number | null): Override | null {
    return this.overrideEntry(id, startMs, endMs)?.[1] ?? null;
  }
  private overrideEntry(id: string, startMs: number, endMs?: number | null): [string, Override] | null {
    const ov = this.file.overrides;
    if (ov[id]) return [id, ov[id]!];
    // A recap's conversation (uuid) and the stats session Bee completes later (numeric id) are the
    // same conversation: matched by time, both ways.
    const end = endMs ?? startMs;
    let best: [string, Override] | null = null;
    for (const [k, v] of Object.entries(ov)) {
      if (k === id) continue;
      let hit = false;
      if (v.startMs != null) hit = startMs >= v.startMs - MATCH_SLACK_MS && startMs <= (v.endMs ?? v.startMs) + MATCH_SLACK_MS;
      else {
        const s = this.o.hub.sessions.find((x) => x.id === k);
        hit = !!s && endMs != null && s.startMs >= startMs - MATCH_SLACK_MS && s.startMs <= end + MATCH_SLACK_MS;
      }
      if (hit && (!best || v.at > best[1].at)) best = [k, v];
    }
    return best;
  }

  private youTag(o: Override): SettingTag {
    return { setting: o.setting, source: "you", confidence: "high", reasons: ["you"] };
  }

  /** Every stats session's tag (cached until the sessions, the calendar or a correction change). */
  tags(): Map<string, SettingTag> {
    const ss = this.o.hub.sessions;
    if (this.cache && this.cache.sessions === ss && this.cache.version === this.version) return this.cache.tags;
    // Every Bee conversation that overlaps a captioned meeting, paired or skipped for too few lines.
    const mp = pairMeetings(ss);
    const paired = new Set([...mp.pairs, ...mp.skipped].flatMap((p) => p.bee));
    const tags = new Map<string, SettingTag>();
    for (const s of ss) {
      const o = this.overrideFor(s.id, s.startMs);
      tags.set(s.id, o ? this.youTag(o) : autoSetting({ kind: s.kind, startMs: s.startMs, speakers: s.speakers, pairedWithCaptions: paired.has(s.id) }, this.tagOpts()));
    }
    this.cache = { sessions: ss, version: this.version, tags };
    return tags;
  }

  tagSession(id: string): SettingTag | null {
    return this.tags().get(id) ?? null;
  }

  // The automatic tag of a live conversation (before Bee completes it): speakers are the wearer plus
  // "someone else" when any line was not the wearer's (counts only).
  autoForConversation(c: LiveConversation): SettingTag {
    return autoSetting({ kind: "conversation", startMs: c.startedAt, endMs: c.endedAt, speakers: c.otherLines > 0 ? 2 : 1 }, this.tagOpts());
  }
  tagConversation(c: LiveConversation): SettingTag {
    const o = this.overrideFor(c.conversationId, c.startedAt, c.endedAt);
    return o ? this.youTag(o) : this.autoForConversation(c);
  }

  /** A recap's setting now: the wearer's choice when there is one, else the tag it was made with. */
  tagRecap(r: { conversationId: string; startedAt: number; endedAt: number; setting?: SettingTag | null }): SettingTag | null {
    const o = this.overrideFor(r.conversationId, r.startedAt, r.endedAt);
    return o ? this.youTag(o) : (r.setting ?? null);
  }

  /** The wearer's choice for one conversation (null clears it). `span` is a live conversation's start and end. */
  set(id: string, setting: ConversationSetting | null, span?: { startMs: number; endMs: number }): void {
    const startMs = span?.startMs ?? this.o.hub.sessions.find((s) => s.id === id)?.startMs;
    // A choice made for the same conversation under its other id (matched by time) is replaced too.
    for (let i = 0; i < 50 && startMs != null; i++) {
      const e = this.overrideEntry(id, startMs, span?.endMs);
      if (!e) break;
      delete this.file.overrides[e[0]];
    }
    delete this.file.overrides[id];
    if (setting != null) this.file.overrides[id] = { setting, at: this.o.hub.clock(), ...(span ? { startMs: span.startMs, endMs: span.endMs } : {}) };
    this.bump();
    this.save();
  }

  private save() {
    const p = this.path;
    if (!p) return;
    try {
      writeJsonAtomic(p, { note: "the wearer's own setting for a conversation (ids, a setting and times; no words)", overrides: this.file.overrides } satisfies SettingsFile);
      this.writeFailed = false;
    } catch (err) {
      if (!this.writeFailed) this.o.log?.("settings.persist-error", { error: (err as Error)?.name ?? "Error" });
      this.writeFailed = true;
    }
  }

  private sessionsOf(setting: ConversationSetting, source: SourceSel): StatSession[] {
    const tags = this.tags();
    return withoutDrillLines(
      this.o.hub,
      fromSource(this.o.hub.sessions, source).filter((s) => tags.get(s.id)?.setting === setting),
    );
  }

  /** The wearer's usual rates in one setting (Bee conversations; this week, else all), or null with too little speech. */
  baselineFor(setting: ConversationSetting): SettingBaseline | null {
    const all = this.sessionsOf(setting, "bee");
    const today = localDate(this.o.hub.clock(), this.o.hub.tz);
    const from = new Date(`${today}T12:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 6);
    const weekFrom = from.toISOString().slice(0, 10);
    const week = all.filter((s) => {
      const d = localDate(s.startMs, this.o.hub.tz);
      return d >= weekFrom && d <= today;
    });
    for (const [range, ss] of [["week", week], ["all", all]] as const) {
      const h = habitRates(ss);
      if (h.words < SETTING_MIN_WORDS) continue;
      return { setting, words: h.words, range, hedgesPer100: h.hedges.per100, likesPer100: h.words ? r2(((h.fillers.breakdown.like ?? 0) / h.words) * 100) : 0, fillersPer100: h.fillers.per100, vaguePer100: h.vague.per100, restartsPer100: h.restarts.per100 };
    }
    return null;
  }

  /** GET /api/settings: per-setting rates and, for each practised habit, before and after its first practice in each setting. */
  report(source: SourceSel = "bee"): SettingsResponse {
    const hub = this.o.hub;
    const tz = hub.tz;
    const tags = this.tags();
    const t = hub.transfer(source);
    const minWords = t?.minWordsPerPeriod ?? SETTING_MIN_WORDS;
    const inSrc = fromSource(hub.sessions, source);
    const present = CONVERSATION_SETTINGS.filter((st) => inSrc.some((s) => tags.get(s.id)?.setting === st));
    const rates: SettingRates[] = present.map((setting) => {
      const ss = this.sessionsOf(setting, source);
      const h = habitRates(ss);
      const enough = h.words >= minWords;
      const v = (x: number) => (enough ? x : null);
      return {
        setting,
        name: SETTING_NAME[setting],
        sessions: ss.length,
        words: h.words,
        enough,
        per100: { hedges: v(h.hedges.per100), "filler:like": v(h.words ? r2(((h.fillers.breakdown.like ?? 0) / h.words) * 100) : 0), vague: v(h.vague.per100), restart: v(h.restarts.per100) },
      };
    });
    const practised = (t?.habits ?? [])
      .filter((x) => x.role === "drilled")
      .map((x) => {
        const cut = x.cutoverAt;
        const bySetting: SettingBeforeAfter[] =
          cut == null
            ? []
            : present.map((setting) => {
                const ss = this.sessionsOf(setting, source);
                const side = (part: StatSession[]) => {
                  const p = period(part, x.habit, tz);
                  return { sessions: p.sessions, words: p.words, count: p.count, per100: p.per100 };
                };
                const before = side(ss.filter((s) => s.startMs < cut));
                const after = side(ss.filter((s) => s.startMs >= cut));
                const enough = before.words >= minWords && after.words >= minWords;
                return { setting, name: SETTING_NAME[setting], before, after, enough, deltaPer100: enough ? r2(after.per100 - before.per100) : null };
              });
        return { habit: x.habit, label: x.label, cutoverAt: cut, bySetting };
      });
    // One line for the TV: the first practised habit with a setting that has enough speech on both sides.
    const lead = practised.find((p) => p.bySetting.some((b) => b.enough));
    const line = lead
      ? `By setting · ${habitTitle(lead.habit)}: ${lead.bySetting.map((b) => (b.enough ? `${b.name.toLowerCase()} ${f1(b.before.per100)} → ${f1(b.after.per100)}` : `${b.name.toLowerCase()}: too little speech`)).join(" · ")}`
      : null;
    return {
      dataLabel: hub.dataLabel,
      synthetic: hub.mode === "demo",
      generatedAt: new Date(hub.clock()).toISOString(),
      source,
      note: SETTINGS_NOTE,
      minWords,
      workHours: { start: hhmm(this.workHours.startMin), end: hhmm(this.workHours.endMin), days: this.workHours.days.join(",") === "1,2,3,4,5" ? "Mon-Fri" : this.workHours.days.join(","), tz: tz ?? null },
      sessions: inSrc.map((s) => ({ id: s.id, kind: s.kind, date: localDate(s.startMs, tz), startMs: s.startMs, words: s.lines.filter((l) => !l.uncertain && l.dom === "en").reduce((n, l) => n + wordCount(l.text), 0), tag: tags.get(s.id)! })),
      rates,
      practised,
      line,
    };
  }
}
