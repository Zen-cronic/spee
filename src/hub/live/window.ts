// ConversationWindow: the rolling state of one Bee conversation, rebuilt from its lines.
//
// Times. Each line has a conversation time (ct, ms from the start of Bee's recording, from the
// utterance's start/end) and hub-clock times (spoken, received, resolved). ct drives the metrics
// that describe speech (the 2-minute window, monologue, pauses, rate), so they are the same at any
// demo pace. The hub clock drives the policy (cooldowns, caps) and the latency hops.
//
// PRIVACY. Wearer lines keep their text in memory (habit counts and the recap moment need it);
// other speakers are counts only: a non-wearer line never carries text into this module.
import { splitSentences } from "../../analyze/segment.js";
import { dominantLang, HEDGE_RE, listRe } from "../../real/text.js";
import type { HabitCounts, LiveWindow, NudgeRule, RuleState } from "../contract.js";
import { LIVE_WINDOW_RECENT_MS } from "../contract.js";
import type { BeeLine } from "../bee.js";
import { countHabitKey, vagueMatches } from "../habits.js";

export const TURN_GAP_MS = 10_000; // a silence longer than this ends a monologue
export const PAUSE_MIN_MS = 1000; // a gap inside a wearer turn that counts as a pause
export const WPM_MIN_TALK_MS = 10_000; // rate needs at least this much timed wearer speech
const EST_WORDS_PER_S = 2.5; // duration estimate for a line without Bee timing

export interface WinLine {
  id: number;
  speaker: "wearer" | "other";
  words: number;
  durMs: number;
  ctStart: number;
  ctEnd: number;
  spokenAt: number; // hub ms (start)
  endAt: number; // hub ms: spokenAt + duration (scaled by the demo pace)
  receivedAt: number;
  beeAt: number; // the speaker was decided (wearer tag)
  timed: boolean; // Bee gave start/end
  // wearer only
  text?: string;
  lang?: "en" | "fr";
  drill?: boolean;
  counts?: HabitCounts;
}

export interface RuleEvidence extends RuleState {
  windowMs: number | null;
  expected: number | null;
  fresh: boolean; // not yet acted on (a rule fires once per streak or monologue)
}

export interface Thresholds {
  hedges: { streakMin: number; windowMs: number; expectedMultiplier: number };
  like: { streakMin: number; windowMs: number; expectedMultiplier: number };
  monologue: { nudgeMs: number };
  rate: { wpmFast: number };
}
export interface RateBaseline {
  hedgesPer100: number;
  likesPer100: number;
}

