// Cheap, text-derivable talk habits for an English communication coach, computed from a meeting's
// text-free turn timeline (every speaker: side, start second, word count) plus the wearer's own
// lines. Other speakers contribute counts only.
//
// Caption caveats: punctuation is the captioner's guess and only start times exist, so question
// and sentence counts are approximate and every duration is an estimate (next line's start).
import { splitSentences } from "../analyze/segment.js";
import type { WearerLine } from "./corpus.js";
import type { MeetingTimeline } from "./tactiq.js";
import { FILLER_RE, countRe, listRe, repeats, tokens } from "./text.js";

// Vague tags and placeholder nouns ("and stuff", "or something", "stuff like that").
export const VAGUE_RE_EN = /\b(?:and stuff|or something(?: like that)?|or whatever|and everything|and all that|(?:stuff|things) like that|that kind of thing|stuff)\b/gi;
// "and yeah" / "so yeah" / "but yeah" used to wrap up or stall.
export const YEAH_TIC_RE = /\b(?:and|so|but),? yeah\b/gi;

const QUESTION_START = /^(?:what|what's|how|why|when|where|who|which|can|could|should|would|will|do|does|did|is|are|was|were|have|has|shall|may|isn't|aren't|don't|doesn't|didn't|won't|can't|any)\b/i;
const TAG_END = /\b(?:right|yeah|okay|ok|no|correct)\s*\?$/i;
const LEAD_IN = /^(?:(?:so|and|but|okay|ok|oh|yeah|um+|uh+|well|like)\b[\s,]*)+/i;
// A sentence that stops on one of these words was abandoned mid-phrase.
const DANGLING = new Set(["and", "but", "so", "or", "like", "the", "a", "an", "to", "of", "for", "with", "on", "in", "is", "as", "our", "my", "than", "versus", "because", "about", "which", "if", "into", "at", "from", "by", "we", "i", "are", "was"]);
// A turn that trails off on a tail word instead of a finished point.
const TAIL = new Set(["yeah", "yep", "yup", "so", "and"]);

export type SentenceKind = "question" | "tag" | "uptalk" | "trailing" | "statement";

export function sentenceKind(s: string): SentenceKind {
  const t = s.trim();
  const body = t.replace(LEAD_IN, "");
  const toks = tokens(t).filter((w) => !/^(?:um+|uh+)$/.test(w));
  if (/\?$/.test(t)) {
    if (QUESTION_START.test(body)) return "question";
    if (TAG_END.test(t) && toks.length > 1) return "tag";
    return toks.length && DANGLING.has(toks.at(-1)!) ? "trailing" : "uptalk";
  }
  if (toks.length >= 2 && DANGLING.has(toks.at(-1)!)) return "trailing";
  return "statement";
}

// The turn ends on a tail word ("..., and yeah.", "... so?") rather than on its point.
export function endsOnTail(turnText: string): boolean {
  const t = tokens(turnText).filter((w) => !/^(?:um+|uh+)$/.test(w));
  return t.length >= 2 && TAIL.has(t.at(-1)!);
}

export interface Turn {
  session: string;
  keys: string[];
  startSec: number;
  endSec: number | null; // start of the next other-speaker line (estimate)
  words: number;
  text: string; // wearer's own words (gitignored outputs only)
}

export function wearerTurns(timelines: MeetingTimeline[], lines: WearerLine[]): Turn[] {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const turns: Turn[] = [];
  for (const tl of timelines) {
    let cur: Turn | null = null;
    tl.steps.forEach((s, i) => {
      if (s.w && s.key) {
        if (!cur) cur = { session: tl.session, keys: [], startSec: s.sec, endSec: null, words: 0, text: "" };
        cur.keys.push(s.key);
        cur.words += s.words;
        cur.text = `${cur.text} ${byKey.get(s.key)?.text ?? ""}`.trim();
      }
      const next = tl.steps[i + 1];
      if (cur && (!next || !next.w)) {
        cur.endSec = next ? next.sec : null;
        turns.push(cur);
        cur = null;
      }
    });
  }
  return turns;
}

