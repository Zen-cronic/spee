// Mislabel detector. Bee sometimes labels media or assistant audio (a podcast, a voice assistant
// reading research results aloud) as the wearer. Flag wearer-labelled lines that do not look
// like the wearer's own spontaneous speech, mark them "uncertain", and keep them out of drills.
// Deterministic and explainable: every flag carries its reasons.
import { FILLER_RE, countRe, lineLang, repeats, wordCount } from "./text.js";

export interface LabelledLine {
  id: number;
  start: number | null;
  end: number | null;
  text: string;
}

export interface MislabelVerdict {
  uncertain: boolean;
  score: number;
  reasons: string[];
}

// Assistant / research-report phrasing (FR + EN). Speech a learner rarely produces about
// themselves, and that voice assistants and narrators produce constantly.
const ASSISTANT =
  /(?<![\p{L}\p{N}])(voici ce que|selon (les|mes|des) (sources|recherches)|mes recherches|je suis en train de (re)?trouver|pour que (tu|vous) puiss|je ne (le|la|les) (con|com)pterai|dans mon avis|aucun (témoignage|avis|résultat|commentaire)s? (de|du|des|sur)|n'hésitez pas|here'?s what i found|according to (my|the|our)|based on (my|the) (research|search|sources)|i('d| would) be happy to|great question|let me know if|i found (a|an|the|some)|i couldn'?t find|in summary|to summari[sz]e|sources? (say|suggest|indicate))(?![\p{L}\p{N}])/iu;
// Third-person narration / reportage
const NARRATION =
  /(?<![\p{L}\p{N}])((il|elle) a (été )?(publié|fondé|créé|lancé)|publié (le|par|en)|depuis près de \d+|a été créée? (en|le)|(he|she|it) (was|has been) (founded|published|launched)|was founded in|the (article|episode|podcast|report) (says|notes|mentions))(?![\p{L}\p{N}])/iu;
// Markers of the wearer's spontaneous speech: fillers, restarts, asking for a word, backchannels.
const SPONTANEOUS = /\b(comment on dit|comment dire|how do you say|what'?s the word|c'est quoi le mot|ah oui|d'accord|yeah|okay|ok|right\?)\b/i;

export function lineFeatures(l: LabelledLine) {
  const w = wordCount(l.text);
  const fillers = countRe(l.text, FILLER_RE.en) + countRe(l.text, /\b(?:euh+|ben|bah)\b/gi);
  const reps = repeats(l.text);
  const lang = lineLang(l.text);
  return {
    words: w,
    fillers,
    repeats: reps,
    lang,
    assistant: ASSISTANT.test(l.text),
    narration: NARRATION.test(l.text),
    spontaneous: fillers > 0 || reps > 0 || SPONTANEOUS.test(l.text) || lang === "mixed",
    // Long, fluent, single-language, no disfluency at all: reading cadence or synthetic speech.
    fluentLong: w >= 18 && fillers === 0 && reps === 0 && lang !== "mixed",
  };
}

const overlapSec = (a: LabelledLine, b: LabelledLine) =>
  a.start == null || a.end == null || b.start == null || b.end == null ? 0 : Math.min(a.end, b.end) - Math.max(a.start, b.start);

// `lines` = all wearer-labelled lines of one conversation (any order).
export function detectMislabels(lines: LabelledLine[]): Map<number, MislabelVerdict> {
  const sorted = [...lines].sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.id - b.id);
  const f = new Map(sorted.map((l) => [l.id, lineFeatures(l)]));
  const out = new Map<number, MislabelVerdict>();
  for (const l of sorted) {
    const x = f.get(l.id)!;
    const reasons: string[] = [];
    let score = 0;
    if (x.assistant) (score += 2), reasons.push("assistant/research phrasing");
    if (x.narration) (score += 2), reasons.push("third-person narration");
    if (x.fluentLong) (score += 1), reasons.push(`fluent ${x.words}-word line with no disfluency`);
    // The wearer cannot say two things at once: a wearer line overlapping another wearer line
    // (>= 2 s) means one of them is another voice. Charge the less spontaneous one.
    for (const o of sorted) {
      if (o.id === l.id || overlapSec(l, o) < 2) continue;
      const y = f.get(o.id)!;
      if (!x.spontaneous && y.spontaneous) {
        score += 1;
        reasons.push(`overlaps wearer line ${o.id} in time`);
        break;
      }
    }
    if (x.spontaneous) score -= 1;
    // Assistant phrasing or narration flags the line even when it also holds the wearer's words
    // (Bee merges a request and the assistant's reply into one utterance).
    out.set(l.id, { uncertain: score >= 2 || x.assistant || x.narration, score, reasons });
  }
  // Contagion: a short, non-spontaneous line sitting inside a run of flagged lines (neighbours
  // within 15 s on both sides, or one side when the other is absent) is part of the same
  // media/assistant segment.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < sorted.length; i++) {
      const l = sorted[i]!;
      const v = out.get(l.id)!;
      const x = f.get(l.id)!;
      if (v.uncertain || x.spontaneous) continue;
      const near = (j: number) => {
        const o = sorted[j];
        if (!o) return null;
        const gap = Math.abs((o.start ?? 0) - (l.start ?? 0));
        return gap <= 15 ? out.get(o.id)!.uncertain : false;
      };
      const prev = near(i - 1),
        next = near(i + 1);
      if ((prev && next) || (prev && next === null) || (next && prev === null) || ((prev || next) && x.words <= 6)) {
        v.uncertain = true;
        v.reasons.push("inside a run of flagged lines");
      }
    }
  }
  return out;
}
