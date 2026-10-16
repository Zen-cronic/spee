# Bee speech coach: real-data report

Generated 2026-10-15 (about 12:30 EDT) by `npm run real`, on the operator's own Bee data (Apple Watch running Bee, Developer Mode, `@beeai/cli` 0.8.0, production API). `POC_REPORT.md` is kept unchanged as the historical mock-data run.

**Privacy.** This file holds aggregates only. It quotes no line, the wearer's or anyone else's, and names conversations by label rather than by Bee id. All real text lives in gitignored `real/`, `out/` and `cache/`. See "Leak check" at the end.

**Corpus.** 5 conversations captured 2026-10-14 22:14 EDT to 2026-10-15 12:02 EDT. Together they contain 470 final-transcript utterances, 151 of them labelled as the wearer (about 2,000 of the wearer's words); 4 of the 5 contain the wearer's speech. There are 0 voice notes, so kill test 2 has not been recorded yet. Conversation types:

- one French-practice session with a French-speaking voice assistant (FR practice);
- one long English voice chat with an AI assistant (EN AI chat);
- two short English chats (EN short A and B);
- one machine-voice session (a text-to-speech coach playing aloud; TTS audio). It was labelled entirely "Unknown", so it has 0 wearer lines.

LLM: Bedrock Converse, `us.anthropic.claude-haiku-4-5-20251001-v1:0` for extraction, `us.anthropic.claude-sonnet-4-5-20250929-v1:0` for the new verification pass. There were 9 calls (cached; 0 errors). A hard allowlist means only Haiku 4.5, Sonnet 4.5 and gpt-oss-120b can ever be invoked.

## Verdict: GO, with two gates tonight (upgraded from GO-IF)

The thesis was: **your real speech → your specific errors → spaced drills → a re-performance check**. On real data it holds, and holds better than the mock assumed.

**What holds:**

- **Bee names the wearer.** This removes the mock's biggest blocker: 36–48% of group-conversation items were someone else's line. Group conversations and classes become coachable, not just voice notes.
- **Fillers survive.** Filler coaching is back as a real feature.
- **Learner errors and code-switches survive** in French conversation.

**What is weaker than the mock:**

- **ASR noise on accented, code-switched speech is heavy.** The guard quarantined 56% of candidate items.
- **Media and assistant audio is sometimes labelled as the wearer.**
- **The verified drill yield is small** on this corpus: 8 error drills and 8 vocabulary drills from about 2,000 words, only 3 of them French errors.

**Gates for tonight (2026-10-15):**

1. **Kill test 2:** at least 7 of 10 planted errors SURVIVED in the Day-1 voice note (`npm run day1`).
2. **Class night:** `npm run class` on the 18:00 EDT class yields at least 5 verified French drills, at least 70% of which hold up when the operator reads them.

If gate 1 fails, voice notes are not a usable French drill channel. The coach then runs on conversations only (the wearer filter), and voice notes are used only for English re-performance checks. If gate 2 fails on a full 2-hour class, the French product has too little signal per day for a 7-day demo, so pivot the story to English communication coaching plus vocabulary moments.

## 1. Wearer attribution

| Conversation | Final utterances | Labelled wearer | Wearer share | Flagged "maybe not you" |
|---|---|---|---|---|
| EN short A | 12 | 7 | 58% | 0 |
| EN short B | 29 | 14 | 48% | 0 |
| EN AI chat | 183 | 77 | 42% | 0 |
| FR practice (with a FR voice assistant) | 148 | 53 | 36% | 9 (17%) |
| TTS audio | 98 | 0 | 0% | 0 |
| **All** | **470** | **151** | **32%** | **9 (6.0%)** |

- **Discovery:** the wearer's labels are discovered from `bee me` (the profile first and last name), not hard-coded. Bee used two variants of the first name across conversations, and both are matched. A conversation that is still CAPTURING carries only a realtime transcription with every speaker "Unknown". The pipeline skips it and asks for a rerun.
- **Mislabels exist, and they concentrate where a voice assistant speaks the target language.** In the English AI chat, the assistant's voice was correctly kept "Unknown". So was the TTS audio. In the French session, a French-speaking assistant reading research results was partly labelled as the wearer.
- **Mislabel detector.** It is deterministic and every flag carries reasons. Its signals:
  - assistant/research phrasing;
  - third-person narration;
  - fluent long lines with zero disfluency;
  - two wearer lines overlapping in time;
  - runs of such lines.

  It flagged 9 of 151 wearer-labelled lines, all in the French session.
- **Agent's provisional read** (not ground truth): about 15 of the French session's 53 wearer-labelled lines are not the wearer (28%), plus about 8 ambiguous ones. That is roughly 10–15% of all wearer-labelled lines. Against that read:
  - **Precision ≈ 9/9.** Every flagged line looks like another voice.
  - **Recall ≈ 9/15 (60%).** Missed lines are short, garbled fragments without assistant phrasing. Caveat: the rules were developed on this same conversation, so these numbers are in-sample and optimistic.
- **Operator labelling (pending):** `out/mislabel-sample.md` holds 39 lines: all 9 flagged lines, 20 unflagged lines from the French session and 10 from the other conversations. The detector's verdict is hidden from the sheet. `npm run mislabel:score` turns the labels into precision and recall.
- **Effect of mislabels:** they dilute the measurements. Counting the flagged lines lowers the French filler rate from 3.40 to 2.64 per 100 words (−22%), because assistant speech is fluent. Flagged lines never become drills.

## 2. Filler, hedge and error survival

Wearer's coachable lines only (flagged lines excluded), by each line's dominant language. Of the wearer lines, 103 are EN, 36 FR, 10 mixed and 2 unknown.

| Language | Words | Fillers per 100 words | Filler breakdown | Hedges per 100 words | Repeats per 100 words |
|---|---|---|---|---|---|
| French | 471 | **3.40** | uh 12, um 4 (0 "euh", 0 "ben") | 0.64 (un peu ×3) | 1.91 |
| English | 1,499 | **5.67** | uh 41, like 24, you know 9, um 11 | 1.00 (I think, maybe ×3 each; I don't know, probably, I'm not sure ×2 each; I guess, I feel like, kind of ×1 each) | 1.20 |

- **Fillers survive.** um + uh alone come to 3.45 per 100 words across both languages. That is about 10–34× the 0.10–0.34 in a published 9-day real-Bee log, the basis for the mock's "cleaned" assumption. In French, Bee writes the learner's "euh" as "uh"/"um" (it never wrote "euh"), so the French filler lexicon counts um/uh.
- **"like" is noisy.** An English "like" counts only in filler position. A hand check of the 24 hits found about 2 that are ASR for an exercise term, not fillers.
- **French learner errors survive transcription.** The verifier kept 3 French errors: a gender agreement error, an unconjugated verb, and one lexical item (likely an ASR artifact; see below).
- **Code-switching is kept verbatim** (see the asked-for vocabulary in section 3).
- **ASR noise is the binding constraint.** Haiku proposed 34 candidate items:
  - **19 (56%)** quarantined by the ASR guard;
  - **15** passed the guard and the grounding check;
  - **8** kept by the new Sonnet verification pass.

## 3. Drill specificity vs a generic baseline

The same wearer lines were given to a "Daily Insights" style prompt (same model). Bee's own `insights` endpoint returned 0 items for this account.

| | Drills (8 error + 8 vocabulary) | Generic baseline (10 insights, FR + EN) |
|---|---|---|
| Cites a real utterance id | **100%** | 0% (no line ids) |
| Quotes the wearer's line verbatim | **100%** | 20% quote any 4-word run |
| Names a concrete wrong form → right form | **100%** | **0%** |

**Agent hand audit** (Claude reading the wearer's lines, not a native-speaker judgement; details in gitignored `out/drill-audit-agent.json`):

| Stage | Real errors of the stated type | Precision |
|---|---|---|
| After the ASR guard (Haiku only) | 6 / 15 | **40%** |
| After the Sonnet verifier | 6 / 8 | **75%** |

- **The verifier** dropped 7 items: fragments, corrections that invented content, a self-interruption and a garbled line. It kept all 6 real errors.
- **The 2 remaining misses:**
  - an English "like" filler, typed as a hedge stack;
  - a French lexical item that is probably ASR for "cours", on a line that may be the assistant.
- **One kept item has a weak correction:** the unconjugated-verb drill suggests a modal construction where the passé composé is the better fix.

**Code-switch moments are the strongest signal.** Of 10 candidate moments, 2 were dropped as proper nouns (group and venue names), leaving 8 drills:

- **Asked ("comment on dit …?"): 4 of 4 useful.** Each pairs the English word the wearer reached for with the French word the assistant gave back.
- **Inferred English insertions: 1 of 4 useful.** The class report now tags them "(inferred switch)" and lists asked moments first.

**Filler drills** come straight from the wearer's densest lines: the drill is to re-say the line with silent pauses.

**Representative English drills:** a hedge stack cut to a plain commitment, and a restart split into two sentences.

## 4. What changed from `POC_REPORT.md` (mock)

| Assumption in the mock | Real data (2026-10-15) | Consequence |
|---|---|---|
| Every speaker is "Unknown" (bee-cli issue 19) | The wearer is labelled by profile name on final transcripts. Only realtime transcripts are all "Unknown" | Group conversations and classes are coachable through the wearer filter. The mock's 36–48% "someone else's line" contamination drops to residual mislabels (6% flagged; about 10–15% estimated) |
| Fillers are stripped ("cleaned" is the expected condition) | Fillers survive: FR 3.4, EN 5.7 per 100 words | Filler coaching is reinstated (per-language rates plus line-level drills) |
| Voice notes are the only wearer-only channel | Still unverified on real data (0 journals) | Kill test 2 decides it tonight |
| Synthetic text has no ASR errors (0% quarantined) | 56% of candidate items quarantined | A Sonnet verification pass was added: precision 40% → 75% (agent audit, n = 15 → 8) |
| Precision: FR voice notes 100%, group 52% | Real conversations: 75% after verification (small n) | Promising, not yet proven. Tonight's class is the first real-volume test |
| Yield of about 6 drills per language per day | About 2,000 wearer words gave 3 FR + 5 EN error drills, 8 vocabulary, 3 filler | Volume depends on speaking French aloud. A 2-hour class is the real test |
| No vocabulary channel | "Comment on dit …?" moments are captured with the reply | A new drill kind: "you reached for English here; say it in French" |

## 5. Pipelines delivered

- **Real source:** `CliBeeSource` is the real path: paginated `conversations list/get`, `journals list/get` and `me`. The live contract test passes (41/41 with `BEE_SOURCE=cli`).
- **Wearer filter and mislabel detector:** `src/real/wearer.ts` and `src/real/mislabel.ts`. Flagged lines are kept out of drills by default.
- **Analysis:** `src/real/analyze.ts` runs:
  - per-line language detection, with mixed lines allowed;
  - filler and hedge rates per language;
  - Haiku extraction with the ASR guard;
  - the Sonnet verifier;
  - code-switch vocabulary;
  - filler drills;
  - drill cards that cite the utterance id.
- **Kill test 2:** `scripts/score-day1.ts` (`npm run day1`). It scores E1–E10 as SURVIVED / CORRECTED / GARBLED, plus the 4 fillers. With `--analyze`, it also checks that the coach flags each survivor. On the synthetic journal fixture it scores 9/10 SURVIVED and PASS, and the coach flags 9/9.
- **Class night:** `npm run class -- --since <iso>`. It covers conversations plus the debrief voice note, keeps a Leitner deck in `real/deck.json` and writes `out/class-<date>.md` with:
  - the top 5 errors;
  - 3 drills for tomorrow;
  - filler and hedge stats;
  - the code-switch vocabulary.

  A dry run on today's data worked end to end.

## Leak check

`npx tsx scripts/leak-check.ts` runs over every committable file (`git ls-files --cached --others --exclude-standard`; 90 files):

- **Other speakers' text:** every 5-word shingle of every non-wearer utterance in the live Bee data, held in memory only. Shingles that also occur in the wearer's speech, or that consist only of function words, are excluded.
- **Address tokens** from conversation locations.
- **Token-shaped strings:** the bee token is a JWT, so the check looks for JWT-shaped strings and `Bearer …` headers.

Result: **PASS**. No committable file contains another speaker's text, an address token or a token-shaped string. The only wearer-text hit at the time was a generic French phrase in a detector regex; this report has since dropped its excerpts.

An earlier run caught a real bug: the `real/` ignore rule also matched `src/real/`. It is now anchored as `/real/`.
