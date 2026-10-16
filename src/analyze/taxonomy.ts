// Product taxonomy (what the coach looks for). Shared vocabulary, not ground truth.
export type Lang = "en" | "fr";

export const TAXONOMY: Record<Lang, Record<string, string>> = {
  en: {
    EN_HEDGE_STACK: "Stacked hedges that drain a claim of commitment (I think maybe probably, kind of, sort of).",
    EN_VAGUE_STATUS: "Status with no concrete state (making progress, pretty much done, going well) instead of what is done / what is left.",
    EN_NO_ETA: "No commitment on when (soonish, at some point, hopefully this week-ish).",
    EN_BURIED_BLOCKER: "A blocker or ask mentioned late, minimized, or as an afterthought instead of led with.",
    EN_RUN_ON: "One long chained utterance (and then, and then, so) with several updates and no stop.",
    EN_OVER_APOLOGY: "Apologizing for or belittling one's own update (sorry, this is probably dumb, not much from me).",
    EN_VAGUE_REFERENT: "Unclear referents (that thing, the stuff, the issue from before) where a name is needed.",
    EN_PASSIVE_NO_OWNER: "Passive or ownerless statements about decisions or actions (it was decided, it will get looked at).",
  },
  fr: {
    FR_AUX_ETRE_AVOIR: "Wrong passé composé auxiliary (j'ai allé, j'ai resté, je suis mangé).",
    FR_GENDER: "Wrong article/adjective gender (le maison, un bonne idée, mon voiture est petit).",
    FR_AGE_ETRE: "Age with être instead of avoir (je suis 25 ans).",
    FR_DEPUIS_TENSE: "Passé composé with depuis for an ongoing state (j'ai habité ici depuis deux ans).",
    FR_PREPOSITION_PLACE: "Wrong preposition with countries/cities (en Canada, à France, dans Montréal).",
    FR_CONTRACTION: "Missing contraction (à le, de le, à les, de les).",
    FR_MISSING_NE: "Negation without ne (je sais pas, c'est pas). Register issue in speech, error in class targets.",
    FR_ANGLICISM: "Anglicism or calque (ça fait du sens, appliquer pour, je suis excité pour, prendre une marche).",
    FR_REFLEXIVE: "Missing reflexive pronoun (je lève à sept heures, je souviens).",
    FR_PARTITIVE: "Wrong partitive/quantity article (beaucoup des amis, je mange des le pain).",
  },
};

export const ERROR_TYPES = (lang: Lang) => Object.keys(TAXONOMY[lang]);
