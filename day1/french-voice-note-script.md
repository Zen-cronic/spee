# Day-1 kill test: French voice note with 10 planted errors

**Purpose:** find out whether Bee's speech recognition keeps a learner's grammar errors or silently "fixes" them. If it fixes them, the French drill coach has nothing to coach.

**Kill rule (from POC_REPORT.md):** if fewer than **7 of 10** errors survive in Bee's transcript, return the Watch.

**Secondary test:** do the 4 planted fillers ("euh" ×3, "ben" ×1) survive? This decides whether filler coaching is possible at all.

## How to record
1. Record a **Bee voice note on the Apple Watch**. Voice notes are the wearer-only channel the product is built on.
2. Read at your normal speaking pace, in your own accent. **Don't over-stress the errors**: say them the way a learner naturally would.
3. Read the fillers naturally too, with a short pause.
4. The script is 109 words, safely above Bee's ~50-word deletion threshold.
5. "trente ans" is a placeholder. Any number works; the error is the verb, not the age.
6. Wait until the note's state is READY, then fetch it: `bee journals list --json`, then `bee journals get <id> --json`. Save the JSON to `day1/bee-fr-note.json` (gitignored).

## Script (read this aloud)

Bonjour ! Euh, aujourd'hui je veux parler de ma semaine. Je suis trente ans et j'habite en Toronto. J'ai étudié le français depuis deux ans, parce que c'est important pour mon travail. Hier soir, j'ai allé à mon cours de français. Euh, la problème, c'est que je suis toujours fatigué après le travail. Ben, le week-end, je vais à faire du sport chez moi, des tractions et des dips. C'est un difficile exercice, mais j'aime ça. Je mange aussi beaucoup des légumes. Si j'aurais plus de temps, je ferais du sport tous les jours. Euh, et je suis vraiment excité pour mon prochain examen. Voilà, c'est tout pour aujourd'hui.

## Answer key (don't look while recording)
Each error is chosen to be **audible**: the wrong form sounds different from the correct one. Silent-spelling errors (e.g. "ils mange" vs "ils mangent") are deliberately excluded, because a transcript can't show them either way.

| # | Planted error | Correct form | Error type | What "auto-corrected" would look like |
|---|---|---|---|---|
| E1 | je **suis** trente ans | j'**ai** trente ans | être/avoir for age | "j'ai trente ans" |
| E2 | j'habite **en** Toronto | j'habite **à** Toronto | city preposition | "à Toronto" |
| E3 | j'**ai étudié** … depuis deux ans | j'**étudie** … depuis deux ans | depuis + present tense | "j'étudie" |
| E4 | j'**ai allé** | je **suis allé** | auxiliary (être verbs) | "je suis allé" |
| E5 | **la** problème | **le** problème | noun gender | "le problème" |
| E6 | je vais **à** faire | je vais faire | aller + infinitive (no "à") | "je vais faire" |
| E7 | un **difficile exercice** | un **exercice difficile** | adjective placement | "un exercice difficile" |
| E8 | beaucoup **des** légumes | beaucoup **de** légumes | quantity + de | "beaucoup de légumes" |
| E9 | si j'**aurais** | si j'**avais** | si + imparfait (no conditional) | "si j'avais" |
| E10 | je suis **excité pour** | j'**ai hâte de** passer | anglicism (lexical) | Unlikely to be "fixed" by speech recognition; tests whether the *coach* catches a meaning-level error |

**Fillers (secondary):** "Euh" (×3, at "Euh, aujourd'hui", "Euh, la problème" and "Euh, et je suis"), plus "Ben" (×1, at "Ben, le week-end").

## Scoring
For each E1–E10, label Bee's transcript with one of:
- **SURVIVED:** the wrong form appears.
- **CORRECTED:** the correct form appears; the speech recognition fixed it.
- **GARBLED:** neither form appears (misheard).

Pass = SURVIVED ≥ 7. Separately, report the number of fillers kept out of 4. Then run the PoC analyzer on the real note (`BEE_SOURCE=cli`) and check that the coach flags the survivors, E10 included.
