// Instrument check: the same meeting heard by two transcribers (Bee and the meeting's captions).
// A caption session is paired with the Bee speech that overlaps it in time, and both sides are
// counted with the hub's own habit rules (countHabitKey), so a difference is the transcriber, not
// the speaker. Aggregates only leave through the callers: no line text is printed or served.
//
// Pairing (pairMeetings):
//   overlap        the meeting's window is [start, end] (end from the caption timeline: its duration,
//                  its last caption line, or the last line's time). A Bee conversation pairs when its
//                  own [start, end] (Bee's end time, else its last line's spoken_at) overlaps that
//                  window. Several Bee conversations can cover one meeting (Bee may split it), and
//                  Bee lines with a spoken_at are clipped to the window, so talk before or after the
//                  meeting in the same recording is left out. Bee lines without a time count only
//                  when the whole conversation lies inside the window.
//   nearest-start  a weaker fallback, used only when a side has no end time, so the overlap cannot be
//                  checked: the Bee conversation that starts nearest the meeting, within 45 minutes,
//                  and not ruled out by the times that are known. Marked as such in every output.
// A Bee line counts toward at most one meeting, and a meeting is skipped (with its reason) when
// either side has fewer than PAIR_MIN_LINES English wearer lines.
import { countHabitKey } from "../hub/habits.js";
import type { Rate, StatLine, StatSession } from "../hub/stats.js";
import { rateCi95 } from "./talk.js";
import { countedLines, wordCount } from "./text.js";

export const PAIR_FALLBACK_WINDOW_MS = 45 * 60_000;
export const PAIR_SLACK_MS = 60_000; // the watch's clock and the meeting's clock differ a little
export const PAIR_MIN_LINES = 1;

export type PairMatch = "overlap" | "nearest-start";
export interface MeetingPair {
  meeting: string;
  bee: string[]; // the Bee conversation ids whose lines are compared
  match: PairMatch;
  window: { startMs: number; endMs: number | null }; // the meeting's span (end null when unknown)
  // Counted lines only (English, not "maybe not the wearer"). In memory only: never print or serve.
  captionLines: StatLine[];
  beeLines: StatLine[];
}
export type SkipReason = "no-start-time" | "not-heard-by-bee" | "no-caption-lines" | "no-bee-lines";
export interface SkippedMeeting {
  meeting: string;
  reason: SkipReason;
  bee: string[]; // Bee conversations that overlap it in time, even when it was skipped
}
export interface MeetingPairs {
  pairs: MeetingPair[];
  skipped: SkippedMeeting[];
}

interface Span {
  startMs: number;
  endMs: number | null;
}
type Known = Span & { endMs: number };

function meetingSpan(m: StatSession): Span {
  const ends: number[] = [];
  const d = m.timeline?.durationMin;
  if (d) ends.push(m.startMs + d * 60_000);
  const lastStep = m.timeline?.steps.at(-1);
  if (lastStep) ends.push(m.startMs + lastStep.sec * 1000);
  for (const l of m.lines) if (l.spokenAt != null) ends.push(l.spokenAt);
  return { startMs: m.startMs, endMs: ends.length ? Math.max(m.startMs, ...ends) : null };
}

function beeSpan(b: StatSession): Span {
  const ends: number[] = [];
  if (b.endMs != null) ends.push(b.endMs);
  for (const l of b.lines) if (l.spokenAt != null) ends.push(l.spokenAt);
  return { startMs: b.startMs, endMs: ends.length ? Math.max(b.startMs, ...ends) : null };
}

const known = (s: Span): s is Known => s.endMs != null;
const overlaps = (a: Known, b: Known) => a.startMs <= b.endMs + PAIR_SLACK_MS && a.endMs >= b.startMs - PAIR_SLACK_MS;

/** The Bee lines of `b` that fall inside the meeting window `w`. */
function clip(b: StatSession, bs: Known, w: Known): StatLine[] {
  const from = w.startMs - PAIR_SLACK_MS;
  const to = w.endMs + PAIR_SLACK_MS;
  const inside = bs.startMs >= from && bs.endMs <= to;
  return b.lines.filter((l) => (l.spokenAt != null ? l.spokenAt >= from && l.spokenAt <= to : inside));
}

