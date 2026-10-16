# Coach hub contract (v1)

The coach hub is the one shared state behind every surface:

- **Fire TV "speaking mirror"** (phase 2). It shows the week's habit rates, the drilled-vs-control transfer chart, and live sync: an attempt, then "graded", then "verified by Bee", then the numbers update. It also mirrors the drill that Alexa is running.
- **Alexa+ drill session** (phase 3, MCP server over Streamable HTTP plus a web simulator). It runs drills by voice: next card, the user re-says it, the attempt is graded, and the schedule is updated.
- **Phone** (optional): a fast microphone through the tv-voice-bridge WebSocket.

Every example payload below comes from the demo hub (`npm run contract:check -- --write-examples` writes the full set to [`contract-examples.json`](contract-examples.json)). Long payloads are trimmed where marked `...`. Ids and `at` timestamps change on every run. Demo data is **synthetic** and every payload says so in `dataLabel`.

## Ground rules

1. **Bee is the input of record.**
   - Habits, drills and stats come from Bee (Apple Watch) captures. Meeting caption transcripts are a secondary source: they are included only with `source=all` and are always labelled.
   - In a drill, the attempt that counts is the wearer-tagged utterance from Bee's live stream.
   - Text from the phone or Alexa is only a **provisional** preview, graded instantly so a surface can react. It never moves the schedule.
   - When Bee's text arrives, it is graded, and that **final** grade is what counts. If the preview and Bee disagree, Bee wins (`agreement: "bee-overrules"`).
2. **AI finds the habits; code grades the attempt.** Grading is deterministic: no model call, and the same card plus the same text always give the same verdict, with stated reasons (`grade.reasons`, `grade.checks`).
3. **Privacy.** Only the wearer's lines are persisted. Stream text is held in memory until Bee tags it as the wearer with a speaker score of at least 0.5. Untagged lines and other speakers' lines are never sent to a surface or written to disk, and they are forgotten after 3 minutes.
4. **Labels.** `dataLabel` is on health, stats, transfer, brief and deck payloads. Demo mode says `"SYNTHETIC DEMO DATA (invented; not anyone's real results)"`, and Bee events in demo mode carry `replay: true`. Surfaces must show the label whenever `synthetic` is true.

## Running it

```bash
npm run hub                          # live: real gitignored data (real/), spawned `bee stream`, Bee CLI poll; port 8791
npm run hub -- --demo                # demo: synthetic fixtures (fixtures/demo/), Bee REPLAY, demo clock 2026-10-20 13:30 EDT
npm run hub -- --demo --pace 0.1     # Bee replay and timeouts 10x faster (5.4 s -> 0.54 s)
npm run hub -- --port 9000 --no-bee  # live without the stream (every attempt ends "unverified")
npm run contract:check               # the cross-surface check below
```

- Base URL `http://<host>:8791`. Override it with `--port` or `COACH_PORT`.
- CORS is `*`. Bodies are JSON.
- Errors are `{ "error": "<code>", "message": "..." }` with a 4xx status.
- `GET /api/health` returns `contractVersion: 1`.

## The attempt lifecycle (what a voice UI narrates)

```
card_open --(phone/Alexa text)--> pending_bee --(Bee tags the wearer)--> graded (counted)
                                      |                                   ^
                                      +--(no tag on the stream by 30 s)--> polling --(Bee CLI finds the wearer line)--+
                                                                               |
                                                                               +--(nothing by 45 s)--> unverified (not counted)
card_open --(Bee alone hears the wearer say the card)--> graded (agreement "bee-only")
```

| State (`GET /api/session` `.state`) | Narration (`.narration`) | Meaning |
|---|---|---|
| `idle` | "No drill is running. Start a session to get your first card." | no open card |
| `card_open` | `Say this: "<resay>"` | waiting for the user |
| `pending_bee` | "Got it. I'm checking with Bee, which takes 5 to 20 seconds. Ask me how you did in a moment." | preview graded; waiting for Bee's wearer-tagged line |
| `polling` | "Bee's live feed was quiet, so I'm checking your conversation directly." | stream timeout; fallback poll of the conversation through the Bee CLI |
| `graded` | "Bee heard it. That's a pass." / "Bee heard it. Not yet: <first failed rule>." | Bee's text graded; the schedule moved |
| `unverified` | "Bee didn't confirm that one, so it doesn't count. Try it again." | no Bee confirmation; the schedule is unchanged |

`GET /api/session` also returns `verdictReady` (true in `graded`/`unverified`) and `retryAfterMs` (when to ask again for a pending attempt).

### Two-turn voice drill (Alexa's 8 s limit)

On a real device (iPhone Alexa app, Canada, 2026-10-16), Bee's wearer-tagged line arrived **15 to 19 s** after the user spoke. Bee merged the drill sentence with the next words into one utterance, and an Alexa custom skill must answer within 8 s. So the drill is **asynchronous and takes two turns**:

