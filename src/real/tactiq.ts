// Tactiq (Google Meet captions) transcript ingest. Turns a Tactiq .txt export into the same
// wearer-only corpus shape the Bee pipeline uses (kind "meeting"), plus a text-free timeline of
// every speaker's turns (speaking side, start second, word count) for talk-share metrics.
//
// PRIVACY CONTRACT. A meeting transcript holds coworkers' speech. Only the configured speaker's
// lines become WearerLines. Other speakers contribute counts only (lines, words, timings); their
// text, their names, the meeting title and the participant list are never placed in any returned
// object that is persisted. `parseTactiq` returns everything in memory for the caller to filter;
// `meetingCorpus` is the persistence boundary. test/tactiq.test.ts enforces this.
//
// Format (observed 2026-10): a "# <title>" line, an indented header ("Meeting started: 9/22/2026,
// 11:58:00 AM", "Duration: 46 minutes", "Participants: a, b"), a "## Highlights" section of
// "> mm:ss Name: text" lines that REPEAT (sometimes truncated) transcript lines, then
// "## Transcript" with one "mm:ss Name: text" line per caption chunk (about 45 s at most).
// Only start times are given.
import type { RealCorpus, SessionStats, WearerLine } from "./corpus.js";
import { dominantLang, lineLang, wordCount } from "./text.js";

export interface TactiqLine {
  idx: number; // position in the transcript, all speakers
  sec: number; // offset from the meeting start
  speaker: string;
  text: string;
}

export interface TactiqTranscript {
  title: string | null; // in memory only
  startedLocal: { y: number; mo: number; d: number; h: number; mi: number; s: number } | null;
  durationMin: number | null;
  participants: string[]; // in memory only
  lines: TactiqLine[];
  highlightLines: number; // timestamped lines in the Highlights section (skipped, never counted)
  source: "transcript-section" | "deduped-all";
}

const TS_LINE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+([^:\n]{1,100}?):(?:\s+(.*))?$/;

