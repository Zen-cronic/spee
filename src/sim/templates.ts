// Authored utterance templates for the synthetic Bee world.
// Markup: {um} filler (kept in `verbatim`, stripped in `cleaned`), {C}/{N} slots,
// [[wrong||right]] planted error span (excerpt = wrong, corrected text = right).
// This file belongs to the simulator; the analyzer never imports it.

export const FILLERS: Record<string, string> = {
  um: "um",
  uh: "uh",
  like: "like",
  youknow: "you know",
  euh: "euh",
  ben: "ben",
  bah: "bah",
  ducoup: "du coup",
  genre: "genre",
};

export const EN_COMPONENTS = [
  "billing webhook",
  "search indexer",
  "onboarding flow",
  "CSV export",
  "Postgres migration",
  "rate limiter",
  "auth service",
  "notifications queue",
  "feature flag service",
  "mobile login screen",
];

export const EN_ERRORS: Record<string, string[]> = {
  EN_HEDGE_STACK: [
    "{um} so for the {C} [[I think it should maybe kind of be||it will be]] ready for review today.",
    "[[I guess I'd probably sort of say||I'd say]] the {C} refactor is {uh} about half done.",
    "And {like} [[I feel like maybe we could possibly||we should]] split the {C} ticket into two.",
    "[[I mean I think it's probably kind of||It's]] safe to merge the {C} change after lunch.",
    "{uh} [[hopefully maybe I think||I expect]] the fix for the {C} lands before the release cut.",
  ],
  EN_VAGUE_STATUS: [
    "{um} yesterday I [[made some good progress on||finished the retry logic for]] the {C}.",
    "The {C} is [[pretty much almost there||done except the two failing tests]].",
    "[[Things are going well with||I merged the schema change for]] the {C}, {uh} so yeah.",
    "I [[kept chipping away at||closed three of the five subtasks on]] the {C}.",
    "[[It's coming along||The API side is done and the UI is left]] on the {C}.",
  ],
  EN_NO_ETA: [
    "{um} I should have the {C} PR up [[at some point||by two pm today]].",
    "The {C} work will be done [[soonish||by Thursday noon]].",
    "{like} I'll get to the {C} review [[when I can||right after standup]].",
    "Hoping to wrap the {C} [[this week-ish||by Friday]], {uh} we'll see.",
    "I'll ping design about the {C} [[eventually||today]].",
  ],
  EN_BURIED_BLOCKER: [
    "{um} oh and [[also I'm kind of blocked on staging access but it's fine||I'm blocked on staging access and need Marcus to grant it today]].",
    "[[Oh one more tiny thing, I'm sort of waiting on the {C} credentials, no big deal||I'm blocked on the {C} credentials and need them from ops by noon]].",
    "{uh} [[and I guess the {C} tests failing on main is slowing me down a bit||the failing {C} tests on main are blocking my merge and I need an owner]].",
    "[[Last thing, not a big deal, but I still don't have the {C} API key||I'm blocked without the {C} API key and need it today]].",
  ],
  EN_RUN_ON: [
    "[[Yesterday I worked on the {C} and then I looked at the flaky test and then I paired with Priya on the cache and then I started the docs and then I got pulled into the incident||Yesterday I finished the {C}; I also paired with Priya on caching and joined the incident]].",
    "[[So I picked up the {C} and fixed the null check and then wrote a test and then the test broke the build so I reverted it and then I fixed it again and so it's back in review||I fixed the null check in the {C}; it broke the build once; it's back in review]].",
    "{um} [[and then after that I worked on the {C} and then the code review for Dan and then I was going to start the export but then the meeting ran long so||after that I reviewed Dan's PR; the export work starts today]].",
    "[[Basically I spent the morning on the {C} and then the afternoon on the alerts and then in the evening I looked at the dashboards and then I updated the runbook||Morning on the {C}, afternoon on alerts, then the runbook update]].",
  ],
  EN_OVER_APOLOGY: [
    "[[Sorry, this is probably a boring one, but||]] I spent yesterday on the {C}.",
    "{um} [[not much from me, sorry,||]] I'm still on the {C}.",
    "[[This is probably a dumb question but||]] should the {C} go behind a feature flag?",
    "[[Sorry, I know I'm taking too long,||]] last thing on the {C} is the rollback plan.",
    "[[Sorry, I'm a bit all over the place today,||]] I reviewed the {C} design doc.",
  ],
  EN_VAGUE_REFERENT: [
    "I also fixed [[that thing from before||the timeout bug in the {C}]] {um} that Dan mentioned.",
    "{uh} [[the stuff with the config||the {C} config drift]] should be sorted now.",
    "I need to look into [[the issue we talked about||the {C} memory leak]] after this.",
    "[[That other thing||The {C} alert noise]] is still on my list.",
    "Can someone look at [[the thing in staging||the broken {C} deploy in staging]] today?",
  ],
  EN_PASSIVE_NO_OWNER: [
    "[[It was decided that||Sam and I decided that]] the {C} gets pushed to next sprint.",
    "[[The {C} incident will get looked at||I'll own the {C} incident review]] this week.",
    "[[Mistakes were made on||We shipped a bad config for]] the {C} last night.",
    "[[It's been agreed the||We agreed the]] {C} rollout pauses until Monday.",
  ],
};