/** Pair every caption session with the Bee speech of the same meeting (see the header). */
export function pairMeetings(sessions: StatSession[], o: { fallbackWindowMs?: number; minLines?: number } = {}): MeetingPairs {
  const windowMs = o.fallbackWindowMs ?? PAIR_FALLBACK_WINDOW_MS;
  const minLines = o.minLines ?? PAIR_MIN_LINES;
  const bee = sessions.filter((s) => s.kind === "conversation").map((b) => ({ b, span: beeSpan(b) }));
  const meetings = sessions.filter((s) => s.kind === "meeting").sort((a, b) => a.startMs - b.startMs);
  const claimed = new Set<string>(); // Bee line keys already compared with a meeting
  const usedWhole = new Set<string>(); // Bee conversations taken whole by the fallback
  const pairs: MeetingPair[] = [];
  const skipped: SkippedMeeting[] = [];
  for (const m of meetings) {
    if (!m.startMs) {
      skipped.push({ meeting: m.id, reason: "no-start-time", bee: [] });
      continue;
    }
    const ms = meetingSpan(m);
    const captionLines = countedLines(m.lines);
    let match: PairMatch = "overlap";
    let parts: { id: string; lines: StatLine[] }[] = [];
    if (known(ms)) {
      for (const { b, span } of bee) {
        if (!known(span) || usedWhole.has(b.id) || !overlaps(span, ms)) continue;
        parts.push({ id: b.id, lines: clip(b, span, ms).filter((l) => !claimed.has(l.key)) });
      }
    }
    if (!parts.length) {
      // Weaker: reached only when a side's end time is missing (with both known, the two time checks
      // below are the overlap test above, which already failed).
      const near = bee
        .filter(({ b, span }) => {
          if (usedWhole.has(b.id) || b.lines.some((l) => claimed.has(l.key))) return false;
          if (Math.abs(b.startMs - m.startMs) > windowMs) return false;
          if (known(span) && span.endMs < m.startMs - PAIR_SLACK_MS) return false; // Bee ended before the meeting
          if (known(ms) && b.startMs > ms.endMs + PAIR_SLACK_MS) return false; // Bee started after it ended
          return true;
        })
        .sort((x, y) => Math.abs(x.b.startMs - m.startMs) - Math.abs(y.b.startMs - m.startMs))[0];
      if (near) {
        match = "nearest-start";
        parts = [{ id: near.b.id, lines: near.b.lines.filter((l) => !claimed.has(l.key)) }];
      }
    }
    if (!parts.length) {
      skipped.push({ meeting: m.id, reason: "not-heard-by-bee", bee: [] });
      continue;
    }
    const ids = parts.map((p) => p.id);
    const beeLines = countedLines(parts.flatMap((p) => p.lines));
    if (captionLines.length < minLines || beeLines.length < minLines) {
      skipped.push({ meeting: m.id, reason: captionLines.length < minLines ? "no-caption-lines" : "no-bee-lines", bee: ids });
      continue;
    }
    for (const p of parts) for (const l of p.lines) claimed.add(l.key);
    if (match === "nearest-start") usedWhole.add(ids[0]!);
    pairs.push({ meeting: m.id, bee: parts.filter((p) => countedLines(p.lines).length).map((p) => p.id), match, window: { startMs: ms.startMs, endMs: ms.endMs }, captionLines, beeLines });
  }
  return { pairs, skipped };
}

// One speech, two transcripts: with source=all a paired meeting must count once. Bee stays the
// instrument of record (its caption session is left out) only when Bee heard most of the meeting:
// Bee's wearer words are at least BEE_COVERS_WORDS of the captions' words, or Bee's lines span at
// least BEE_COVERS_SPAN of the meeting's window. Otherwise (the watch stopped two minutes in) the
// captions are kept and the Bee lines inside the meeting are left out instead.
export const BEE_COVERS_WORDS = 0.5;
export const BEE_COVERS_SPAN = 0.7;
export interface MeetingDedup {
  captions: Set<string>; // caption session ids to leave out
  beeLines: Set<string>; // Bee line keys to leave out (inside a meeting whose captions are kept)
}
export function beeCoversMeeting(p: Pick<MeetingPair, "window" | "captionLines" | "beeLines">): boolean {
  const words = (ls: StatLine[]) => ls.reduce((n, l) => n + wordCount(l.text), 0);
  const cap = words(p.captionLines);
  if (cap === 0 || words(p.beeLines) >= BEE_COVERS_WORDS * cap) return true;
  const { startMs, endMs } = p.window;
  const timed = p.beeLines.filter((l) => l.spokenAt != null);
  if (endMs == null || endMs <= startMs || !timed.length) return false;
  const from = Math.min(...timed.map((l) => l.spokenAt!));
  const to = Math.max(...timed.map((l) => l.spokenEndAt ?? l.spokenAt!));
  return (Math.min(to, endMs) - Math.max(from, startMs)) / (endMs - startMs) >= BEE_COVERS_SPAN;
}
export function meetingDedup(sessions: StatSession[], pairs: MeetingPair[] = pairMeetings(sessions).pairs): MeetingDedup {
  const out: MeetingDedup = { captions: new Set(), beeLines: new Set() };
  for (const p of pairs) {
    if (beeCoversMeeting(p)) out.captions.add(p.meeting);
    else for (const l of p.beeLines) out.beeLines.add(l.key);
  }
  return out;
}