const zero = (): HabitCounts => ({ hedges: 0, likes: 0, fillers: 0, vague: 0, restarts: 0 });
const add = (a: HabitCounts, b: HabitCounts) => {
  a.hedges += b.hedges;
  a.likes += b.likes;
  a.fillers += b.fillers;
  a.vague += b.vague;
  a.restarts += b.restarts;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export function habitCounts(text: string): HabitCounts {
  return {
    hedges: listRe(text, HEDGE_RE.en).length,
    likes: countHabitKey("filler:like", text),
    fillers: countHabitKey("fillers", text),
    vague: vagueMatches(text).length,
    restarts: countHabitKey("restart", text),
  };
}

export interface Analysis {
  window: LiveWindow;
  evidence: RuleEvidence[];
  runStartCt: number | null; // the current monologue's start (ct), when the wearer holds the floor
  latestWearer: WinLine | null;
  englishWords: number;
  frenchWords: number;
  longestMonologueMs: number;
}

export class ConversationWindow {
  readonly lines = new Map<number, WinLine>();
  started = false; // conversation.started published (at the first counted wearer line)
  startedAt: number; // hub ms: Bee's start_time, else the first line
  lastActivityAt: number; // hub ms: the last line reached the hub
  readonly fired: Partial<Record<NudgeRule, number>> = {}; // ct of the line a rule last acted on
  firedMonologueRun: number | null = null;
  nudges = { sent: 0, skipped: 0 };
  skipped = { frenchLines: 0, drillLines: 0 };
  private ctOrigin: number | null = null;

  constructor(
    readonly conversationId: string,
    startedAt: number,
    readonly replay: boolean,
    private pace = 1,
  ) {
    this.startedAt = startedAt;
    this.lastActivityAt = startedAt;
  }

  // Add or replace a line (a late tag can turn an untagged line into a wearer line). Returns the
  // stored line, or null for a drill line (excluded from every metric).
  upsert(l: BeeLine): WinLine | null {
    this.lastActivityAt = Math.max(this.lastActivityAt, l.receivedAt);
    const prev = this.lines.get(l.utteranceId);
    if (prev?.drill) return null;
    const timed = l.startS != null && l.endS != null;
    const durMs = l.durMs ?? (l.words / EST_WORDS_PER_S) * 1000;
    if (this.ctOrigin == null) this.ctOrigin = l.spokenAt - (timed ? l.startS! * 1000 * this.pace : 0);
    const ctStart = timed ? l.startS! * 1000 : (l.spokenAt - this.ctOrigin) / this.pace;
    const base: WinLine = {
      id: l.utteranceId,
      speaker: l.speaker === "wearer" ? "wearer" : "other",
      words: l.words,
      durMs,
      ctStart,
      ctEnd: timed ? l.endS! * 1000 : ctStart + durMs,
      spokenAt: l.spokenAt,
      endAt: l.spokenAt + durMs * this.pace,
      receivedAt: l.receivedAt,
      beeAt: l.resolvedAt,
      timed,
    };
    if (l.speaker === "wearer" && l.text != null) {
      if (l.drill) {
        this.skipped.drillLines++;
        this.lines.delete(l.utteranceId);
        return null;
      }
      const lang = dominantLang(l.text, "en");
      if (lang === "fr" && prev?.lang !== "fr") this.skipped.frenchLines++;
      Object.assign(base, { text: l.text, lang, drill: false, counts: lang === "en" ? habitCounts(l.text) : zero() });
    }
    this.lines.set(l.utteranceId, base);
    return base;
  }

  wearerLines(): WinLine[] {
    return [...this.lines.values()].filter((x) => x.speaker === "wearer").sort((a, b) => a.ctStart - b.ctStart);
  }

  // Wearer sentences (the recap moment). Text stays in memory.
  wearerSentences(): { text: string; line: WinLine }[] {
    return this.wearerLines()
      .filter((l) => l.lang === "en" && l.text)
      .flatMap((l) => splitSentences(l.text!).map((text) => ({ text, line: l })));
  }

  analyze(now: number, th: Thresholds, baseline: RateBaseline | null, replay = this.replay): Analysis {
    const all = [...this.lines.values()].sort((a, b) => a.ctStart - b.ctStart || a.id - b.id);
    const wearer = all.filter((l) => l.speaker === "wearer");
    const others = all.filter((l) => l.speaker === "other");
    const en = wearer.filter((l) => l.lang === "en");
    const latestCt = all.reduce((m, l) => Math.max(m, l.ctEnd), -Infinity);
    const recentFrom = latestCt - LIVE_WINDOW_RECENT_MS;
    const totals = zero();
    const recent = zero();
    for (const l of en) {
      add(totals, l.counts!);
      if (l.ctEnd > recentFrom) add(recent, l.counts!);
    }
    const wearerWords = wearer.reduce((n, l) => n + l.words, 0);
    const otherWords = others.reduce((n, l) => n + l.words, 0);
    const englishWords = en.reduce((n, l) => n + l.words, 0);
    const rate = (ls: WinLine[]) => {
      const timed = ls.filter((l) => l.timed && l.durMs >= 1000 && l.words >= 3);
      const ms = timed.reduce((n, l) => n + l.durMs, 0);
      return ms >= WPM_MIN_TALK_MS ? Math.round((timed.reduce((n, l) => n + l.words, 0) / ms) * 60_000) : null;
    };
    // Monologue runs and pauses inside them.
    let runStart: number | null = null;
    let runEnd = -Infinity;
    let longest = 0;
    let pauses = 0;
    let longestPause = 0;
    let current = 0;
    let currentRun: number | null = null;
    for (const l of all) {
      if (l.speaker === "other") {
        runStart = null;
        continue;
      }
      const gap = l.ctStart - runEnd;
      if (runStart == null || gap > TURN_GAP_MS) {
        runStart = l.ctStart;
        runEnd = l.ctEnd;
      } else {
        if (gap >= PAUSE_MIN_MS) (pauses++, (longestPause = Math.max(longestPause, gap)));
        runEnd = Math.max(runEnd, l.ctEnd);
      }
      longest = Math.max(longest, runEnd - runStart);
    }
    const last = all.reduce<WinLine | null>((m, l) => (!m || l.ctEnd >= m.ctEnd ? l : m), null);
    if (last?.speaker === "wearer" && runStart != null) (current = runEnd - runStart), (currentRun = runStart);

    const fresh = (rule: NudgeRule) => en.filter((l) => l.ctEnd > recentFrom && l.ctEnd > (this.fired[rule] ?? -Infinity));
    const streak = (rule: "hedge-streak" | "like-streak", key: "hedges" | "likes", t: Thresholds["hedges"], per100: number | null): RuleEvidence => {
      const ls = fresh(rule);
      const value = ls.reduce((n, l) => n + l.counts![key], 0);
      const words = ls.reduce((n, l) => n + l.words, 0);
      const expected = per100 == null ? null : r2((per100 / 100) * words);
      const threshold = r2(Math.max(t.streakMin, t.expectedMultiplier * (expected ?? 0)));
      return { rule, value, threshold, unit: "count", over: value >= threshold, windowMs: t.windowMs, expected, fresh: value > 0 };
    };
    const recentWpm = rate(fresh("fast-rate"));
    const evidence: RuleEvidence[] = [
      streak("hedge-streak", "hedges", th.hedges, baseline?.hedgesPer100 ?? null),
      streak("like-streak", "likes", th.like, baseline?.likesPer100 ?? null),
      { rule: "monologue", value: Math.round(current), threshold: th.monologue.nudgeMs, unit: "ms", over: current >= th.monologue.nudgeMs, windowMs: null, expected: null, fresh: currentRun != null && currentRun !== this.firedMonologueRun },
      { rule: "fast-rate", value: recentWpm ?? 0, threshold: th.rate.wpmFast, unit: "wpm", over: (recentWpm ?? 0) >= th.rate.wpmFast, windowMs: LIVE_WINDOW_RECENT_MS, expected: null, fresh: recentWpm != null },
    ];
    const frenchWords = wearer.filter((l) => l.lang === "fr").reduce((n, l) => n + l.words, 0);
    const langShare = wearerWords ? frenchWords / wearerWords : 0;
    const window: LiveWindow = {
      conversationId: this.conversationId,
      startedAt: this.startedAt,
      updatedAt: now,
      replay,
      lang: langShare >= 0.8 ? "fr" : langShare <= 0.2 ? "en" : "mixed",
      wearer: { lines: wearer.length, words: wearerWords, talkMs: Math.round(wearer.reduce((n, l) => n + l.durMs, 0)), wpm: rate(en) },
      others: { lines: others.length, words: otherWords },
      talkShare: wearerWords + otherWords ? r2(wearerWords / (wearerWords + otherWords)) : null,
      monologue: { currentMs: Math.round(current), longestMs: Math.round(longest) },
      pauses: { count: pauses, longestMs: Math.round(longestPause) },
      recent: { windowMs: LIVE_WINDOW_RECENT_MS, ...recent },
      totals,
      skipped: { ...this.skipped },
      rules: evidence.map(({ rule, value, threshold, unit, over }) => ({ rule, value, threshold, unit, over })),
    };
    const latestWearer = wearer.reduce<WinLine | null>((m, l) => (!m || l.ctEnd >= m.ctEnd ? l : m), null);
    return { window, evidence, runStartCt: currentRun, latestWearer, englishWords, frenchWords, longestMonologueMs: Math.round(longest) };
  }

  // Mark a rule as acted on (sent or skipped), so it fires again only on a new streak or run.
  consume(rule: NudgeRule, a: Analysis) {
    if (rule === "monologue") this.firedMonologueRun = a.runStartCt;
    else this.fired[rule] = a.latestWearer?.ctEnd ?? Infinity;
  }
}
