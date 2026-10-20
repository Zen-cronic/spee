# Instrument check: Bee and meeting captions on the same meeting

Bee is the input of record for the pre-registered check: it counts Bee conversations only. Meeting captions (Google Meet, exported by a caption tool) are another transcriber of the same speech, so `npm run instrument:check` compares the two whenever a meeting overlaps a Bee conversation. It counts both with the same habit rules and prints aggregates only, no text.

## Result on real data (2026-10-19 weekly stand-up)

| Same meeting | Captions | Bee |
|---|---|---|
| your words | 677 | 699 |
| unsure words per 100 | 1.62 | 1.57 |
| filler "like" per 100 | 5.47 | 5.44 |
| "you know" per 100 | 1.03 | 1.14 |
| "um" / "uh" per 100 | 4.73 | 6.72 |
| all filler words per 100 | 11.23 | 13.30 |

## What it means

- The two practised habits, unsure words and filler "like", read the same on both transcribers. Captions are a fair second source for them.
- Captions drop about 30% of "um" and "uh". A before/after that mixed captions and Bee would show a drop in filler words that is only the transcriber. That is why the pre-registration keeps Bee as the one instrument; captions appear only with `source=all`.
- This is one meeting. Rerun the check whenever another meeting is both captioned and heard by Bee.

## Run it

```bash
npm run meetings -- --wearer "<your name as the captions show it>" <transcripts...>   # wearer lines only
npm run instrument:check            # or -- --json
```
