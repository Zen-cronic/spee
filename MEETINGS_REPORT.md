# English communication coaching on meeting captions: method

`npm run meetings` runs the English coach on caption transcripts of the operator's own video meetings (Google Meet live captions exported by Tactiq). This is a different ASR from Bee.

**What is published.** This file describes the method only. The per-meeting results stay in the gitignored `out/meetings*.{md,json}`: they describe the operator's work meetings, so their dates, lengths, head counts and per-meeting numbers are not in the repository. The one meeting the public docs cite is the 2026-10-19 stand-up that Bee also heard, compared word for word in [`docs/instrument-check.md`](docs/instrument-check.md) (`FACTS.md` and the README quote those numbers).

**Privacy.** The transcripts stay outside the repository and are read from their paths at run time. Only the operator's own lines are persisted, and only to gitignored `real/meetings.json` and `out/meetings*.{md,json}`. Other speakers contribute counts only: lines, words and start times. Their text, their names and the meeting title are never persisted.

## Method

- **Ingest** (`src/real/tactiq.ts`). Parses the header (start time, duration, participant count) and the `## Transcript` section.
  - The `## Highlights` section repeats transcript lines, so it is skipped.
  - Without a Transcript section, the parser de-duplicates same-speaker, same-second lines, including truncated repeats.
  - Wrapped caption lines are joined.
  - The wearer is the speaker named by `--wearer`, matched case- and space-insensitively and never hard-coded. Only those lines become corpus lines (`kind: "meeting"`).
  - Meetings get neutral ids (`meet-YYYY-MM-DD`).
  - Meet attributes each caption to a participant's own audio stream, so Bee's mislabel detector (built for one shared microphone) is not applied.
- **Deterministic metrics** use the same English filler list (um, uh, filler-position "like", "you know") and hedge list as the Bee pipeline (`src/real/text.ts`).
- **Talk habits** (`src/real/talk.ts`):
  - talk share by words, and by time estimated from caption start times;
  - turns: consecutive caption lines by the operator are merged into one turn;
  - substantive turns (10 words or more) and backchannels (3 words or fewer);
  - average turn length and the longest monologue;
  - restarts, counted with um/uh ignored (so "the, uh, the" is one restart);
  - vague tags ("and stuff", "or something");
  - "and yeah" / "so yeah" tics, and turns that end on yeah/so/and;
  - a per-sentence classification: question, tag question, "uptalk" (a "?" on a statement) and trailing-off (a sentence abandoned on a function word).
- **Error and clarity funnel.** It reuses the existing path:
  1. Haiku 4.5 extracts candidates against the English taxonomy, with the LLM ASR guard (one call per meeting).
  2. A grounding check runs.
  3. Sonnet 4.5 verifies the survivors.
  4. A deterministic **glossary guard** quarantines any item whose excerpt or correction contains a known misheard term, from a private list in the gitignored `fixtures/private/`.
  5. The survivors become drill cards, plus filler drills from the densest lines.
- **Labelling sheet:** `out/meetings-label-sample.md` lists the kept drills and a seeded sample of filler and hedge hits. Mark each entry R (real habit worth coaching), T (transcription artifact) or N (real but not worth coaching); `npm run meetings:score` prints precision and the artifact rate.

## What carried over to Spee

- **ASR noise is the binding constraint here too.** About half of the LLM candidates quoted a misheard name and were quarantined, as on Bee.
- **"like" and um/uh both survive captions,** so the filler habits can be compared across the two transcribers. `docs/instrument-check.md` does that on the one meeting both heard.
- **Captions are a secondary source.** The pre-registered check counts Bee only; captions appear only with `source=all`, labelled.

## Limits

- **Captions, not audio.** Punctuation is the captioner's guess, and lines are caption chunks of up to about 45 s. That makes question, uptalk and trailing-off counts approximate, and sentence boundaries unreliable.
- **Product and tool names are often misheard.** The LLM guard and the glossary catch most of them, but a misheard name can still reach a re-say sentence.
- **A caption vs Bee comparison is confounded** by ASR and genre unless both heard the same meeting.

## Reproduce

```bash
npm run meetings -- --wearer "<your name as the captions show it>" [--glossary <misheard-terms.json>] <transcript.txt> ...
npm run meetings:score     # after marking out/meetings-label-sample.md
npx tsx scripts/leak-check.ts --wearer "<name>" --tactiq <transcript.txt> ...
```

## Leak check

`scripts/leak-check.ts` also accepts the meeting transcripts (`--tactiq`, paths on the command line only). It adds every other speaker's 5-word shingles, colleagues' name tokens and the meeting title (minus generic words) to the search, all held in memory. A shingle made only of filler and function words is not counted, and a hit in a file last modified before the source recording started is reported as "predates" and does not fail.
