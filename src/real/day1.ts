// Kill test 2 scorer: did Bee's transcript keep the 10 learner errors planted in
// day1/french-voice-note-script.md, and the 4 fillers? Pure functions; the CLI wrapper is
// scripts/score-day1.ts.

export type Day1Status = "SURVIVED" | "CORRECTED" | "GARBLED";

export interface PlantedError {
  id: string;
  planted: string;
  correct: string;
  type: string; // REAL_TAXONOMY type the coach should flag
  survived: RegExp;
  corrected: RegExp;
}

// Patterns run on fold(text): lowercase, accents stripped, apostrophes unified, punctuation
// removed. "\S+" stands in for the age and other words ASR may render differently.
export const PLANTED: PlantedError[] = [
  { id: "E1", planted: "je suis trente ans", correct: "j'ai trente ans", type: "FR_AGE_ETRE", survived: /\bje suis (\S+ )?(\S+ )?ans\b/, corrected: /\bj ?'?ai (\S+ )?(\S+ )?ans\b/ },
  { id: "E2", planted: "j'habite en Toronto", correct: "j'habite à Toronto", type: "FR_PREPOSITION_PLACE", survived: /\ben toronto\b/, corrected: /\ba toronto\b/ },
  { id: "E3", planted: "j'ai étudié le français depuis", correct: "j'étudie le français depuis", type: "FR_DEPUIS_TENSE", survived: /\bj ?'?ai etudie\b/, corrected: /\bj ?'?etudie\b/ },
  { id: "E4", planted: "j'ai allé", correct: "je suis allé", type: "FR_AUX_ETRE_AVOIR", survived: /\bj ?'?ai allee?s?\b/, corrected: /\bje suis allee?s?\b/ },
  { id: "E5", planted: "la problème", correct: "le problème", type: "FR_GENDER", survived: /\bla probleme\b/, corrected: /\ble probleme\b/ },
  { id: "E6", planted: "je vais à faire", correct: "je vais faire", type: "FR_ALLER_A", survived: /\bvais a faire\b/, corrected: /\bvais faire\b/ },
  { id: "E7", planted: "un difficile exercice", correct: "un exercice difficile", type: "FR_ADJ_PLACEMENT", survived: /\bdifficile exercice\b/, corrected: /\bexercice difficile\b/ },
  { id: "E8", planted: "beaucoup des légumes", correct: "beaucoup de légumes", type: "FR_PARTITIVE", survived: /\bbeaucoup des legumes\b/, corrected: /\bbeaucoup de legumes\b/ },
  { id: "E9", planted: "si j'aurais", correct: "si j'avais", type: "FR_SI_CONDITIONNEL", survived: /\bsi j ?'?aurais\b/, corrected: /\bsi j ?'?avais\b/ },
  { id: "E10", planted: "je suis excité pour", correct: "j'ai hâte de", type: "FR_ANGLICISM", survived: /\bexcitee? pour\b/, corrected: /\bhate de\b/ },
];

// The script has "Euh" x3 and "Ben" x1. Bee renders French "euh" as "um"/"uh" (verified on real
// conversations 2026-10-15), so all of these count.
export const PLANTED_FILLERS = 4;
const FILLERS = /\b(euh+|heu+|um+|uh+|hum+|ben|bah)\b/g;

export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ErrorScore {
  id: string;
  planted: string;
  correct: string;
  type: string;
  status: Day1Status;
  evidence: string | null; // the matched span of the wearer's own note
}

export interface Day1Score {
  survived: number;
  corrected: number;
  garbled: number;
  pass: boolean; // survived >= 7
  fillersKept: number; // of 4
  fillerTokens: string[];
  errors: ErrorScore[];
  words: number;
}

export function scoreDay1(text: string): Day1Score {
  const f = fold(text);
  const errors: ErrorScore[] = PLANTED.map((p) => {
    const s = f.match(p.survived);
    const c = f.match(p.corrected);
    const status: Day1Status = s ? "SURVIVED" : c ? "CORRECTED" : "GARBLED";
    return { id: p.id, planted: p.planted, correct: p.correct, type: p.type, status, evidence: (s ?? c)?.[0] ?? null };
  });
  const fillerTokens = f.match(FILLERS) ?? [];
  const survived = errors.filter((e) => e.status === "SURVIVED").length;
  return {
    survived,
    corrected: errors.filter((e) => e.status === "CORRECTED").length,
    garbled: errors.filter((e) => e.status === "GARBLED").length,
    pass: survived >= 7,
    fillersKept: Math.min(PLANTED_FILLERS, fillerTokens.length),
    fillerTokens,
    errors,
    words: f.split(" ").filter(Boolean).length,
  };
}

// Did the coach flag each surviving error? An item matches when its excerpt overlaps the
// planted span (shares >= 2 folded tokens with it) or its type equals the planted type and its
// excerpt overlaps the evidence span.
export function coachCoverage(score: Day1Score, items: { excerpt: string; error_type: string }[]): { id: string; status: Day1Status; flagged: boolean; byType: boolean }[] {
  return score.errors.map((e) => {
    const target = new Set(fold(e.evidence ?? e.planted).split(" "));
    const hits = items.filter((i) => {
      const t = fold(i.excerpt).split(" ");
      return t.filter((x) => target.has(x)).length >= Math.min(2, target.size);
    });
    return { id: e.id, status: e.status, flagged: hits.length > 0, byType: hits.some((h) => h.error_type === e.type) };
  });
}
