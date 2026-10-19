# The drill-coach proof of concept (history)

Speaking Mirror grew out of this time-boxed proof of concept. Everything below still runs; the live coach, the TV, Alexa and MCP are in the [README](../README.md).

## What it was

A time-boxed go/no-go PoC for a deliberate-practice speech coach built on Bee data. It finds the wearer's real recurring speech errors and turns them into drill cards: the exact line, a correction, and a re-say prompt. It schedules the cards with a Leitner box and checks re-performance in later recordings against a pre-registered undrilled control. It covers English stand-up updates (hedges, vague status, missing ETAs, buried blockers) and French at high A2 / low B1 (auxiliary choice, gender, depuis + tense, prepositions, contractions, anglicisms).

It now runs on **real Bee data** (an Apple Watch running Bee, Developer Mode, `bee` CLI). Real data never enters a tracked file: see "Privacy design" in the README. Read `REAL_DATA_REPORT.md` for the real-data results and the current verdict. `POC_REPORT.md`, the historical mock-data run, is not in the repository: it is written locally by `npm run poc`.

**All Bee data committed to this repository is SYNTHETIC.** The fixtures under `fixtures/verbatim`, `fixtures/cleaned` and `fixtures/synthetic` were authored by a simulator (`src/sim/`) or by hand, in the exact JSON shapes of the Bee CLI. The mock run's hidden ground truth is in `fixtures/_truth/`.

## Real-data mode

Prerequisites: `bee` CLI authenticated (`bee status`), AWS profile `hackathon-1` with Bedrock access.

```bash
npm run real                                        # all conversations: wearer filter, mislabel check, analysis, drills
npm run day1                                        # kill test 2: score the newest voice note (add --wait, --id <id>, --analyze)
npm run class -- --since 2026-10-15T18:00-04:00 --wait   # after class (and after the debrief voice note)
npm run review                                      # drills due today/tomorrow; `-- --done <cardId>` after re-saying one
npm run mislabel:score                              # after labelling out/mislabel-sample.md
npx tsx scripts/leak-check.ts                       # committable files: no other-speaker text, address or token
npm run leak-check -- --stream <bee-stream.log>     # also screen a `bee stream --json` capture
BEE_SOURCE=cli npx vitest run test/contract.test.ts # live contract test against the real CLI
```

How it works:

1. **Wearer filter** (`src/real/wearer.ts`). Bee's final transcripts label the wearer's utterances with their profile name and everyone else "Unknown". The labels are discovered from `bee me` (first/last name) plus label frequencies, never hard-coded (`BEE_WEARER_LABELS` overrides). A still-CAPTURING conversation has only a realtime transcript with no labels; it is skipped with a warning.
2. **Mislabel detector** (`src/real/mislabel.ts`). It flags wearer-labelled lines that look like media or an assistant: assistant phrasing, narration, fluent disfluency-free long lines, time overlap with another wearer line, and runs of these. Flagged lines are "uncertain" and never drilled. `out/mislabel-sample.md` is a blind labelling sheet; `npm run mislabel:score` computes precision and recall from your labels.
3. **Analysis** (`src/real/analyze.ts`). It covers:
   - per-utterance language (fr / en / mixed);
   - filler rates per 100 words per language (FR um/uh/euh/ben/bah; EN um/uh/like/you know) and hedge rates;
   - Haiku extraction of French grammar/lexical and English communication errors, with the ASR guard;
   - a **Sonnet verification pass** that drops ASR artifacts, fragments and invented corrections;
   - **code-switch vocabulary** ("comment on dit …?" becomes "say it in French");
   - filler drills.

   Every drill cites the real utterance id and quotes the wearer's line.
4. **Deck** (`src/real/deck.ts`). A Leitner deck in `real/deck.json`: new cards are due tomorrow, a card relapses when its error type recurs, and it is promoted when you mark it re-said.