export const EN_NEUTRAL_WEARER = [
  "Today I'm pairing with Priya on the {C}.",
  "I merged the {C} fix yesterday afternoon.",
  "Next up for me is the {C} load test.",
  "The {C} dashboard now shows p95 latency.",
  "I wrote the {C} runbook section on rollbacks.",
  "Code review for the {C} is ready if anyone has time.",
  "I added alerts for the {C} error rate.",
  "I'll demo the {C} at Thursday's sprint review.",
];

export const EN_NEUTRAL_OTHER = [
  "I finished the {C} pagination and it's in review.",
  "Today I'm on the {C} integration tests.",
  "No blockers for me.",
  "I'm deploying the {C} to staging at eleven.",
  "Yesterday I fixed the {C} flake, it was a race in the setup code.",
  "I'll be out Friday afternoon for an appointment.",
  "The {C} on-call rotation is updated in the wiki.",
  "I can take the {C} review after lunch.",
];

export const EN_LEAD_OPEN = ["Morning everyone, let's keep this quick.", "Okay, let's get started, we have ten minutes."];
export const EN_LEAD_TURN = ["{N}, you're up.", "Okay {N}, go ahead.", "Thanks. {N}, what about you?"];
export const EN_LEAD_CLOSE = ["Great, that's everyone, thanks all.", "Okay, let's take the blockers offline, thanks everyone."];