// The habits the two transcribers are compared on: the pre-registered ones (practised: unsure words
// and filler "like"; not practised: starting over), and the filler words a caption engine may clean
// up. "um-uh" is "um" and "uh" together.
export const TRANSCRIBER_HABITS = ["hedges", "filler:like", "restart", "um-uh", "filler:you know", "fillers"] as const;
export type TranscriberHabit = (typeof TRANSCRIBER_HABITS)[number];

/** Count one comparison habit in a text with the hub's habit rules. */
export function countTranscriberHabit(key: string, text: string): number {
  return key === "um-uh" ? countHabitKey("filler:um", text) + countHabitKey("filler:uh", text) : countHabitKey(key, text);
}

export interface TranscriberRates {
  lines: number;
  words: number;
  habits: Record<TranscriberHabit, Rate>; // per 100 of the wearer's English words, with a 95% interval
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** One transcriber's rates over counted lines (pass a pair's captionLines or beeLines). */
export function transcriberRates(lines: Pick<StatLine, "text">[]): TranscriberRates {
  const texts = lines.map((l) => l.text);
  const words = texts.reduce((n, t) => n + wordCount(t), 0);
  const habits = {} as Record<TranscriberHabit, Rate>;
  for (const k of TRANSCRIBER_HABITS) {
    const count = texts.reduce((n, t) => n + countTranscriberHabit(k, t), 0);
    habits[k] = { count, per100: words ? r2((count / words) * 100) : 0, ci95: rateCi95(count, words) };
  }
  return { lines: lines.length, words, habits };
}

// The script's report (scripts/instrument-check.ts): ids, counts and rates only, never line text.
export interface InstrumentCheckPair {
  meeting: string;
  bee: string[];
  match: PairMatch;
  captions: TranscriberRates;
  beeRates: TranscriberRates;
}
export interface InstrumentCheck {
  pairs: InstrumentCheckPair[];
  skipped: SkippedMeeting[];
}

export function instrumentCheck(sessions: StatSession[]): InstrumentCheck {
  const { pairs, skipped } = pairMeetings(sessions);
  return {
    pairs: pairs.map((p) => ({ meeting: p.meeting, bee: p.bee, match: p.match, captions: transcriberRates(p.captionLines), beeRates: transcriberRates(p.beeLines) })),
    skipped,
  };
}

const SKIP_TEXT: Record<SkipReason, string> = {
  "no-start-time": "skipped: the captions have no start time",
  "not-heard-by-bee": "not compared: no Bee conversation at the same time",
  "no-caption-lines": "skipped: the captions have no English lines of yours (check the --wearer spelling given to npm run meetings)",
  "no-bee-lines": "skipped: Bee has no English lines of yours inside the meeting's time",
};

/** The table the script prints. `title` gives a habit key's display name (habitNames.ts habitTitle). */
export function instrumentCheckLines(r: InstrumentCheck, title: (key: string) => string): string[] {
  const out: string[] = [];
  const label = (k: TranscriberHabit) => (k === "um-uh" ? '"um" / "uh"' : k === "filler:you know" ? '"you know"' : title(k));
  const cell = (x: Rate) => `${String(x.count).padStart(4)}  ${x.per100.toFixed(2).padStart(6)} (${x.ci95[0].toFixed(2)}-${x.ci95[1].toFixed(2)})`;
  for (const p of r.pairs) {
    out.push("", `${p.meeting} (captions) vs Bee ${p.bee.length > 1 ? "conversations" : "conversation"} ${p.bee.join(", ")}`);
    out.push(p.match === "overlap" ? "  matched by time: Bee's lines cut to the meeting's start and end" : "  matched by start time only (weaker): an end time is missing, so the overlap was not checked");
    out.push(`  ${"".padEnd(18)} ${"captions: count, per 100 (95% interval)".padEnd(36)}   Bee: count, per 100 (95% interval)`);
    out.push(`  ${"your words".padEnd(18)} ${String(p.captions.words).padStart(4)}${"".padEnd(32)}   ${String(p.beeRates.words).padStart(4)}`);
    for (const k of TRANSCRIBER_HABITS) out.push(`  ${label(k).padEnd(18)} ${cell(p.captions.habits[k]).padEnd(36)}   ${cell(p.beeRates.habits[k])}`);
  }
  if (r.pairs.length) out.push("", "Intervals that overlap mean this data cannot tell the two transcribers apart on that habit.");
  else out.push("No captioned meeting overlaps a Bee conversation in time with English lines of yours on both sides.");
  for (const s of r.skipped) out.push(`${s.meeting}: ${SKIP_TEXT[s.reason]}`);
  return out;
}
