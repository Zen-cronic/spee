# Speaking Mirror: a realtime speaking coach on Bee

Bee hears you say "I guess" four times in two minutes, and about 20 seconds later your wrist buzzes. When the conversation ends you get a recap. When you practise, you re-say the line to Alexa or your phone, and the attempt is graded from **Bee's own wearer-tagged transcript**, not from the mic you said it into. The Fire TV "Speaking Mirror" shows your week, the live pipeline and the before/after check.

- **Bee is the input of record.** Habits come from Bee captures, live nudges from `bee stream`, and every drill grade from the line Bee tags as you. Phone and Alexa text is only a provisional preview; if they disagree, Bee wins.
- **AI finds the habits; deterministic code grades and decides.** Hedges ("I guess", "kind of") and "like" are the hero habits; fillers, vague answers and restarts are tracked too.
- **Four surfaces, one hub:** the Apple Watch (Bee capture plus to-do alarms as wrist nudges), Alexa (a custom skill and an MCP server, with a browser simulator), Fire TV (a Vega app) and a phone page (drills and practice meters).

## Start here (no accounts, no keys, about 2 minutes)

```bash
npm run setup          # installs the hub and the web TV
npm run demo           # builds the pages and starts the hub with SYNTHETIC data and a Bee event replay
```

Then open:

- **TV:** http://localhost:8791/tv/ (arrow keys and Enter move along the tabs);
- **Alexa+ simulator:** http://localhost:8791/sim/ (a real MCP client: type or say "quiz me", repeat the sentence, then "how did I do?");
- **Phone:** scan the TV's QR from a phone on the same Wi-Fi.

`npm run demo:replay` prints the whole live story with its latency hops, with no Bee, Watch or AWS. The Fire TV app builds with `npm run tv:vega:build` and runs on the Vega Virtual Device (`docs/tv.md`).

Everything the demo shows is labelled **SYNTHETIC DEMO DATA** on screen. With a Bee account, `npm run hub` runs the same surfaces on your real data.

## What we'll tell you before you find it

- **Demo mode replays Bee.** `npm run demo` replays recorded-shape Bee events; the "verified by Bee" step there is the replay, and the screens say so.
- **Latency is set by Bee.** A tagged line reaches the hub about 5.4 s (median; range 4.3 to 14.7 s) after you stop speaking, measured on our Watch. A wrist nudge therefore lands about 17 to 20 s after the line that triggered it, and a voice drill takes two turns, because an Alexa reply must come within 8 s.
- **The Watch buzzes only while Bee is recording and the iPhone is locked.** Otherwise the alarm shows on the iPhone (iOS notification mirroring).
- **The before/after check is pre-registered but young.** `prereg/transfer.json` fixed the drilled habits (hedges and "like") and an undrilled control (restarts) before the first drill. `GET /api/transfer` says "not drilled yet", "too little data" or "no change" until real speech after the drills shows a drop, and it says so when the control dropped too.
- **Alexa+ third-party add-ons are partner-gated**, so the Alexa surface is a classic custom skill (tested in the Alexa iPhone app) plus an MCP server any MCP client can use; `/sim/` is that client in a browser, with a keyword router standing in for Alexa+'s model.
- **No audio is stored by Bee**, so tone and pitch exist only in phone practice mode; Bee-based coaching works from words and timing.

## Origin: the drill-coach proof of concept

A time-boxed go/no-go PoC for a deliberate-practice speech coach built on Bee data. It finds the wearer's real recurring speech errors and turns them into drill cards: the exact line, a correction, and a re-say prompt. It schedules the cards with a Leitner box and checks re-performance in later recordings against a pre-registered undrilled control. It covers English stand-up updates (hedges, vague status, missing ETAs, buried blockers) and French at high A2 / low B1 (auxiliary choice, gender, depuis + tense, prepositions, contractions, anglicisms).

It now runs on **real Bee data** (an Apple Watch running Bee, Developer Mode, `bee` CLI). Real data never enters a tracked file: see "Privacy design" below. Read `REAL_DATA_REPORT.md` for the real-data results and the current verdict. `POC_REPORT.md` is the historical mock-data run.

**All Bee data committed to this repository is SYNTHETIC.** The fixtures under `fixtures/verbatim`, `fixtures/cleaned` and `fixtures/synthetic` were authored by a simulator (`src/sim/`) or by hand, in the exact JSON shapes of the Bee CLI. The mock run's hidden ground truth is in `fixtures/_truth/`.

## Coach hub (shared core for the TV mirror and the Alexa drill session)

The hub is the single state behind every surface: a Fire TV "speaking mirror" (habit rates, the drilled-vs-control transfer chart, live sync) and an Alexa+ drill session (next card, re-say it, graded, schedule updated). Its contract, with example payloads for every endpoint and event, is [`docs/CONTRACT.md`](docs/CONTRACT.md).

```bash
npm run hub                     # live: real gitignored data, spawned `bee stream`, Bee CLI fallback poll (port 8791)
npm run hub -- --demo           # demo: SYNTHETIC fixtures + Bee event REPLAY (no Watch, no network), labelled as such
npm run contract:check          # starts the demo hub; TV + phone over the bridge + SSE; asserts the event sequences
npm run hub:cards               # adds deterministic hedge / "like" cards from your own Bee lines to real/deck.json
npm run demo:fixtures           # regenerates fixtures/demo/ (deterministic)
```

