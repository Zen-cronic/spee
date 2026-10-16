# Speaking principles (generic default)

This is the default rubric the coach uses when `coach/principles.local.md` does not exist. It is generic and written for this project. To use your own notes, copy this file to `coach/principles.local.md` (gitignored), rewrite it in your own words, and keep the JSON block at the end. The coach reads that file at runtime only: its text is never served, logged or committed.

Each section says what can be measured and by which input:

- **Bee** (the wearable, all day): the words, line timing and speaker tags. It stores no audio.
- **The phone mic** (practice takes only): volume and pitch as well.

## Rate

Speak at a pace listeners can follow, and slow down for the point that matters.

- **Bee:** words per minute, from each line's start and end. The wearer's usual rate is the baseline.
- **Phone:** a syllable-rate estimate, every 100 ms.
- **Watch for:** a sustained rate well above your baseline, especially while explaining something new.

## Volume

Be heard at the back of the room without pushing.

- **Bee:** nothing (no audio is kept).
- **Phone:** RMS level in dBFS, the share of time spent quiet or loud, and how often the ends of sentences drop away.
- **Watch for:** trailing off at the end of a sentence, and a level that stays at the bottom of the band.

## Melody and pitch

Let pitch move with meaning; a flat line sounds unsure or bored.

- **Bee:** nothing (no audio is kept).
- **Phone:** the pitch track (70 to 400 Hz) and its range in semitones over the last 5 seconds.
- **Watch for:** a range under about 3 semitones for long stretches (monotone), and a rise at the end of a statement that turns it into a question.

## Tonality

Match the tone to the message: calm for bad news, warm for thanks, firm for a decision.

- **Bee:** nothing directly. Word choice is a weak proxy at best.
- **Phone:** pitch range and volume together (a practice take only).
- **Watch for:** the same tone for every kind of message.

## Pause

A pause before the key point gives it weight; silence is better than a filler.

- **Bee:** gaps between and inside the wearer's lines, from Bee's timing.
- **Phone:** pauses of 250 ms or more, their count per minute and the longest one.
- **Watch for:** no pauses at all in a long answer, and pauses filled with "um", "uh" or "like".

## Clarity: hedges

Say what you think. Hedges ("I guess", "kind of", "maybe", "I think" used as a cushion) weaken a clear statement.

- **Bee:** hedges per 100 words, and streaks within 2 minutes against your usual rate.
- **Phone:** the same, from the practice transcript (provisional).
- **Watch for:** several hedges in a row, and a hedge in front of a decision or a status.

## Clarity: vague answers

Name the thing. "That thing", "getting there" and "and stuff" make the listener guess.

- **Bee:** vague phrases per 100 words.
- **Phone:** the same (provisional).
- **Watch for:** a status with no concrete state, or a placeholder where a name belongs.

## Turn-taking and monologue length

Leave room for the other person, and check in before a long explanation runs on.

- **Bee:** the length of each run of wearer lines (monologue) and the wearer's share of the words. Other speakers are counted, never quoted.
- **Phone:** nothing (a practice take has one speaker).
- **Watch for:** a single turn longer than about 90 seconds, and a talk share far above half in a two-person conversation.

## Thresholds

Packet A reads this block (`CoachThresholds` in `src/hub/contract.ts`). Keep the keys if you edit the numbers.

```json
{
  "version": 1,
  "rate": { "wpmSlow": 110, "wpmFast": 175, "fastRateNudge": false },
  "pause": { "minPauseMs": 250, "longPauseMs": 2000 },
  "volume": { "quietDbfs": -35, "loudDbfs": -12 },
  "pitch": { "minHz": 70, "maxHz": 400, "monotoneSemitones": 3 },
  "hedges": { "streakMin": 3, "windowMs": 120000, "expectedMultiplier": 2 },
  "like": { "streakMin": 4, "windowMs": 120000, "expectedMultiplier": 2 },
  "monologue": { "nudgeMs": 90000 },
  "recap": { "minWearerWords": 60, "momentMaxWords": 12, "idleEndMs": 90000 }
}
```