export interface TalkMetrics {
  meetings: number;
  totalWords: number;
  wearerWords: number;
  talkShareWords: number; // % of all spoken words
  talkShareTime: number | null; // % of estimated speaking time
  speakersMean: number; // mean distinct speakers per meeting
  turns: number;
  substantiveTurns: number; // >= 10 words
  backchannels: number; // <= 3 words ("Yeah, yeah.", "Okay.")
  avgTurnWords: number; // over substantive turns
  longestTurnWords: number;
  longestTurnSec: number | null;
  sentences: number;
  questions: number; // interrogative sentences ending in "?"
  tagQuestions: number; // "..., right?"
  uptalk: number; // "?" on a statement (captioner heard rising pitch)
  trailingOff: number; // sentence abandoned on a function word ("... the.", "... and?")
  tailEndings: number; // substantive turns ending on yeah / so / and
  yeahTics: number; // "and yeah" / "so yeah" anywhere
  vague: number;
  vagueBreakdown: Record<string, number>;
  restarts: number; // immediate repetitions / restarts ("the the", "I, I guess", "the, uh, the")
  fillers: number;
  per100: { questions: number; uptalk: number; trailingOff: number; yeahTics: number; vague: number; restarts: number; fillers: number };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function talkMetrics(timelines: MeetingTimeline[], lines: WearerLine[]): TalkMetrics {
  let totalWords = 0,
    wearerWords = 0,
    tAll = 0,
    tMine = 0;
  for (const tl of timelines) {
    tl.steps.forEach((s, i) => {
      totalWords += s.words;
      if (s.w) wearerWords += s.words;
      const next = tl.steps[i + 1];
      // Captions give start times only: a line lasts until the next one starts, capped at 60 s
      // (a chunk is at most about 45 s); the last line gets 2.5 words per second.
      const dur = Math.min(60, Math.max(0, next ? next.sec - s.sec : s.words / 2.5));
      tAll += dur;
      if (s.w) tMine += dur;
    });
  }
  const turns = wearerTurns(timelines, lines);
  const subst = turns.filter((t) => t.words >= 10);
  const longest = [...turns].sort((a, b) => b.words - a.words)[0];
  const kinds: Record<SentenceKind, number> = { question: 0, tag: 0, uptalk: 0, trailing: 0, statement: 0 };
  let sentences = 0,
    yeahTics = 0,
    restarts = 0,
    fillers = 0;
  const vb: Record<string, number> = {};
  for (const t of turns) {
    for (const s of splitSentences(t.text)) {
      sentences++;
      kinds[sentenceKind(s)]++;
    }
    yeahTics += countRe(t.text, YEAH_TIC_RE);
    restarts += repeats(t.text.replace(/\b(?:um+|uh+)\b/gi, " ")); // "the, uh, the" is a restart too
    fillers += countRe(t.text, FILLER_RE.en);
    for (const m of listRe(t.text, VAGUE_RE_EN)) vb[m] = (vb[m] ?? 0) + 1;
  }
  const vague = Object.values(vb).reduce((a, b) => a + b, 0);
  const per = (n: number) => (wearerWords ? r2((n / wearerWords) * 100) : 0);
  return {
    meetings: timelines.length,
    totalWords,
    wearerWords,
    talkShareWords: totalWords ? r1((wearerWords / totalWords) * 100) : 0,
    talkShareTime: tAll ? r1((tMine / tAll) * 100) : null,
    speakersMean: timelines.length ? r1(timelines.reduce((n, t) => n + t.speakers, 0) / timelines.length) : 0,
    turns: turns.length,
    substantiveTurns: subst.length,
    backchannels: turns.filter((t) => t.words <= 3).length,
    avgTurnWords: subst.length ? r1(subst.reduce((n, t) => n + t.words, 0) / subst.length) : 0,
    longestTurnWords: longest?.words ?? 0,
    longestTurnSec: longest && longest.endSec != null ? longest.endSec - longest.startSec : null,
    sentences,
    questions: kinds.question,
    tagQuestions: kinds.tag,
    uptalk: kinds.uptalk,
    trailingOff: kinds.trailing,
    tailEndings: subst.filter((t) => endsOnTail(t.text)).length,
    yeahTics,
    vague,
    vagueBreakdown: vb,
    restarts,
    fillers,
    per100: { questions: per(kinds.question), uptalk: per(kinds.uptalk), trailingOff: per(kinds.trailing), yeahTics: per(yeahTics), vague: per(vague), restarts: per(restarts), fillers: per(fillers) },
  };
}

// 95% interval for a per-100-words rate from a count (Byar's approximation to the exact Poisson).
export function rateCi95(count: number, words: number): [number, number] {
  if (!words) return [0, 0];
  const z = 1.96;
  const lo = count === 0 ? 0 : count * (1 - 1 / (9 * count) - z / (3 * Math.sqrt(count))) ** 3;
  const n1 = count + 1;
  const hi = n1 * (1 - 1 / (9 * n1) + z / (3 * Math.sqrt(n1))) ** 3;
  return [r2((lo / words) * 100), r2((hi / words) * 100)];
}