- **Bee is the input of record.**
  - Habits, drills and stats come from Bee captures. Meeting captions are a secondary source, used only with `source=all` and always labelled.
  - In a drill, a phone or Alexa transcript is a provisional preview. The attempt counts when Bee's live stream tags the wearer saying it, and then Bee's text is graded. If the preview and Bee disagree, Bee wins.
  - With no tag on the stream within 30 s, the hub polls the conversation through the Bee CLI. With nothing by 45 s, the attempt is "unverified" and does not count.
  - A voice drill takes two turns, because Bee's line takes 5 to 20 s and a voice skill must answer within 8 s. `POST /api/attempt` returns `pending_bee` at once, and `GET /api/attempts/<id>` returns Bee's verdict once it lands. A Bee line merged with the next words ("... How did I do?") is matched by coverage, and the extra sentence is cut before grading.
- **AI finds the habits; code grades the attempt.** `src/hub/grade.ts` is deterministic and gives a reason for every rule:
  - the target habit occurs 0 times;
  - 0 fillers;
  - at least 80% of the target sentence is matched, with fuzzy word matching for ASR slips ("car" for "card", "rec board" for "rack board");
  - every concrete word the fix introduces is said.
- **Hero habits.** Hedges ("I guess", "kind of") and vague answers ("that thing", "getting there", "and stuff"). Fillers support them, and restarts are the control.
- **Transfer.** `GET /api/transfer` asks whether a drilled habit dropped in later non-drill real speech, compared with a control habit that was deliberately not drilled. It reports rates per 100 words with 95% intervals, before vs after the first drill, and a plain verdict.
  - The drilled and control habits are pre-registered in `prereg/transfer.json` (written 2026-10-16, before any drill attempt).
  - The endpoint refuses to report an unregistered habit as drilled.
- **Privacy.** Stream text stays in memory until Bee tags it as the wearer. Untagged and other-speaker lines are never sent to a surface or written to disk.
- **Phone microphone.** It uses `@rackboard/tv-voice-bridge`, vendored as `vendor/rackboard-tv-voice-bridge-0.2.0.tgz`.

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

## Privacy design

Real transcripts contain other people's speech (classmates, friends, assistants).

- **Wearer-only persistence.** `loadRealCorpus` returns the wearer's lines (the only thing ever written to disk) and, separately, an in-memory `TransientContext` of other speakers' lines. That context is never serialized; it exists only so an LLM prompt can see the reply to a "how do you say X?" moment, and the prompt tells the model not to quote it. Error extraction prompts contain wearer lines only. `test/real.test.ts` enforces this: a planted other-speaker string must not appear in the corpus, the analysis or the class report.
- **Gitignored outputs only.** Real data goes to `real/`, `out/`, `cache/`, `fixtures/private/` and `day1/*.json`, all gitignored. Tracked reports carry aggregates plus at most 10 short (≤ 12 words) excerpts of the wearer's own lines.
- **Leak check.** `scripts/leak-check.ts` searches every committable file, of any size, for 5-word shingles of other speakers' live utterances (held in memory), their whole 3-4 word lines, location address tokens and JWT-shaped tokens. JSON escapes are undone first. It also screens:
  - optional `bee stream` captures (`--stream`): untagged lines count as other speakers;
  - optional meeting transcripts (`--wearer "<name>" --tactiq <file>`).

  Only lines a source labels as the wearer count as the wearer's; the hub's own state (`real/hub-attempts.json`, `real/live/`) is screened for other-speaker text, never used as an allow-list. A committable audio file fails the check, and so does a committable image until a person has looked at it and recorded it with `--approve-images` (`leak-check-images.txt`, pinned by sha256; screenshots can show drill or live text). A hit in a file dated before the recording is "predates", not a leak; the date comes from git, not the mtime (a copy can keep an old mtime), and files written before the repo existed are vouched for once with `--approve-predates` (`leak-check-predates.txt`). It also fails if any private output path (`real/`, `out/`, `cache/`, the hub's state files) is not git-ignored.
- The bee token is never read, printed or stored by this code; the CLI handles auth.

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

## Layout

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
- `src/hub/`: the coach hub. It holds:
  - the grader (`grade.ts`, `fuzzy.ts`);
  - habits (`habits.ts`);
  - cards and the scheduler (`cards.ts`, `scheduler.ts`, `realCards.ts`);
  - Bee stream parsing and attempt verification (`bee.ts`);
  - stats and transfer (`stats.ts`);
  - the brief (`brief.ts`);
  - state (`core.ts`);
  - the live and demo wiring (`setup.ts`) and the synthetic demo data (`demoData.ts`);
  - the server (`server.ts`).
- `docs/`: `CONTRACT.md` (the hub contract) and `contract-examples.json` (generated example payloads, synthetic).
- `fixtures/demo/`: synthetic demo fixtures for the hub.
- `prereg/transfer.json`: the transfer pre-registration.
- `scripts/`: `real.ts`, `class.ts`, `meetings.ts`, `score-meetings.ts`, `score-day1.ts`, `score-mislabel.ts`, `review.ts`, `leak-check.ts`, `contract-check.ts`, `hub-cards.ts`, `build-demo-fixtures.ts`.

## Private data

`fixtures/private/` (gitignored) may hold the operator's real, confidential transcripts. They are used only for the real-speech check (T6). Their text is written only to `out/` and `cache/`, which are also gitignored. It never goes into the report, the fixtures, or this README.

## License

MIT. See `LICENSE`.
