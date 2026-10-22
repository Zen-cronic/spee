# Facts

Each fact the README and the docs repeat, where it comes from, and what checks it. `test/claims.test.ts` runs with `npm test` and fails when a doc drifts from this page or from the code.

## Latency: two sentences, word for word everywhere

- **L1:** Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it.
- **L2:** A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn.

| Fact | Source | Checked by |
|---|---|---|
| L1 and L2 appear word for word in `README.md`, `docs/live.md`, `docs/alexa.md` and `docs/CONTRACT.md` | this page | `test/claims.test.ts` |
| The 5.4 s median and the 4.3 to 14.7 s range were measured on Bee's live stream on 2026-10-16 | `FRICTION_LOG.md`, FL-8 | `test/claims.test.ts` (FL-8 quotes the same numbers) |
| The demo replays Bee's line 5.4 s after speech | `BEE_LINE_LAG_MS` in `src/hub/live/demoScripts.ts` | `test/claims.test.ts` |
| A wrist nudge is about 20 s: Bee's tag, the to-do call and a 10 s alarm lead (17.4 s in the worked example) | `docs/CONTRACT.md`, "`nudge.sent`: the latency hops" | `test/claims.test.ts` |
| The skill waits at most 6.5 s for Bee inside a turn, under Alexa's 8 s limit | `POLL_BUDGET_MS` in `src/alexa/skill.ts` | `test/claims.test.ts` |

## The before/after check is a pilot

| Fact | Source | Checked by |
|---|---|---|
| Registered on 2026-10-16, before any practice | `prereg/transfer.json` (`registered_local`) | `test/claims.test.ts` |
| Practised habits: `hedges` (unsure words) and `filler:like`. The one habit you don't practise: `restart` (starting over, like "the the") | `prereg/transfer.json` (`drilled`, `control`) | `test/claims.test.ts` |
| At least 400 words on each side before a verdict | `prereg/transfer.json` (`min_words_per_period`) | `test/claims.test.ts` |
| It is a two-tier pilot, not proof: two practised habits against one control is one tier short of the three staggered tiers that the What Works Clearinghouse standard for a multiple-baseline design asks for | WWC Standards Handbook v5.0 | `test/claims.test.ts` (the README says "two-tier pilot", and no doc claims proof) |

## Wrist nudges

| Fact | Source | Checked by |
|---|---|---|
| Live nudges are off by default. When on: no nudge in the first 60 s of a conversation, 3 min between any two nudges, 10 min between nudges of the same rule, 6 per hour, 20 per day, none from 22:00 to 08:00 | `DEFAULT_POLICY` in `src/hub/live/policy.ts` | `test/claims.test.ts` (this page and `docs/live.md`) |
| Wrist text is at most 60 characters and starts `[coach] ` | `WRIST_TEXT_MAX` in `src/hub/contract.ts` | `test/claims.test.ts` (this page and `docs/live.md`) |
| Bee's live tag named the wearer on 8 of 9 lines in the 2026-10-16 measurement | `FRICTION_LOG.md`, FL-8 | `test/claims.test.ts` |

## Names and words

| Fact | Source | Checked by |
|---|---|---|
| The product is Spee. On Alexa it answers to "speech coach", the skill tried on a device; `npm run alexa:deploy` also sets up "spee coach" and "spee" as extra development skills, not yet tried. Every skill is listed as Spee | `tv/web/src/brand.ts` (`PRODUCT_NAME`), `alexa/skill-package/interactionModels/custom/en-CA.json` (`invocationName`), `alexa/skill-package/skill.json` (`name`), `DEFAULT_INVOCATION_NAMES` in `src/alexa/skillPackage.ts` | `test/tv-brand.test.ts`, `test/claims.test.ts`, `test/alexa-deploy.test.ts` |
| The drill tracker reads "You said it, Checked by Bee, Result" on the TV and on Alexa screens | `tv/web/src/views/LiveView.tsx`, `SCREEN_TEXT.steps` in `src/alexa/apl.ts` | `test/claims.test.ts` |
| Fixed word lists count the habits. A model only drafts vague-answer practice lines and, when turned on, rewords a recap | `src/hub/habits.ts`, `src/hub/realCards.ts`, `src/hub/live/recapPrompt.ts` | `test/claims.test.ts` (the counting, grading and nudge-policy files import no model client) |

## Running it

| Fact | Source | Checked by |
|---|---|---|
| Node 22.12 or later | `engines.node` in `package.json` | `test/claims.test.ts` |
| The package is `spee` | `package.json` | `test/claims.test.ts` |
| Every `npm run` command in the docs exists, and every repo path in backticks exists (gitignored paths excepted) | `package.json`, the tree | `test/claims.test.ts` |

## Prior art

Wearable feedback on unwanted words has been studied before: WSCoach (arXiv 2507.04238, 2025) reports that near-real-time feedback and after-the-fact review both reduced unwanted words in daily conversation. Spee makes no claim to be new as a wearable coach. The research it builds on: awareness training cut filled pauses by about 70 to 90% per minute in seven single-case studies (2016 to 2022), and speakers rated sparse one-word cues above a continuous display, which disrupted their delivery. Those are other people's results, not ours.