1. **Turn 1.** The user says the card, and Alexa's skill sends its transcript with `POST /api/attempt {source:"alexa", text}`. The hub returns **202 at once** with `status: "pending_bee"`, `verdictUrl: "/api/attempts/<id>"`, `retryAfterMs` and `narration` ("Got it. I'm checking with Bee... Ask me how you did in a moment."). Alexa's transcript is kept as `provisional` only.
2. **Turn 2.** The user asks "how did I do?", and the skill calls `GET /api/attempts/<id>` (the verdict).
   - If `verdictReady` is true: narrate `narration` (Bee's final grade, or "didn't count").
   - Otherwise: narrate the waiting line and suggest asking again after `retryAfterMs`.
3. **TV.** The TV needs no polling: it gets `attempt.verified` and then `attempt.graded` over the WebSocket the moment Bee's line lands.

Bee may merge the attempt with what was said before or after it ("... from finance. How did I do?"). Matching therefore uses coverage, so extra words don't hurt. Before grading, whole sentences that contain no word of the target are cut. `attempt.bee.gradedText` is what was graded and `attempt.bee.extraText` is what was cut. A sentence that contains any target word is kept whole, so a habit inside it ("Um, the ...", "..., I guess.") is still graded. If Bee did not punctuate the merge, the whole line is graded.

Timings: measured live on 2026-10-16. A `new-utterance` arrives 4.3 to 14.7 s after the speaker stops (median 5.4 s), and `tagged-utterance` follows about 0.5 s later.

| Timing | Live value | Demo |
|---|---|---|
| Tag wait (a line without a tag after this counts as untagged) | 3 s | × pace |
| Stream timeout, then the first poll | 30 s after the end of speech | × pace |
| Second poll | 37 s | × pace |
| Give up: `unverified` | 45 s | × pace |
| Time-window slack (Bee `spoken_at` is to the second; device clocks differ) | ±8 s | 8 s |

**How a Bee line is matched to an attempt.**

1. The line must arrive (stream receive time) **after the card opened**, and must have been spoken no earlier than the opening minus the slack. Older lines never count for a newly opened card.
2. The line must be tagged as the wearer. The tag's `person_first_name` must match the Bee profile (`bee me`), or its `person_id` must be in `BEE_WEARER_PERSON_ID`, and `speaker_score` must be at least 0.5.
3. The line's spoken interval (from `spoken_at`, `start` and `end`), widened by the slack, must overlap the attempt's speech interval. That interval is the end of speech (the phone's `speech.end` hop, or the hub's receive time) minus the estimated duration (2.5 words per second, at least 1.5 s).
4. Its words must cover at least 60% (weighted) of the preview text (containment: extra words in Bee's line don't count against it), **or** at least 50% of the card's target sentence. If Bee split the attempt across lines, adjacent in-window wearer lines are joined.
5. A line can confirm only one attempt. When no preview is pending, a wearer line that covers at least 50% of a recently open card's target becomes a Bee-only attempt. Because Bee lags 5 to 15 s, the line goes to the best-matching card in its time window.

Duplicate stream events are ignored by utterance id. A tag that arrives before its utterance is held until the utterance arrives. The fallback poll reads the conversation through the Bee CLI and uses only wearer-labelled lines. A polled line already used for an attempt is never reused.

## Grader (`src/hub/grade.ts`, `graderVersion: 1`)

An attempt passes only if every rule holds. Each rule appears in `grade.checks` as `{ rule, ok, detail }`, and `grade.reasons` lists failed rules first.

| Rule | Passes when |
|---|---|
| `nonempty` | at least one word was heard |
| `habit` | the card's habit occurs **0** times beyond its occurrences in the target sentence itself. Hedge cards: the listed hedges (`i guess`, `kind of`...). Vague cards: any vague answer (`that thing`, `getting there`, `and stuff`...) plus the card's own excerpt. Filler cards: the listed fillers. Restart cards: an immediate repetition. French error and vocab cards: the original mistake or the English word |
| `fillers` | fillers beyond the target's own count ≤ **0**. The fillers are EN `um`/`uh`, filler-position `like` and `you know`; FR `um`/`uh`/`euh`/`ben`/`bah` |
| `content` | weighted recall of the target sentence's words ≥ **0.8**. Function words weigh 0.5 |
| `required` | every `mustSay` word was said: the concrete words the fix introduces, such as "invoice retry job" replacing "that thing" |

- **Fuzzy words.** Some ASR slips are accepted and listed in `grade.fuzzy`:
  - Edit distance on the word or on a light phonetic key ("car" ≈ "card", "rec" ≈ "rack"). The edit budget is 0 edits for 1 to 2 letters, 1 for 3 to 5 letters and 2 for 6 or more, and the first letter is fixed.
  - Compound joins ("rackboard" ≈ "rack board").
  - Normalization: contractions ("it's" = "it is"), digits 0 to 12 ("3" = "three") and French elisions.
- **Reported, not failing.** Every hedge heard is reported as `hedgeCount`/`hedges`; hedges fail the attempt only on a hedge card.

## Habits

Habit keys are used by stats, transfer and the pre-registration file:

`fillers | filler:<word> | hedges | hedge:<phrase> | vague | restart | trailing | yeah-tic`

**Hedges and vague answers are the hero habits.** Fillers support them. Restarts are the default control habit.

**Umbrella keys.** A drill on a targeted card counts toward both its specific key and its umbrella: an "I guess" card emits `hedge:i guess` and `hedges`, a "like" card emits `filler:like` and `fillers`. A specific key is covered by the pre-registration when its umbrella is registered, so with `hedges` registered an "I guess" drill is never listed as unregistered.

## HTTP endpoints

| Method and path | For | Purpose |
|---|---|---|
| `GET /api/health` | all | mode, labels, Bee feed status (`bee.counters`, `bee.replay`) |
| `GET /api/state` = `GET /api/session` | Alexa, TV | the voice-UI state above, open card, last attempt, current and last session summary |
| `POST /api/session/start` `{by?, size? (1-10, default 3)}` | Alexa | starts a drill session and opens the first due card |
| `POST /api/session/next` | Alexa | opens the next due card, or ends the session when `size` cards were counted or nothing is due: `{card, done, summary?}` |
| `POST /api/session/end` | Alexa | ends the session: `{summary}` |
| `POST /api/attempt` `{text, source: "phone"\|"alexa"\|"typed", cardId?, speechEndAt? (hub-clock ms)}` | Alexa, phone, typed | provisional attempt on the open card (or on `cardId`, which it opens). Returns **202** at once: `{attempt, narration, verdictUrl, retryAfterMs}` with `status: "pending_bee"` |
| `GET /api/attempts/<id>` | Alexa (turn 2) | **the verdict**: `{attempt, status, verdictReady, retryAfterMs, narration}` |
| `GET /api/attempts?limit=20` | TV | recent attempts, newest first |
| `GET /api/deck` | TV | `{summary, cards[], today}` |
| `GET /api/deck/next` | any | the card that "next" would open (does not open it), plus the open card |
| `POST /api/card/open` `{cardId?, by?}` | any | opens a card outside a session (practice; a card that is not due changes no box on a pass) |
| `GET /api/stats?range=today\|week\|all\|session:<id>\|meeting:<id>&source=bee\|all` | TV | habit rates per 100 words with 95% intervals, practice counts, drilled-vs-next-session glance |
| `GET /api/transfer?source=bee\|all&habit=<key>?` | TV, Alexa | the transfer result: drilled vs the pre-registered control |
| `GET /api/brief` | Alexa, TV | pre-meeting nudge: next calendar event (Bee today brief), top habit, one warm-up card |
| `GET /api/events` | Alexa simulator, TV web | Server-Sent Events: the same events as the WebSocket |
| `GET /api/events/recent` | debugging | the last 50 events |
| `POST /api/demo/scenario` `{scenario}` | demo only | the Bee replay scenario for the next attempt |
| `POST /api/demo/bee` `{text?}` | demo only | replay Bee hearing the wearer say the open card (no preview) |

Error codes:

- `no_open_card` (409)
- `unknown_attempt` (404)
- `unknown_card` (404)
- `nothing_due` (404)
- `bad_request` (400)
- `bad_range` and `bad_source` (400)
- `bad_habit` (400)
- `not_preregistered` (422)
- `no_prereg` (503)
- `demo_only` (400)
- `not_found` (404)

### `POST /api/session/start` (Alexa: "quiz me")

```json
// request
{ "by": "alexa", "size": 4 }
// 200
{
 "session": { "id": "ses_mvgyktyz000", "by": "alexa", "startedAt": 1792517400251, "endedAt": null, "size": 4, "cardIds": ["demo:vague-referent"], "attemptIds": [] },
 "card": {
  "id": "demo:vague-referent", "kind": "error", "lang": "en", "type": "EN_VAGUE_REFERENT",
  "habit": { "kind": "vague", "targets": ["that thing"], "label": "vague: \"that thing\"" },
  "said": "that thing", "fix": "the invoice retry job",
  "resay": "I fixed the invoice retry job this morning.",
  "why": "\"That thing\" makes listeners guess. Name it.",
  "mustSay": ["invoice", "retry", "job"],
  "box": 1, "due": "2026-10-20", "dueNow": true, "passes": 0, "fails": 0,
  "source": { "session": "demo-bee-1016", "key": "u:demo-bee-1016:0" }, "synthetic": true
 },
 "narration": "Say this: \"I fixed the invoice retry job this morning.\""
}
```

Card fields:

- `said` is what you said: an excerpt of your own Bee line.
- `resay` is the target sentence to say aloud.
- `mustSay` lists the words it must include.
- `source` is the Bee session and line it came from.

### `POST /api/attempt` (Alexa passes its transcript; the phone uses the bridge)

```json
// request
{ "text": "I fixed the invoice retry job this morning.", "source": "alexa" }
// 202
{
 "attempt": {
  "id": "att_mvgyktz3001", "cardId": "demo:vague-referent", "sessionId": "ses_mvgyktyz000",
  "status": "pending_bee", "counted": false, "createdAt": 1792517400255, "settledAt": null,
  "provisional": { "source": "alexa", "text": "I fixed the invoice retry job this morning.", "speechEndAt": 1792517400255,
   "grade": { "graderVersion": 1, "pass": true, "reasons": ["ok nonempty: 8 words heard", "ok habit: no vague: \"that thing\"", "ok fillers: no fillers", "ok content: content match 100% (needs 80%)", "ok required: said \"invoice\", \"retry\", \"job\""], "...": "..." } },
  "bee": null, "final": null, "agreement": null,
  "reason": "listening via Bee: waiting for the wearer-tagged line (typically 5-15 s)", "box": null
 },
 "narration": "Got it. I'm checking with Bee, which takes 5 to 20 seconds. Ask me how you did in a moment.",
 "verdictUrl": "/api/attempts/att_mvgyktz3001",
 "retryAfterMs": 15000
}
```

`Attempt` fields:

- `status`: `pending_bee | polling | graded | unverified`.
- `counted`: true only once Bee's text has been graded.
- `provisional`: `{source, text, speechEndAt, grade}`, or null for a Bee-only attempt.
- `bee`: `{text, gradedText, extraText, utteranceIds, speakerScore, via: "stream"|"poll", latencyMs, coverage, replay}`. `gradedText` is the part of Bee's line that was graded; `extraText` is the merged speech that was cut.
- `final`: `{source: "bee", pass, grade}`.
- `agreement`: `agree | bee-overrules | bee-only`.
- `box`: `{from, to, dueBefore, dueAfter, scheduled}`. `scheduled` is false for a pass on a card that was not due.

`GradeResult` fields:

- `graderVersion`, `pass`, `reasons[]`, `checks[]`.
- `habit: {kind, label, hits, found[]}`.
- `fillerCount`, `fillers[]`, `hedgeCount`, `hedges[]`.
- `contentMatch` and `contentThreshold`.
- `missing[]`, `fuzzy[]` and `required[]`.

### `GET /api/session` while waiting for Bee (trimmed)

```json
{
 "mode": "demo", "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
 "state": "pending_bee",
 "narration": "Got it. I'm checking with Bee, which takes 5 to 20 seconds. Ask me how you did in a moment.",
 "verdictReady": false, "retryAfterMs": 15000,
 "session": { "id": "ses_mvgyktyz000", "by": "alexa", "size": 4, "cardIds": ["demo:vague-referent"], "attemptIds": ["att_mvgyktz3001"], "...": "..." },
 "openCard": { "id": "demo:vague-referent", "resay": "I fixed the invoice retry job this morning.", "...": "..." },
 "lastAttempt": { "id": "att_mvgyktz3001", "status": "pending_bee", "counted": false, "...": "..." },
 "deck": { "date": "2026-10-20", "total": 6, "dueNow": 4, "boxes": { "1": 4, "2": 2, "3": 0, "4": 0, "5": 0 }, "...": "..." },
 "bee": { "replay": true, "pendingVerifications": 1, "lastEventAt": 1792517400005, "counters": { "events": 1, "utterances": 0, "tags": 0, "wearerTags": 0, "verified": 0, "unverified": 0, "beeOnly": 0, "polls": 0, "duplicates": 0 } },
 "currentSessionSummary": { "attempts": 1, "counted": 0, "pending": 1, "...": "..." },
 "lastSessionSummary": null
}
```

### `GET /api/attempts/<id>` (turn 2: "how did I do?"; trimmed)

`retryAfterMs` counts down to the next checkpoint after the end of speech: 15 s, then the poll at 30 s and 37 s, then the 45 s give-up, with a floor of 500 ms. The values shown are at pace 1. The contract check runs at pace 0.02, where you see the 500 ms floor.

```json
// while Bee's line is still on its way
{ "attempt": { "id": "att_mvh0x1a2009", "status": "pending_bee", "counted": false, "...": "..." },
  "status": "pending_bee", "verdictReady": false, "retryAfterMs": 14700,
  "narration": "Bee hasn't sent that line yet. Ask me again in a few seconds." }
// after Bee's merged line landed (+16.5 s)
{ "attempt": { "id": "att_mvh0x1a2009", "status": "graded", "counted": true,
    "bee": { "text": "The release is blocked on the API key from finance. How did I do?", "gradedText": "The release is blocked on the API key from finance.", "extraText": "How did I do?", "speakerScore": 0.82, "via": "stream", "replay": true, "...": "..." },
    "final": { "source": "bee", "pass": true, "...": "..." }, "agreement": "agree", "...": "..." },
  "status": "graded", "verdictReady": true, "retryAfterMs": null,
  "narration": "Bee heard it. That's a pass." }
```

### `POST /api/session/end`

```json
{ "summary": {
  "sessionId": "ses_mvgyktyz000", "by": "alexa", "startedAt": 1792517400251, "endedAt": 1792517402655,
  "cards": 3, "attempts": 6, "counted": 5, "passed": 3, "failed": 2, "unverified": 1, "pending": 0, "beeOverrules": 1,
  "perCard": [
   { "cardId": "demo:vague-referent", "habit": "vague: \"that thing\"", "attempts": 1, "passed": 1, "box": 2, "due": "2026-10-22" },
   { "cardId": "demo:vague-status", "habit": "vague: \"it's getting there\"", "attempts": 2, "passed": 1, "box": 2, "due": "2026-10-22" },
   { "cardId": "demo:hedge-i-guess", "habit": "hedges: \"i guess\"", "attempts": 2, "passed": 1, "box": 1, "due": "2026-10-20" }
  ] } }
```

### `GET /api/stats?range=week` (Bee only, the default; trimmed)

```json
{
 "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)", "synthetic": true,
 "range": "week", "source": "bee",
 "sources": { "conversation": { "sessions": 5, "words": 1400, "label": "Bee (Apple Watch) conversation" } },
 "sessions": [ { "id": "demo-bee-1014", "kind": "conversation", "date": "2026-10-14", "words": 305, "synthetic": true }, "..." ],
 "habits": {
  "words": 1400, "lines": 122,
  "hedges":  { "count": 20, "per100": 1.43, "ci95": [0.87, 2.21], "breakdown": { "i guess": 15, "i think": 5 } },
  "vague":   { "count": 9,  "per100": 0.64, "ci95": [0.29, 1.22], "breakdown": { "and stuff": 5, "getting there": 3, "or something like that": 1 } },
  "fillers": { "count": 34, "per100": 2.43, "ci95": [1.68, 3.39], "breakdown": { "like": 25, "um": 9 } },
  "restarts": { "count": 12, "per100": 0.86, "ci95": [0.44, 1.5] },
  "trailingOff": { "count": 0, "per100": 0, "ci95": [0, 0.26] },
  "yeahTics": { "count": 0, "per100": 0, "ci95": [0, 0.26] }
 },
 "talk": null,
 "practice": { "attempts": 11, "counted": 10, "passed": 7, "unverified": 1, "beeOverrules": 1 },
 "drilledVsNextSession": [
  { "habit": "hedge:i guess", "label": "the hedge \"i guess\"", "firstDrillAt": 1792080600000,
    "lastSessionBefore": { "session": "demo-bee-1015", "date": "2026-10-15", "words": 309, "count": 7, "per100": 2.27, "ci95": [0.91, 4.67], "...": "..." },
    "nextSessionAfter":  { "session": "demo-bee-1016", "date": "2026-10-16", "words": 259, "count": 1, "per100": 0.39, "ci95": [0.01, 2.15], "...": "..." },
    "deltaPer100": -1.88, "preregistered": true,
    "note": "one session either side of the first drill: a glance, not a test (see /api/transfer)" },
  "..."
 ]
}
```

- `source=all` adds the meeting caption sessions, labelled `"meeting captions (secondary source)"`, and a `talk` block: `{meetings, talkShareWords, turns, substantiveTurns, avgTurnWords, longestTurnWords, questions, trailingOffSentences, sentences}`.
- Voice notes are always excluded, because on this project they hold scripted readings and drills.

### `GET /api/transfer` (the hero result; trimmed)

This endpoint checks whether a drilled habit dropped in later **non-drill** real speech, compared with a **control habit that was deliberately not drilled**. Pre-registration lives in `prereg/transfer.json` (live) and `fixtures/demo/prereg-transfer.json` (demo, synthetic).

```json
{
 "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)", "synthetic": true, "source": "bee",
 "sources": { "conversation": { "sessions": 6, "words": 1716, "label": "Bee (Apple Watch) conversation" } },
 "prereg": { "path": "fixtures/demo/prereg-transfer.json", "registeredAt": "2026-10-12T13:00:00.000Z", "drilled": ["hedges", "filler:like"], "control": ["restart"], "basis": "SYNTHETIC DEMO pre-registration ..." },
 "minWordsPerPeriod": 400,
 "method": "Per habit: rate per 100 of the wearer's English words in non-drill sessions ...",
 "habits": [
  { "habit": "hedges", "label": "hedges (I guess, I think, maybe, kind of...)", "role": "drilled",
    "firstDrillAt": 1792080600000, "cutoverAt": 1792080600000, "cutoverSource": "this habit's first drill attempt",
    "before": { "sessions": 3, "words": 930, "count": 23, "per100": 2.47, "ci95": [1.57, 3.71], "from": "2026-10-13", "to": "2026-10-15" },
    "after":  { "sessions": 3, "words": 786, "count": 5,  "per100": 0.64, "ci95": [0.21, 1.48], "from": "2026-10-16", "to": "2026-10-20" },
    "deltaPer100": -1.83, "verdict": "dropped",
    "detail": "95% intervals do not overlap (before 1.57-3.71, after 0.21-1.48 per 100 words)",
    "wordsNeededPerPeriod": 2050 },
  { "habit": "filler:like", "role": "drilled", "verdict": "dropped", "before": { "per100": 3.01, "ci95": [2, 4.35], "...": "..." }, "after": { "per100": 0.76, "ci95": [0.28, 1.66], "...": "..." }, "...": "..." },
  { "habit": "restart", "label": "restarts (the the, I I)", "role": "control", "firstDrillAt": null,
    "cutoverSource": "the earliest first drill of any pre-registered drilled habit",
    "before": { "words": 930, "count": 7, "per100": 0.75, "ci95": [0.3, 1.55], "...": "..." },
    "after":  { "words": 786, "count": 7, "per100": 0.89, "ci95": [0.36, 1.84], "...": "..." },
    "verdict": "no change", "...": "..." }
 ],
 "unregistered": [ { "habit": "vague", "drills": 3, "note": "drilled but not pre-registered: not reported as a transfer result" } ],
 "headline": "hedges (I guess, I think, maybe, kind of...) and \"like\" as a filler dropped in real speech after drilling; the undrilled control stayed flat"
}
```

**Verdicts:**

- `dropped` or `rose`: the 95% intervals (Poisson, Byar) do not overlap, and both periods have at least `minWordsPerPeriod` words.
- `no change`: the intervals overlap.
- `too little data`: a period has fewer words than the minimum. `detail` gives the counts and `wordsNeededPerPeriod`, the words per period needed to tell a halving of the "before" rate from no change.
- `not drilled yet`: there is no counted drill attempt, so no after period exists.
- `invalid`: the control was drilled, or a drilled habit's first drill came before the pre-registration.

**Refusals:**

- A drilled habit that is not pre-registered (neither its key nor its umbrella) appears only under `unregistered`.
- `GET /api/transfer?habit=vague` returns 422:

  ```json
  { "error": "not_preregistered", "message": "\"vague\" is not pre-registered as drilled or control, so no transfer result is reported for it", "prereg": { "...": "..." } }
  ```

A drill counts toward `firstDrillAt` only when it is a **counted** (Bee-graded) attempt.

### `GET /api/brief`

```json
{
 "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
 "generatedAt": "2026-10-20T17:30:02.683Z",
 "event": { "title": "Team stand-up (demo)", "startsAt": "2026-10-20T18:00:00.000Z", "startsInMin": 30, "date": "2026-10-20", "source": "demo calendar (injected; live mode reads Bee's today brief)" },
 "eventNote": null,
 "topHabit": { "key": "hedges", "label": "hedging", "per100": 1.43, "count": 20, "words": 1400, "range": "week", "source": "bee" },
 "warmup": { "id": "demo:hedge-i-guess", "resay": "The billing export is ready for review today.", "habit": { "kind": "hedge", "targets": ["i guess"], "label": "hedges: \"i guess\"" }, "...": "..." },
 "nudge": "Team stand-up (demo) in 30 min. Your top habit this week: hedging (1.43 per 100 words). Warm up: say \"The billing export is ready for review today.\" once, cleanly."
}
```

- Live mode reads `bee today --json` (`calendar_events`), caches it for 5 minutes, and ignores emails. Calendar titles are never persisted.
- With no calendar connected, `event` is null and `eventNote` says why.
- Top habit: hedges or vague answers win when they have at least 3 occurrences this week (otherwise all data). Fillers and restarts are the fallback.

### `GET /api/deck` (trimmed)

```json
{ "dataLabel": "...", "today": "2026-10-20",
  "summary": { "date": "2026-10-20", "total": 6, "dueNow": 1, "boxes": { "1": 2, "2": 3, "3": 1, "4": 0, "5": 0 }, "dueByDate": { "2026-10-20": 1, "2026-10-21": 1, "2026-10-22": 3, "...": 0 }, "nextDueDate": "2026-10-21" },
  "cards": [ { "id": "demo:hedge-i-guess", "...": "CardView" } ] }
```

Scheduling (Leitner, `src/hub/scheduler.ts`; intervals 1, 2, 4, 8 and 16 days):

- **Next due.** The next card is chosen from the due cards: lowest box first, then the most relapses, then the one practised least recently, then the score.
- **Pass.** A final (Bee) pass on a due card moves it up a box. A pass on a card that is not due is practice only.
- **Fail.** A final fail sends the card to box 1, due today, behind the other due cards.

## WebSocket (`ws://<host>:8791/ws`, tv-voice-bridge protocol v1)

Connect with the bridge client (`@rackboard/tv-voice-bridge`, vendored as `vendor/rackboard-tv-voice-bridge-0.1.0.tgz`) or with raw frames.

- **TV / Alexa simulator / any viewer:** `{"type":"hello","v":1,"role":"screen","clientId":"tv-mirror","name":"tv"}`. The hub replies with `welcome {code, joinUrl, serverTime}`. A screen without a code creates a room, and its code pairs a phone.
- **Phone mic:** `{"type":"hello","v":1,"role":"mic","clientId":"phone-1","code":"HJ3H"}`.
- **Clock.** Event times are on the hub clock. In demo mode, the hub clock is the demo clock (2026-10-20). Estimate the offset as `welcome.serverTime - Date.now()`, as the bridge client does.

**Hub to every peer** (every room, every role): each event is `{"type":"app","topic":"<event>","payload":{seq, at, ...}}`.

- `seq` increases strictly across all events. Render in `seq` order and drop duplicates by `seq`.
- On joining, a peer gets `hub.state` (`seq: 0`), the same object as `GET /api/state`.
- SSE (`GET /api/events`) carries the same events as `event: <topic>`, `id: <seq>`, `data: <payload>`.

**Client to hub:**

| Frame | Effect |
|---|---|
| `transcript.final {utteranceId, text, hops:[{hop:"speech.end",at},...]}` (mic) | provisional attempt from `phone`. The bridge then sends the room an `intent` named `attempt.provisional` (or `attempt.rejected`) with `hops` for latency |
| `app {topic:"card.request", payload:{cardId?}}` | open a card |
| `app {topic:"attempt.submit", payload:{text, source?, cardId?}}` | provisional attempt (`source` defaults to `typed`) |
| `app {topic:"session.start", payload:{size?}}`, `session.next`, `session.end` | same as the HTTP session calls |

Bridge intent on a phone attempt:

```json
{ "type": "intent", "utteranceId": "u_phone_1", "name": "attempt.provisional", "ok": true,
  "payload": { "attemptId": "att_mvgyku42002", "cardId": "demo:vague-status", "status": "pending_bee", "provisionalPass": true },
  "from": "phone-1",
  "hops": [ { "hop": "speech.end", "at": 1792517400459 }, { "hop": "mic.send", "at": 1792517400459 }, { "hop": "hub.recv", "at": 1792517400460 }, { "hop": "hub.intent", "at": 1792517400462 } ] }
```

### Events

| Topic | When | Payload (besides `seq`, `at`) |
|---|---|---|
| `hub.state` | on join (to that peer only) | `GET /api/state` object |
| `session.started` | a session starts | `{session}` |
| `card.open` | a card opens (session, request or attempt on a card) | `{card: CardView, by, sessionId, deck}` |
| `attempt.provisional` | phone/Alexa/typed text received and previewed | `{attempt (status pending_bee), card}` |
| `attempt.status` | the stream timed out; polling | `{attemptId, cardId, status: "polling", reason}` |
| `attempt.verified` | Bee confirmed, or gave up | `{attemptId, cardId, status: "verified"\|"unverified", via: "stream"\|"poll"\|null, speakerScore, latencyMs, beeText, replay, reason}` |
| `attempt.graded` | Bee's text graded (only after `verified`) | `{attempt (status graded, counted, final, agreement, box), card, deck}` |
| `stats.updated` | after every settled attempt | `{dataLabel, practiceToday, weekPer100: {words, hedges, vague, fillers, restarts}, transferHeadline, deck}` |
| `session.ended` | a session ends | `{summary}` |

Order per attempt:

- With a preview: `attempt.provisional`, then `attempt.status` (only when the poll is used), then `attempt.verified`, then `attempt.graded`, then `stats.updated`.
- Unverified: `attempt.provisional`, then `attempt.status`, then `attempt.verified (unverified)`, then `stats.updated`. There is no `attempt.graded`.
- Bee-only: `attempt.verified`, then `attempt.graded`, then `stats.updated`.

`attempt.verified`:

```json
{ "topic": "attempt.verified", "payload": { "seq": 4, "at": 1792517400378, "attemptId": "att_mvgyktz3001", "cardId": "demo:vague-referent",
  "status": "verified", "via": "stream", "speakerScore": 0.82, "latencyMs": 123,
  "beeText": "I fixed the invoice retry job this morning.", "replay": true, "reason": "Bee tagged the wearer saying it" } }
```

(`latencyMs` is 123 here because the check runs the replay at pace 0.02. At pace 1 it is about 5,900 ms, as measured live.)

`attempt.graded` with Bee overruling the phone (the phone recognizer dropped an "um" that Bee kept; trimmed):

```json
{ "topic": "attempt.graded", "payload": { "seq": 10, "attempt": {
  "id": "att_mvgyku42002", "cardId": "demo:vague-status", "status": "graded", "counted": true,
  "provisional": { "source": "phone", "text": "The migration is not done yet: two of the three checks pass.", "grade": { "pass": true, "...": "..." } },
  "bee": { "text": "Um, the migration is not done yet: two of the three checks pass.", "speakerScore": 0.82, "via": "stream", "replay": true, "...": "..." },
  "final": { "source": "bee", "pass": false, "grade": { "reasons": ["FAIL fillers: 1 filler (\"um\"); allowed 0", "ok nonempty: 13 words heard", "..."], "fillers": ["um"], "...": "..." } },
  "agreement": "bee-overrules",
  "box": { "from": 1, "to": 1, "dueBefore": "2026-10-20", "dueAfter": "2026-10-20", "scheduled": true } },
  "card": { "...": "CardView" }, "deck": { "...": "DeckSummary" } } }
```

`attempt.status` and an unverified result:

```json
{ "topic": "attempt.status", "payload": { "seq": 14, "attemptId": "att_mvgyku8q003", "cardId": "demo:hedge-i-guess", "status": "polling",
  "reason": "no tagged line on the live stream within 30 s: checking the conversation with the Bee CLI" } }
{ "topic": "attempt.verified", "payload": { "seq": 20, "attemptId": "att_mvgykupv004", "cardId": "demo:hedge-i-guess", "status": "unverified",
  "via": null, "speakerScore": null, "latencyMs": null, "beeText": null, "replay": true,
  "reason": "Bee heard it but never tagged the wearer (tag timeout)" } }
```

Possible unverified reasons:

- "no Bee utterance in the time window (stream and poll)"
- "Bee heard it but never tagged the wearer (tag timeout)"
- "Bee tagged another speaker"
- "Bee's speaker score was below 0.5"
- "Bee heard the wearer, but the words matched neither the attempt nor the card"

`stats.updated`:

```json
{ "topic": "stats.updated", "payload": { "seq": 6, "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
  "practiceToday": { "attempts": 1, "counted": 1, "passed": 1, "unverified": 0, "beeOverrules": 0 },
  "weekPer100": { "words": 1400, "hedges": 1.43, "vague": 0.64, "fillers": 2.43, "restarts": 0.86 },
  "transferHeadline": "hedges (I guess, I think, maybe, kind of...) and \"like\" as a filler dropped in real speech after drilling; the undrilled control stayed flat",
  "deck": { "...": "DeckSummary" } } }
```

## Demo mode

- **Data.** Fixtures in `fixtures/demo/` are generated by `npm run demo:fixtures` from `src/hub/demoData.ts`. They are invented sentences for a fictional wearer ("Ada") and are labelled synthetic in every file and payload.
- **Story.** On 2026-10-12, "I guess" and "like" were pre-registered as drilled habits and restarts as the control. Drilling started 2026-10-15 12:10 EDT. Afterwards, both drilled habits drop in later Bee conversations and restarts stay flat.
- **Clock.** The demo clock starts at 2026-10-20 13:30 EDT and runs in real time. The demo calendar has a "Team stand-up (demo)" at 14:00.
- **State.** Deck and attempts are copied fresh to `out/demo/` (gitignored) on every start.
- **Bee replay.** Every provisional attempt gets a scripted replay shaped like the recorded stream: `new-utterance` at +5.4 s and `tagged-utterance` at +5.9 s, scaled by `--pace`. The replayed events go through the same parser and verifier as live events. The default cycle is `verified`, `bee-hears-filler`, `verified`, `asr-slip`.

`POST /api/demo/scenario {scenario}` picks the scenario for the next attempt. The scenarios are:

| Scenario | What Bee does |
|---|---|
| `verified` | hears the same words and tags the wearer (score 0.82) |
| `bee-hears-filler` | hears an "um" the phone dropped; Bee's text fails the filler rule and overrules the preview |
| `asr-slip` | mishears "card" as "car" and "Rack Board" as "rec board"; the fuzzy grader still passes it |
| `merged` | merges the attempt with the next words ("How did I do?") into one line at +16.5 s, as on the real device; the extra sentence is cut before grading |
| `poll` | the stream drops both events; the fallback poll finds the wearer-labelled line |
| `untagged` | Bee sends the line but never tags a speaker, and the poll finds no wearer label: unverified |
| `other-speaker` | Bee tags the line as someone else: unverified |

## Live mode

- **Data.** `real/deck.json` (cards from the existing pipeline; `npm run hub:cards` adds deterministic hedge and "like" cards from the wearer's own Bee lines), `real/hub-attempts.json`, and the analysed sessions (`real/corpus.json`, `real/class-*.json`, `real/meetings.json`). All are gitignored.
- **Bee.** The hub spawns `bee stream --types new-utterance,tagged-utterance,new-conversation --json` and restarts it with backoff if it exits. The wearer rule comes from `bee me`. The fallback poll runs `bee conversations get <id> --json` on the conversation(s) seen in the window. The CLI handles authentication, and the hub never reads or logs the token or any transcript text.
- **Environment.** `BEE_BIN`, `BEE_WEARER_PERSON_ID` (comma-separated `person_id`s to accept as the wearer), `COACH_PORT` and `BEE_TZ`.

## The cross-surface check (`npm run contract:check`)

The check starts the hub in demo mode (pace 0.02) as a child process. It connects a TV `screen` and a phone `mic` over the bridge, plus an SSE client, and then asserts the following (46 assertions):

1. **Alexa session.** `card.open` reaches the TV. The attempt goes `pending_bee`, then `attempt.verified` (via stream, `replay: true`, speaker score at least 0.5), then `attempt.graded` (Bee text, counted, box +1), then `stats.updated`. The voice-UI states are narrated.
2. **Phone over the bridge.** The preview passes, and the phone gets the bridge intent. Bee hears an "um", so the final grade fails with `bee-overrules`, and the card drops to box 1.
3. **Poll fallback.** `attempt.status polling`, then `attempt.verified via poll`, then `graded`.
4. **Never tagged.** The result is `unverified` with the reason. There is no `attempt.graded`, and the state is `unverified`.
5. **Bee-only.** A Bee-only attempt is graded from Bee's text.
6. **Negative control.** The hedge is kept, so the preview and the final grade both fail on the `habit` rule.
7. **Two-turn Alexa drill.** Turn 1 returns 202 `pending_bee` with `verdictUrl` in under 1 s. The verdict is not ready early. Bee's merged line lands at +16.5 s (scaled), and the verdict is then ready and narrated. The merged "How did I do?" is cut (`extraText`). The TV gets `attempt.verified`.
8. **Session summary.** The summary counts counted, unverified and bee-overrules attempts.
9. **Stats, transfer, brief and deck.**
   - Stats: Bee-only by default; meetings are labelled secondary with `source=all`; `range=session:<id>` works.
   - Transfer: drilled habits `dropped`, control `no change`, unregistered `vague` refused, and `?habit=vague` returns 422.
   - Brief: event, hero top habit and warm-up card.
   - Deck: next card.
10. **Sync.** The TV, the phone and SSE saw the identical event sequence, with strictly increasing `seq`.

## Notes for the surfaces

**Phase 2: Fire TV speaking mirror** (reuse the Vega app shell and the web TV).

- **Main screen.**
  - Use `GET /api/stats?range=week` for the habit bars, with hedges and vague answers first and fillers second.
  - Use `GET /api/transfer` for the chart: before/after per habit with the `ci95` whiskers, the verdict chip, and the control habit shown beside the drilled ones. Show `unregistered` as "not pre-registered".
  - Show `dataLabel` whenever `synthetic` is true.
- **Live layer.**
  - Join as `screen`. Render from `app` events by `seq`, and refresh stats/transfer on `stats.updated`.
  - The "drill in progress" panel mirrors `card.open`, then `attempt.provisional` ("preview: pass"), then `attempt.status` ("checking with Bee"), then `attempt.verified` ("verified by Bee", with `speakerScore` and `latencyMs`), then `attempt.graded` (final verdict, `reasons`, box move).
  - Show `agreement: "bee-overrules"` explicitly, because it is the "Bee wins" beat.
  - Show `bee.replay` / `replay: true` as "Bee replay (demo)".
- **Pairing.** The TV room code pairs a phone mic (`welcome.joinUrl` points at `/p/<code>`, which phase 2 must serve, or replace with its own phone page).
- **Vega specifics** (from the bridge README). Use a reverse port forward for the VVD. The W3C media player needs publicly trusted https audio. Polyfill `performance.timeOrigin`.

**Phase 3: Alexa+ MCP server** (Streamable HTTP) **and web simulator.**

- **Tool mapping.**

  | Tool | Calls |
  |---|---|
  | `start_drill` | `POST /api/session/start {by:"alexa", size}` |
  | `submit_attempt(text)` | `POST /api/attempt {source:"alexa", text}` (returns at once) |
  | `get_verdict(attempt_id)` | `GET /api/attempts/<id>` |
  | `drill_status` | `GET /api/session` |
  | `next_card` | `POST /api/session/next` |
  | `end_drill` | `POST /api/session/end` |
  | `how_did_i_do(range)` | `GET /api/stats` |
  | `did_it_transfer` | `GET /api/transfer` |
  | `pre_meeting_brief` | `GET /api/brief` |

- **Waiting for Bee: two turns.** Alexa must answer within 8 s, and Bee's line takes 5 to 20 s.
  - `submit_attempt` returns at once with `narration` and the attempt id. End the turn there and keep the session open.
  - The next turn ("how did I do?") calls `get_verdict(attempt_id)`, which maps to `GET /api/attempts/<id>`. When `verdictReady` is false, narrate the waiting line and invite the user to ask again after `retryAfterMs`.
  - Never block a turn waiting for Bee. Worst case, the verdict is ready about 45 s after speech end (stream at 30 s, poll, then give up).
- **What not to do.** Never present a `provisional` grade as the result. Bee's grade is the one that counts.
- **Web simulator.** It can subscribe to `GET /api/events` (SSE) instead of the WebSocket.
