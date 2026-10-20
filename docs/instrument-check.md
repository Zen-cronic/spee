# Instrument check: Bee and meeting captions on the same meeting

Bee is the input of record for the pre-registered check: it counts Bee conversations only. Meeting captions (Google Meet, exported by a caption tool) are another transcriber of the same speech, so `npm run instrument:check` compares the two whenever Bee heard a captioned meeting. It counts both with the hub's own habit rules (the same counter the stats use), prints counts, rates per 100 words and 95% intervals, and never prints text.

## How a meeting is paired with Bee

- The meeting's window runs from the captions' start to their end (the caption timeline's duration, or its last line). Every Bee conversation whose own start and end overlap that window is used, so a meeting that Bee split in two is compared whole.
- Bee's lines are cut to the window, so talk before or after the meeting in the same Bee recording is left out. A Bee line is compared with one meeting at most.
- When an end time is missing on either side, the overlap cannot be checked. The check then falls back to the Bee conversation that starts nearest the meeting, within 45 minutes, and says so: this match is weaker.
- A meeting is skipped, with the reason printed, when either side has no English lines of yours: for example when `npm run meetings` was given a `--wearer` spelling that matched no caption speaker.

## Result on real data (one meeting: the 2026-10-19 weekly stand-up)

Rechecked on 2026-10-20 with the overlap pairing, which cuts Bee's lines to the meeting's start and end: the counts are unchanged, because the Bee recording and the meeting covered the same span. Starting over (the control) read 4 in captions and 9 in Bee (0.59 against 1.29 per 100; intervals overlap).

| One meeting | Captions | Bee |
|---|---|---|
| your words | 677 | 699 |
| unsure words per 100 | 1.62 | 1.57 |
| filler "like" per 100 | 5.47 | 5.44 |
| "you know" per 100 | 1.03 | 1.14 |
| "um" / "uh" per 100 | 4.73 | 6.72 |
| all filler words per 100 | 11.23 | 13.30 |

Counts and 95% intervals behind two of those rows (one meeting):

| One meeting | Captions | Bee |
|---|---|---|
| unsure words | 11 times, 0.81 to 2.91 per 100 | 11 times, 0.78 to 2.82 per 100 |
| "um" / "uh" | 32 times, 3.23 to 6.67 per 100 | 47 times, 4.94 to 8.94 per 100 |

## What it means

- On this one meeting, unsure words came out alike (11 against 11) and filler "like" nearly alike (5.47 against 5.44 per 100). With counts this small, the intervals are wide (about half the rate either way), so that is consistent with captions being a fair second source for the practised habits, not proof of it.
- On this one meeting, captions showed fewer "um" and "uh" (4.7 against 6.7 per 100), but the intervals overlap, so one meeting does not show a real gap. If there is one, it could be captions leaving fillers out, or Bee adding some (another voice labelled as yours). A before and after that mixed the two could still show a drop in filler words that is only the transcriber, which is why the pre-registration keeps Bee as the one instrument and captions appear only with `source=all`.
- With `source=all`, a meeting that Bee also heard counts once, so the same speech is not counted twice: from Bee when Bee heard most of it (its caption session is left out), else from the captions (Bee's lines inside the meeting are left out).
- Rerun the check whenever another meeting is both captioned and heard by Bee.

## On the TV and in the hub

- `GET /api/instrument` runs the same pairing over the sessions the hub has loaded and returns aggregates only: pooled rates per habit, whether the two transcribers agree within a small tolerance, and a claim (`docs/CONTRACT.md`). Its note says how many pairs were matched by start time only.
- Progress shows, under the Bee-only cards, a secondary "Including meeting captions" line: the same before and after from `GET /api/transfer?source=all`, for the practised habits and the one you didn't practise, with the number of captioned meetings it counts and the earliest date (a meeting Bee also heard counts as Bee's, not as a captioned meeting). It says "not the pre-registered check", leaves filler words out, and says that captions and Bee agree only when `/api/instrument` finds the practised habits within tolerance.

## Run it

```bash
npm run meetings -- --wearer "<your name as the captions show it>" <transcripts...>   # wearer lines only
npm run instrument:check            # or -- --json (counts, rates and intervals; ids, never text)
```
