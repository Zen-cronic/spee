// Real-data taxonomy: the PoC taxonomy plus error types typical of high-A2 / low-B1 learners,
// and English communication types relevant beyond stand-ups. Examples are generic: never taken
// from the operator's data or the Day-1 script, so they can neither leak nor bias the scoring.
// The mock PoC keeps using src/analyze/taxonomy.ts unchanged so its cached prompts stay valid.
import { TAXONOMY } from "../analyze/taxonomy.js";

export const REAL_TAXONOMY: Record<"fr" | "en", Record<string, string>> = {
  fr: {
    ...TAXONOMY.fr,
    FR_VERB_FORM: "Unconjugated or wrong verb form where a conjugated one is needed (hier je partir, il prendre, nous avez).",
    FR_LEXICAL: "Wrong word or false friend where a specific French word exists (attendre un cours for 'attend' → assister à; une librairie for 'library' → une bibliothèque).",
    FR_ADJ_PLACEMENT: "Adjective placed before a noun where it must follow (une rouge voiture → une voiture rouge).",
    FR_ALLER_A: "A preposition inserted after aller + infinitive (on va à manger → on va manger).",
    FR_SI_CONDITIONNEL: "Conditional after si in a hypothesis (si je serais riche → si j'étais riche).",
    FR_TENSE: "Wrong tense or mood for the meaning (imparfait for a completed one-off event: hier je mangeais au resto une fois → j'ai mangé).",
  },
  en: {
    ...TAXONOMY.en,
    EN_FALSE_START: "A sentence abandoned and restarted mid-way (we should we could maybe move the), when it is clearly the speaker's restart and not a transcription glitch.",
  },
};

export const REAL_TYPES = (lang: "fr" | "en") => Object.keys(REAL_TAXONOMY[lang]);
export const ALL_REAL_TYPES = [...REAL_TYPES("fr"), ...REAL_TYPES("en")];