export const FR_ERRORS: Record<string, string[]> = {
  FR_AUX_ETRE_AVOIR: [
    "{euh} samedi [[j'ai allé||je suis allé]] au marché avec ma sœur.",
    "Hier soir [[j'ai resté||je suis resté]] à la maison parce que j'étais fatigué.",
    "La semaine dernière [[j'ai venu||je suis venu]] en classe à vélo.",
    "{ben} [[j'ai sorti||je suis sorti]] avec des collègues vendredi.",
    "Ce matin [[j'ai parti||je suis parti]] très tôt pour le travail.",
    "Mes parents [[ont arrivé||sont arrivés]] dimanche soir.",
  ],
  FR_GENDER: [
    "On a mangé dans [[un petit restaurant italienne||un petit restaurant italien]] près de chez moi.",
    "[[Le maison||La maison]] de mon ami est très grande.",
    "J'ai acheté [[un nouvelle voiture||une nouvelle voiture]] le mois dernier.",
    "{euh} c'est [[un bonne idée||une bonne idée]] pour le projet.",
    "[[Mon voiture est petit||Ma voiture est petite]] mais pratique.",
    "J'ai écouté [[le chanson||la chanson]] que vous avez partagée.",
  ],
  FR_AGE_ETRE: [
    "[[Je suis vingt-cinq ans||J'ai vingt-cinq ans]] et je travaille à Toronto.",
    "Mon frère [[est trente ans||a trente ans]] cette année.",
    "{euh} ma fille [[est six ans||a six ans]] maintenant.",
  ],
  FR_DEPUIS_TENSE: [
    "[[J'ai habité||J'habite]] à Toronto depuis trois ans.",
    "{euh} [[j'ai appris||j'apprends]] le français depuis huit mois.",
    "[[J'ai travaillé||Je travaille]] dans la même entreprise depuis 2022.",
    "[[J'ai été||Je suis]] dans cette classe depuis septembre.",
  ],
  FR_PREPOSITION_PLACE: [
    "Cet hiver je voudrais aller [[à France||en France]] pour voir ma cousine.",
    "Mon collègue habite [[en Japon||au Japon]] maintenant.",
    "{ben} j'ai fait un voyage [[à Mexique||au Mexique]] l'année dernière.",
    "On veut aller [[dans Montréal||à Montréal]] pour le long week-end.",
    "Ma sœur travaille [[en États-Unis||aux États-Unis]] depuis janvier.",
  ],
  FR_CONTRACTION: [
    "Dimanche on est allés [[à le||au]] cinéma.",
    "Je parle souvent [[de le||du]] travail avec mes amis.",
    "{euh} j'ai parlé [[à les||aux]] voisins de la fête.",
    "C'est la fin [[de le||du]] mois donc je suis très occupé.",
  ],
  FR_MISSING_NE: [
    "{euh} [[je sais pas||je ne sais pas]] comment dire ça en français.",
    "[[C'est pas||Ce n'est pas]] facile pour moi.",
    "[[J'ai pas||Je n'ai pas]] eu le temps de faire les devoirs.",
    "[[Je comprends pas||Je ne comprends pas]] la différence entre les deux.",
    "[[Il y a pas||Il n'y a pas]] de problème.",
  ],
  FR_ANGLICISM: [
    "{ducoup} [[ça fait du sens||ça a du sens]] pour moi.",
    "Je vais [[appliquer pour||postuler à]] un nouveau poste.",
    "[[Je suis excité pour||J'ai hâte de]] partir en vacances.",
    "Après le souper on a [[pris une marche||fait une promenade]] au parc.",
    "{genre} je dois [[canceller||annuler]] mon rendez-vous de mardi.",
  ],
  FR_REFLEXIVE: [
    "En semaine [[je lève||je me lève]] à six heures et demie.",
    "[[Je souviens||Je me souviens]] de mon premier jour au Canada.",
    "{ben} le dimanche [[je repose||je me repose]] beaucoup.",
    "Après le sport [[je douche||je me douche]] et je prépare le souper.",
  ],
  FR_PARTITIVE: [
    "J'ai [[beaucoup des amis||beaucoup d'amis]] dans mon quartier.",
    "Je bois [[beaucoup du café||beaucoup de café]] le matin.",
    "Il y a [[trop des gens||trop de gens]] dans le métro.",
    "On a acheté [[des le pain||du pain]] et du fromage.",
  ],
};

export const FR_NEUTRAL_WEARER = [
  "Ce week-end j'ai fait du ménage et j'ai lu un livre.",
  "Je travaille dans l'informatique, je suis développeur.",
  "J'aime beaucoup cuisiner le dimanche.",
  "Mon quartier est calme et il y a un beau parc.",
  "Je prends le métro pour aller au travail.",
  "Je voudrais améliorer mon français pour le travail.",
  "Le soir je regarde des séries en français avec des sous-titres.",
];

export const FR_NEUTRAL_STUDENT = [
  "Moi, je suis allée au restaurant avec ma copine.",
  "J'ai regardé un film avec ma famille.",
  "Je suis d'accord avec vous.",
  "Je travaille comme infirmier à l'hôpital.",
  "Il a fait très beau samedi.",
  "J'ai fait les devoirs dimanche soir.",
];

export const FR_TEACHER = [
  "Alors, qu'est-ce que vous avez fait ce week-end ?",
  "Très bien, merci beaucoup.",
  "Parfait, c'est une très bonne réponse.",
  "Aujourd'hui on révise le passé composé avec être.",
  "Attention, on ne dit pas j'ai allé, on dit je suis allé.",
  "Qui veut continuer ?",
  "D'accord, et pourquoi ?",
  "Pour les devoirs, écrivez dix phrases sur vos vacances.",
  "Attention au genre, on dit la maison, c'est féminin.",
];
export const FR_TEACHER_OPEN = ["Bonjour tout le monde, on commence ?", "Bonsoir à tous, installez-vous, on commence."];
export const FR_TEACHER_TURN = ["{N}, à vous.", "Et vous, {N} ?", "{N}, vous voulez répondre ?"];
export const FR_TEACHER_CLOSE = ["Bon travail aujourd'hui, à jeudi.", "C'est tout pour aujourd'hui, bonne soirée."];
// Native speakers drop "ne" too; planted as FR_MISSING_NE by the teacher.
export const FR_TEACHER_NE_DROP = ["[[C'est pas||Ce n'est pas]] grave, on continue.", "[[Il y a pas||Il n'y a pas]] de mauvaise réponse ici."];