function parseTs(raw: string): Omit<TactiqLine, "idx"> | null {
  const m = raw.replace(/^\s*>?\s*/, "").trimEnd().match(TS_LINE);
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return { sec, speaker: m[4]!.trim(), text: (m[5] ?? "").trim() };
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function parseTactiq(raw: string): TactiqTranscript {
  const rows = raw.replace(/\r\n?/g, "\n").split("\n");
  const title = rows.find((r) => /^\s*#\s+\S/.test(r) && !/^\s*##/.test(r))?.replace(/^\s*#\s+/, "").trim() ?? null;
  const field = (name: string) => rows.map((r) => r.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "i"))?.[1]?.trim()).find(Boolean) ?? null;
  const started = field("Meeting started");
  const sm = started?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  let startedLocal: TactiqTranscript["startedLocal"] = null;
  if (sm) {
    let h = Number(sm[4]);
    const ap = sm[7]?.toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    startedLocal = { y: Number(sm[3]), mo: Number(sm[1]), d: Number(sm[2]), h, mi: Number(sm[5]), s: Number(sm[6] ?? 0) };
  }
  const dur = field("Duration")?.match(/(\d+)\s*min/i);
  const participants = (field("Participants") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Sections: everything after "## Transcript" is the transcript; "## Highlights" lines repeat it.
  const tIdx = rows.findIndex((r) => /^\s*##\s+Transcript\b/i.test(r));
  const hIdx = rows.findIndex((r) => /^\s*##\s+Highlights\b/i.test(r));
  const hEnd = hIdx >= 0 ? (() => { const n = rows.findIndex((r, i) => i > hIdx && /^\s*##\s/.test(r)); return n < 0 ? rows.length : n; })() : -1;
  const highlightLines = hIdx >= 0 ? rows.slice(hIdx + 1, hEnd).filter((r) => parseTs(r)).length : 0;

  const out: Omit<TactiqLine, "idx">[] = [];
  const body = tIdx >= 0 ? rows.slice(tIdx + 1) : rows;
  let inHeader = tIdx < 0; // without a Transcript section, skip header rows until the first timestamp
  for (const r of body) {
    const p = parseTs(r);
    if (p) {
      inHeader = false;
      out.push(p);
      continue;
    }
    const t = r.trim();
    if (!t || inHeader || /^#/.test(t) || /^\[.*\]\(.*\)$/.test(t)) continue;
    // A wrapped caption continues the previous line.
    if (out.length) out[out.length - 1]!.text = `${out[out.length - 1]!.text} ${t.replace(/^>\s*/, "")}`.trim();
  }

  let lines = out;
  if (tIdx < 0) {
    // No Transcript section: Highlights and transcript lines are interleaved in one list. Drop exact
    // repeats and same-speaker, same-second lines that are a prefix/substring of a longer one.
    const keep: typeof out = [];
    for (const l of out) {
      const dup = keep.findIndex((k) => k.speaker === l.speaker && k.sec === l.sec && (fold(k.text).includes(fold(l.text)) || fold(l.text).includes(fold(k.text))));
      if (dup < 0) keep.push(l);
      else if (l.text.length > keep[dup]!.text.length) keep[dup] = l;
    }
    lines = keep.sort((a, b) => a.sec - b.sec);
  }
  return { title, startedLocal, durationMin: dur ? Number(dur[1]) : null, participants, lines: lines.map((l, idx) => ({ idx, ...l })), highlightLines, source: tIdx >= 0 ? "transcript-section" : "deduped-all" };
}

// Wall-clock time in an IANA zone -> epoch ms (two-pass offset lookup; DST-safe away from the gap).
export function zonedToEpoch(t: NonNullable<TactiqTranscript["startedLocal"]>, tz: string): number {
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - ms;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

export const sameSpeaker = (a: string, b: string) => fold(a) === fold(b);

// One step of a meeting's turn sequence: which side spoke, when, how many words. No text, no name.
export interface TimelineStep {
  w: boolean; // the wearer spoke this caption line
  sec: number;
  words: number;
  key?: string; // wearer lines only: the WearerLine key
}

export interface MeetingTimeline {
  session: string;
  durationMin: number | null;
  speakers: number; // distinct speakers who said anything (count only)
  highlightLinesSkipped: number;
  steps: TimelineStep[];
}

export interface MeetingInput {
  transcript: TactiqTranscript;
  id?: string; // neutral id; defaults to meet-YYYY-MM-DD
}

export function meetingId(t: TactiqTranscript, fallback: string): string {
  const s = t.startedLocal;
  return s ? `meet-${s.y}-${String(s.mo).padStart(2, "0")}-${String(s.d).padStart(2, "0")}` : fallback;
}

// The persistence boundary: wearer lines + counts only.
export function meetingCorpus(inputs: MeetingInput[], opts: { wearer: string; tz?: string }): { corpus: RealCorpus; timelines: MeetingTimeline[]; warnings: string[] } {
  const tz = opts.tz ?? "America/Toronto";
  const sessions: SessionStats[] = [];
  const lines: WearerLine[] = [];
  const timelines: MeetingTimeline[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  let wearerTotal = 0,
    otherTotal = 0;
  inputs.forEach((inp, n) => {
    const t = inp.transcript;
    let id = inp.id ?? meetingId(t, `meet-${n + 1}`);
    for (let k = 2; used.has(id); k++) id = `${inp.id ?? meetingId(t, `meet-${n + 1}`)}-${k}`;
    used.add(id);
    const startMs = t.startedLocal ? zonedToEpoch(t.startedLocal, tz) : 0;
    const mine = t.lines.filter((l) => sameSpeaker(l.speaker, opts.wearer));
    if (!mine.length) warnings.push(`${id}: no lines from the configured speaker (check --wearer spelling).`);
    const steps: TimelineStep[] = [];
    t.lines.forEach((l, i) => {
      const w = sameSpeaker(l.speaker, opts.wearer);
      const key = `m:${id}:${l.idx}`;
      steps.push({ w, sec: l.sec, words: wordCount(l.text), ...(w ? { key } : {}) });
      if (!w) return;
      const next = t.lines[i + 1];
      lines.push({
        key,
        session: id,
        kind: "meeting",
        start: l.sec,
        end: next ? next.sec : null,
        spokenAt: startMs ? startMs + l.sec * 1000 : null,
        text: l.text,
        lang: lineLang(l.text),
        dom: dominantLang(l.text, "en"),
        // Meet captions attribute each line from the speaker's own audio stream, so the Bee
        // mislabel detector (media / assistant voices on one shared mic) does not apply.
        uncertain: false,
        mislabelScore: 0,
        reasons: [],
      });
    });
    wearerTotal += mine.length;
    otherTotal += t.lines.length - mine.length;
    timelines.push({ session: id, durationMin: t.durationMin, speakers: new Set(t.lines.filter((l) => l.text).map((l) => fold(l.speaker))).size, highlightLinesSkipped: t.highlightLines, steps });
    sessions.push({ id, kind: "meeting", state: "COMPLETED", startMs, totalLines: t.lines.length, wearerLines: mine.length, uncertainLines: 0, wearerShare: t.lines.length ? Math.round((mine.length / t.lines.length) * 1000) / 1000 : 0 });
  });
  sessions.sort((a, b) => a.startMs - b.startMs);
  timelines.sort((a, b) => sessions.findIndex((s) => s.id === a.session) - sessions.findIndex((s) => s.id === b.session));
  return {
    // Label counts are reduced to WEARER / OTHER: participant names are never persisted.
    corpus: { generatedAt: new Date().toISOString(), wearer: { labels: [opts.wearer], method: "cli-flag", counts: { WEARER: wearerTotal, OTHER: otherTotal } }, sessions, lines },
    timelines,
    warnings,
  };
}