LLM calls are sequential with exponential backoff on throttling, and cached in `cache/`. Only `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and `openai.gpt-oss-120b-1:0` can ever be invoked (`ALLOWED_MODELS` in `src/llm/bedrock.ts`). Any other model in a chain is skipped, because invoking another third-party model can auto-accept a paid Marketplace offer.

## Meetings mode (English communication coaching)

The coach also runs on video-meeting caption transcripts (Tactiq exports of Google Meet captions), as an English communication benchmark. Read `MEETINGS_REPORT.md` for the results.

```bash
npm run meetings -- --wearer "<your name as the captions show it>" [--glossary <misheard-terms.json>] [--no-llm] <transcript.txt> ...
npm run meetings:score   # after marking out/meetings-label-sample.md (R / T / N per entry)
npx tsx scripts/leak-check.ts --wearer "<name>" --tactiq <transcript.txt> ...   # also screens committable files against the meetings
```

- **Ingest** (`src/real/tactiq.ts`). Only the `--wearer` speaker's lines become corpus lines (`kind: "meeting"`). The Highlights section, which repeats transcript lines, is skipped. Other speakers contribute counts only (lines, words, start times); their text, their names and the meeting title are never persisted. Meetings get neutral ids (`meet-YYYY-MM-DD`). Keep transcripts outside the repository.
- **Metrics.** The same English filler and hedge lists, plus talk habits (`src/real/talk.ts`):
  - talk share;
  - turns and the longest monologue;
  - restarts;
  - vague tags;
  - "and yeah" tics;
  - questions, uptalk and trailing-off sentences.
- **Funnel.** The existing candidate → LLM ASR guard → Sonnet verifier → drill path. An optional glossary of known misheard terms (`applyGlossary`) quarantines items that would coach a mishearing.
- **Outputs** (all gitignored):
  - `real/meetings.json`;
  - `out/meetings.md` (private report);
  - `out/meetings-summary.json` (aggregates);
  - `out/meetings-label-sample.md` (labelling sheet).

## Mock PoC (historical)

The mock-data run is superseded by `REAL_DATA_REPORT.md`. To reproduce it locally, run `npm run poc` (below); it writes `POC_REPORT.md` and `out/report.html`, which aren't tracked.

## Run the mock PoC

```bash
npm install
npx vitest run        # contract, source, simulator, coach, isolation, metrics, real-data and Day-1 tests
npm run poc           # writes POC_REPORT.md and out/report.html
```

`npm run poc` runs these steps in order:

1. Build the pre-cutover world (up to 2026-10-06).
2. Analyze it.
3. Pre-register a seeded 50/50 drilled/control split in `prereg/`.
4. Build the post-cutover world, conditioned on that split. Coaching can only affect later speech.
5. Analyze everything in both variants.
6. Score against the truth key.

LLM responses are cached in `cache/`, keyed by a hash of the prompt, so reruns are deterministic and free. A fresh run makes about 70 Bedrock calls and takes about 4 minutes.

LLM: Amazon Bedrock `Converse` (non-streaming), AWS profile `hackathon-1`, region `us-east-1`, forced tool use plus zod validation. The model chain is `us.anthropic.claude-haiku-4-5-20251001-v1:0`, then `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, then `openai.gpt-oss-120b-1:0`. The chain string still names `qwen.qwen3-next-80b-a3b` so the mock run's cache keys stay valid, but it is never invoked (allowlist). Override it with `LLM_MODEL_CHAIN`. On 2026-10-14 the Anthropic models were gated by the account's "Anthropic use case details" form, so every result came from `openai.gpt-oss-120b-1:0`. Nova is deliberately excluded because it fails tool-use structured output. Once the form is submitted, rerun with `rm -rf cache prereg && npm run poc`.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `BEE_SOURCE` | `mock` | `mock` reads fixtures; `cli` shells out to the `bee` CLI |
| `BEE_FIXTURE_VARIANT` | `verbatim` | fixture variant for `makeSource()` |
| `BEE_BIN` | `bee` | path to the Bee CLI |
| `BEE_WEARER_LABELS` | unset | comma-separated speaker labels to treat as the wearer (overrides discovery) |
| `BEE_TZ` | `America/Toronto` | time zone for deck dates and class report names |
| `ASR_GUARD` | on | set `0` to disable the ASR-mishearing guard |
| `PREREG_FORCE` | unset | `1` allows re-registering a split on changed evidence (disclose it) |

## The BeeSource seam

`src/bee/source.ts` defines a single interface:

```ts
interface BeeSource {
  conversations(sinceMs: number): Promise<ConversationSummary[]>;
  conversation(id: number): Promise<ConversationDetail | null>;
  voiceNotes(sinceMs: number): Promise<Journal[]>;
}
```

- `MockBeeSource` reads the fixtures. It applies two Bee behaviours the mock assumed: conversations under 50 words are deleted, and every `speaker` is forced to `"Unknown"` (bee-cli issue 19). Real data overturned the second: final transcripts label the wearer.
- `CliBeeSource` shells out to `bee conversations list|get --json`, `bee journals list|get --json` and `bee me --json`, with pagination. **Verified 2026-10-15** against the production API (`@beeai/cli` 0.8.0); the live contract test passes. The schemas were written against bee-cli @84a6e8fcb955a66fc15da63ce4c50289591959ec.
- The zod schemas in `src/bee/schemas.ts` mirror the bee-cli types. `test/contract.test.ts` validates every fixture against them. With `BEE_SOURCE=cli` it also validates live CLI output. That is the Day-1 contract check on real hardware.

The analyzer reads the raw voice-note `text`, never `aiResponse.cleanedUpText`, because Bee's AI clean-up would erase the very errors being coached.

## Layout of the PoC code

- `src/bee/`: schemas, the source seam, and the private real-transcript adapter.
- `src/analyze/`: session loading, lexical metrics, the language router, the taxonomy, and LLM extraction plus the generic baseline.
- `src/coach/`: the pre-registered split, drill cards, and the Leitner schedule driven by re-performance.
- `src/sim/`: synthetic world templates and the generator. The analyzer never imports it.
- `src/eval/`: scoring against the truth key. It is the only reader of `fixtures/_truth/`, which `test/isolation.test.ts` enforces.
- `src/report/`: the report and HTML rendering.
- `src/real/`: the real-data path. It holds:
  - the wearer filter;
  - the mislabel detector;
  - language and lexicon;
  - analysis;
  - the Day-1 scorer;
  - the deck;
  - renderers;
  - the meeting-transcript ingest (`tactiq.ts`), talk habits (`talk.ts`), the meetings benchmark (`meetings.ts`) and its labelling sheet (`meetingLabels.ts`).
