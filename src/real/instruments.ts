// Instrument check: the same meeting heard by two transcribers (Bee and the meeting's captions).
// Pairs a caption session with the Bee conversation that overlaps it in time and counts both
// with the same habit rules, so a difference is the transcriber, not the speaker. Aggregates
// only: no line text leaves this module.
import type { StatSession } from "../hub/stats.js";
import { FILLER_RE, HEDGE_RE, wordCount } from "./text.js";

export interface HabitRates {
  lines: number;
  words: number;
  // per 100 of the wearer's English words
  fillers: number;
  umUh: number;
  like: number;
  youKnow: number;
  unsure: number;
}

export interface InstrumentPair {
  meeting: string;
  bee: string;
  captions: HabitRates;
  beeRates: HabitRates;
}

const count = (lines: string[], re: RegExp, keep: (m: string) => boolean = () => true) =>
  lines.reduce((n, t) => n + [...t.matchAll(new RegExp(re.source, "gi"))].filter((m) => keep(m[0])).length, 0);

export function habitRates(lines: string[]): HabitRates {
  const words = lines.reduce((n, t) => n + wordCount(t), 0);
  const per100 = (n: number) => (words ? Math.round((n / words) * 10000) / 100 : 0);
  return {
    lines: lines.length,
    words,
    fillers: per100(count(lines, FILLER_RE.en)),
    umUh: per100(count(lines, FILLER_RE.en, (m) => /^(um+|uh+)$/i.test(m))),
    like: per100(count(lines, FILLER_RE.en, (m) => /^like$/i.test(m))),
    youKnow: per100(count(lines, FILLER_RE.en, (m) => /you know/i.test(m))),
    unsure: per100(count(lines, HEDGE_RE.en)),
  };
}

const english = (s: StatSession) => s.lines.filter((l) => !l.uncertain && l.dom === "en").map((l) => l.text);

/** Each caption session paired with the Bee conversation that starts closest to it, within windowMs. */
export function pairMeetings(sessions: StatSession[], windowMs = 45 * 60_000): InstrumentPair[] {
  const bee = sessions.filter((s) => s.kind === "conversation");
  const pairs: InstrumentPair[] = [];
  for (const m of sessions.filter((s) => s.kind === "meeting")) {
    const near = bee
      .map((b) => ({ b, gap: Math.abs(b.startMs - m.startMs) }))
      .filter((x) => x.gap <= windowMs && english(x.b).length)
      .sort((x, y) => x.gap - y.gap)[0];
    if (near) pairs.push({ meeting: m.id, bee: near.b.id, captions: habitRates(english(m)), beeRates: habitRates(english(near.b)) });
  }
  return pairs;
}
