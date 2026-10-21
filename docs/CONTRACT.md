# Coach hub contract (v2)

Contract v2 (frozen 2026-10-16) keeps every v1 route, event and payload below unchanged and adds live coaching, practice meters, the speaking mirror, Alexa and MCP: see [Contract v2](#contract-v2). The types for both are in [`src/hub/contract.ts`](../src/hub/contract.ts) (import-free, so surfaces can copy it).

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
npm run hub -- --demo --fixture-v2   # demo, and the v2 live routes answer from fixtures/contract-v2/
npm run contract:check               # the cross-surface check below
```

- Base URL `http://<host>:8791`. Override it with `--port` or `COACH_PORT`.
- CORS is `*`. Bodies are JSON.
- Errors are `{ "error": "<code>", "message": "..." }` with a 4xx status.
- `GET /api/health` returns `contractVersion: 2` (v2 added fields; nothing was removed).

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
| `idle` | "No drill is running. Start a session to get your first card." / "Bee heard it. That's a pass, so the card is closed. Start a drill for the next one." | no open card (the second line right after Bee passed a lone card; `lastAttempt` is that pass) |
| `card_open` | `Say this: "<resay>"` | waiting for the user |
| `pending_bee` | "Got it. I'm checking with Bee, which can take up to about twenty seconds to hear it. Ask me how you did in a moment." | preview graded; waiting for Bee's wearer-tagged line |
| `polling` | "Bee's live feed was quiet, so I'm checking your conversation directly." | stream timeout; fallback poll of the conversation through the Bee CLI |
| `graded` | "Bee heard it. That's a pass." (in a session: "... Say next for the next card.") / "Bee heard it. Not yet: <first failed rule>." | Bee's text graded; the schedule moved |
| `unverified` | "Bee didn't confirm that one, so it doesn't count. Try it again." | no Bee confirmation; the schedule is unchanged |

`GET /api/session` also returns `verdictReady` (true in `graded`/`unverified`) and `retryAfterMs` (when to ask again for a pending attempt).

**A PASS ends a card's attempts.** Once Bee grades a counted PASS on the open card, that opening takes no more Bee-only attempts: the wearer's next lines are everyday speech, not retries, and are never graded against it.

- **Outside a session** (a card opened with `POST /api/card/open`, by the TV or the phone), the card closes: `open` becomes `null`, live nudges are no longer held back, and every surface is re-sent `hub.state` (it carries the passing attempt as `lastAttempt`, so a screen showing the card keeps the verdict). A new attempt then needs a card again (`no_open_card`), or names one with `cardId`.
- **In a session**, the card stays open and waits for `POST /api/session/next` (the voice flows call it on the verdict); a preview submitted for it is still a deliberate retry and counts.
- **After a FAIL** nothing closes: say it again.

### Two-turn voice drill (Alexa's 8 s limit)

On a real device (iPhone Alexa app, Canada, 2026-10-16), Bee merged the drill sentence with the next words into one utterance. A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn. So the drill is **asynchronous and takes two turns**:

1. **Turn 1.** The user says the card, and Alexa's skill sends its transcript with `POST /api/attempt {source:"alexa", text}`. The hub returns **202 at once** with `status: "pending_bee"`, `verdictUrl: "/api/attempts/<id>"`, `retryAfterMs` and `narration` ("Got it. I'm checking with Bee... Ask me how you did in a moment."). Alexa's transcript is kept as `provisional` only.
2. **Turn 2.** The user asks "how did I do?", and the skill calls `GET /api/attempts/<id>` (the verdict).
   - If `verdictReady` is true: narrate `narration` (Bee's final grade, or "didn't count").
   - Otherwise: narrate the waiting line and suggest asking again after `retryAfterMs`.
3. **TV.** The TV needs no polling: it gets `attempt.verified` and then `attempt.graded` over the WebSocket the moment Bee's line lands.

Bee may merge the attempt with what was said before or after it ("... from finance. How did I do?"). Matching therefore uses coverage, so extra words don't hurt. Before grading, whole sentences that contain no word of the target are cut. `attempt.bee.gradedText` is what was graded and `attempt.bee.extraText` is what was cut. A sentence that contains any target word is kept whole, so a habit inside it ("Um, the ...") is still graded. The cut applies to the content and required-word rules only: the habit and filler rules also read the sentence right before and right after the graded span, so a hedge or filler said as its own sentence ("... this morning. I guess.", "Maybe. The deploy ...", "Um. The ...") still fails the attempt. Curly apostrophes count like straight ones. If Bee did not punctuate the merge, the whole line is graded.

Timings: Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it. The `tagged-utterance` follows the `new-utterance` by about 0.5 s.

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
| `required` | every `mustSay` word was said: the concrete words the fix introduces, such as "invoice retry job" replacing "that thing". Exact, or a one-edit ASR slip ("car" for "card"); never a two-edit match ("relapse" for "release") or another day, month or number ("Tuesday" for "Thursday") |

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
| `POST /api/session/start` `{by?, size? (1-10, default 3)}` | Alexa | starts a drill session and opens the first due card. A card already open outside a session (the TV, the phone or `POST /api/card/open` opened it) becomes the session's first card instead: `card.open` is sent again with the session id, and Bee keeps matching lines against that opening |
| `POST /api/session/next` | Alexa | opens the next due card, or ends the session when `size` cards were counted or nothing is due: `{card, done, summary?}` |
| `POST /api/session/end` | Alexa | ends the session: `{summary}` |
| `POST /api/attempt` `{text, source: "phone"\|"alexa"\|"mcp"\|"typed", cardId?, speechEndAt? (hub-clock ms)}` | Alexa, MCP clients, phone, typed | provisional attempt on the open card (or on `cardId`, which it opens). Returns **202** at once: `{attempt, narration, verdictUrl, retryAfterMs}` with `status: "pending_bee"` |
| `GET /api/attempts/<id>` | Alexa (turn 2) | **the verdict**: `{attempt, status, verdictReady, retryAfterMs, narration}` |
| `GET /api/attempts?limit=20` | TV | recent attempts, newest first |
| `GET /api/deck` | TV | `{summary, cards[], today}` |
| `GET /api/deck/next` | any | the card that "next" would open (does not open it), plus the open card |
| `POST /api/card/open` `{cardId?, by?}` | any | opens a card outside a session (practice; a card that is not due changes no box on a pass) |
| `GET /api/stats?range=today\|week\|all\|session:<id>\|meeting:<id>&source=bee\|all` | TV | habit rates per 100 words with 95% intervals, practice counts (`null` for a `session:` or `meeting:` range, which is echoed back as asked), drilled-vs-next-session glance |
| `GET /api/transfer?source=bee\|all&habit=<key>?` | TV, Alexa | the transfer result: drilled vs the pre-registered control |
| `GET /api/instrument` | TV | Bee vs meeting captions on the meetings both heard: pooled counts, rates and 95% intervals per habit, and whether they gave similar numbers (aggregates only) |
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
 "narration": "Got it. I'm checking with Bee, which can take up to about twenty seconds to hear it. Ask me how you did in a moment.",
 "verdictUrl": "/api/attempts/att_mvgyktz3001",
 "retryAfterMs": 15000
}
```

`Attempt` fields:

- `status`: `pending_bee | polling | graded | unverified`.
- `counted`: true only once Bee's text has been graded.
- `provisional`: `{source, text, speechEndAt, grade}`, or null for a Bee-only attempt.
- `bee`: `{text, gradedText, extraText, utteranceIds, speakerScore, via: "stream"|"poll", latencyMs, coverage, replay, spokenFromMs?, spokenToMs?, conversationId?}`. `gradedText` is the part of Bee's line that was graded; `extraText` is the merged speech that was cut. `spokenFromMs`/`spokenToMs` (hub-clock ms) and `conversationId` (the Bee conversation, or null) say when and where Bee's lines were spoken; older attempts omit them. `openingSeq` (additive) is the hub's counter for the card opening the attempt was made in; it restarts with the hub.
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
 "narration": "Got it. I'm checking with Bee, which can take up to about twenty seconds to hear it. Ask me how you did in a moment.",
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

`attempts` to `beeOverrules` count tries, and a missed line stays open for another try. `lines` (additive) counts each line (card) of the round once, by its best result: `passed` if Bee passed a try at it, else `failed` if Bee graded one, else `pending` while one is still with Bee, else `unverified` if Bee didn't catch it, else `untried`. They add up to `cards`. The TV's Round over, the phone's "Session over" line, Alexa's "That's the round" and the MCP `end_drill` narration count these, so a line missed and then passed on a retry is one line passed: the TV shows "1 of 2 lines passed." over "1 passed, 1 not yet", never "1 passed, 2 not yet". A screen talking to a hub from before `lines` falls back to the tries and says so. Each `perCard` entry names its line's result in `line` (additive; one of the `lines` keys), and the TV colours that line's Round over segment by it: lime passed, coral not yet, an open sky ring only while Bee still checks it, a faint bar for a line Bee didn't catch, a faint ring for one not tried. Its `attempts` and `passed` count Bee-graded tries. A hub from before `line` leaves the TV to go by the graded tries: a line without one shows the sky ring only while the round has a try still with Bee.

```json
{ "summary": {
  "sessionId": "ses_mvgyktyz000", "by": "alexa", "startedAt": 1792517400251, "endedAt": 1792517402655,
  "cards": 3, "attempts": 6, "counted": 5, "passed": 3, "failed": 2, "unverified": 1, "pending": 0, "beeOverrules": 1,
  "lines": { "passed": 3, "failed": 0, "unverified": 0, "pending": 0, "untried": 0 },
  "perCard": [
   { "cardId": "demo:vague-referent", "habit": "vague: \"that thing\"", "attempts": 1, "passed": 1, "box": 2, "due": "2026-10-22", "line": "passed" },
   { "cardId": "demo:vague-status", "habit": "vague: \"it's getting there\"", "attempts": 2, "passed": 1, "box": 2, "due": "2026-10-22", "line": "passed" },
   { "cardId": "demo:hedge-i-guess", "habit": "hedges: \"i guess\"", "attempts": 2, "passed": 1, "box": 1, "due": "2026-10-20", "line": "passed" }
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
 "headline": "Unsure words and filler \"like\" dropped in your real conversations since you started practising; the one you didn't practise stayed the same",
 "claim": "all-dropped-control-flat",
 "firstSignal": [
  { "habit": "hedges", "label": "hedges (I guess, I think, maybe, kind of...)", "firstDrillAt": 1792080600000, "status": "measured",
    "before": { "session": "demo-bee-1015", "date": "2026-10-15", "startMs": 1792071600000, "words": 309, "count": 8, "per100": 2.59 },
    "after":  { "session": "demo-bee-1016", "date": "2026-10-16", "startMs": 1792159800000, "words": 259, "count": 2, "per100": 0.77 },
    "deltaPer100": -1.82, "minWords": 100,
    "note": "one conversation either side of the first drill: a first signal, not proof (the pre-registered before/after is the test)" },
  { "habit": "filler:like", "status": "measured", "before": { "per100": 3.24, "...": "..." }, "after": { "per100": 0.77, "...": "..." }, "deltaPer100": -2.47, "...": "..." }
 ]
}
```

**First signal:** `firstSignal` (additive) is the same-day glance, one entry per pre-registered drilled habit that has been drilled: the last conversation that started before its first drill against the next one that started at or after it, rates per 100 words, drill lines left out and conversations with no other words skipped. It is not the test: one conversation either side, no interval. `status` decides what a surface may say:

- `measured`: both conversations have at least `minWords` (100) words; `deltaPer100` is after minus before. Say the two rates and that it is one conversation, not proof.
- `too-few-words`: a side is shorter; say it was too short to compare, never a number (`deltaPer100` is `null`).
- `no-next-conversation`: no conversation since the drill yet; the TV says the next one shows here.
- `no-earlier-conversation`: nothing before the drill to compare with.

**Claim:** `claim` is what `headline` says, as a fixed value, so a screen can word it without re-deriving it from the verdicts. It follows the headline's rule: the control "stayed flat" only when at least one control is registered and every control is `no change`.

- `all-dropped-control-flat`: every drilled habit dropped, and the control stayed flat.
- `dropped-control-flat`: some drilled habit dropped, and the control stayed flat.
- `dropped-control-dropped`: a drilled habit dropped, but so did the control, so the drop may not be the drill.
- `dropped-control-unclear`: a drilled habit dropped, but the control cannot be compared (too little data, rose, invalid, or none registered).
- `partly-started`: nothing dropped yet; some drilled habit's after period has started (its first drill) and another is not drilled yet. The headline names both: `After period started for "like" on Oct 19; hedges not drilled yet` (the date is the hub's local day of that habit's first drill).
- `not-drilled-yet`: no drilled habit has been drilled yet, so no after period has started.
- `no-drop-yet`: no drilled habit has dropped measurably yet.

**Verdicts:**

- `dropped` or `rose`: the 95% intervals (Poisson, Byar) do not overlap, and both periods have at least `minWordsPerPeriod` words.
- `no change`: the intervals overlap. This means no detectable change (the `detail` says so), not proof that nothing changed.
- Bee lines that were drill attempts are left out of both periods: a card sentence said for a drill is not everyday speech. A line is a drill line when its key is one of `attempt.bee.utteranceIds`, or, because the stats lines come from Bee's final transcript while a stream-matched attempt carries the live stream's ids, when it was spoken inside the attempt's window (`spokenFromMs` to `spokenToMs`, 8 s slack) in the same conversation and most of its words are the attempt's (or most of the attempt's words are in it).
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

**Sources:** each `sources` entry also has `from` and `to` (additive), the first and last local date of that source's sessions. With `source=all`, `sources.meeting` is what the TV's secondary line counts ("2 captioned meetings since Oct 14"). A meeting that Bee also heard (paired by `pairMeetings`) is counted once in every `source=all` view: from Bee when Bee heard most of it (Bee's wearer words at least half the captions' words, or Bee's lines spanning at least 70% of the meeting), so its caption session is left out; otherwise from the captions, with Bee's lines inside the meeting left out (`meetingDedup`).

**Captions included (secondary):** `GET /api/transfer?source=all` is the same computation with meeting captions added. The pre-registered result is the default, Bee-only call; a surface that shows `source=all` must label it as not the pre-registered check. The TV shows it under Progress's cards, for the practised habits and the control only (captions miss some "um" and "uh", so filler words are left out), and says that captions and Bee gave similar numbers only when `GET /api/instrument` has `claim: "practised-agree"` (too little data to compare with `too-little-data`).

### `GET /api/instrument` (Bee vs captions; aggregates only)

Each meeting caption session is paired with every Bee conversation that overlaps its time, and Bee's lines are cut to the meeting's start and end (`pairMeetings`, `src/real/instruments.ts`); a Bee line counts toward one meeting at most. When an end time is missing, the Bee conversation that starts nearest, within 45 minutes, is used instead, and `note` says how many pairs were matched that weaker way. A meeting with no English lines of the wearer on either side is skipped. Both sides are counted with the hub's own habit rules, and rates are pooled over the pairs. No line text and no session id is returned.

```json
{ "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)", "synthetic": true, "generatedAt": "2026-10-20T17:36:28.459Z",
  "pairs": 1, "from": "2026-10-13", "to": "2026-10-13", "words": { "captions": 314, "bee": 316 }, "minWords": 200, "minCount": 20, "enoughWords": 1000,
  "tolerance": { "per100": 0.3, "relative": 0.15 },
  "habits": [
   { "habit": "hedges", "captionsPer100": 2.55, "beePer100": 2.53, "captions": { "count": 8, "ci95": [1.1, 5.02] }, "bee": { "count": 8, "ci95": [1.09, 4.99] }, "agree": null },
   { "habit": "filler:like", "captionsPer100": 2.87, "beePer100": 2.85, "captions": { "count": 9, "ci95": [1.31, 5.44] }, "bee": { "count": 9, "ci95": [1.3, 5.41] }, "agree": null },
   { "habit": "restart", "captionsPer100": 0.64, "beePer100": 0.63, "captions": { "count": 2, "ci95": [0.07, 2.3] }, "bee": { "count": 2, "ci95": [0.07, 2.29] }, "agree": null },
   { "habit": "um-uh", "captionsPer100": 0, "beePer100": 0.63, "captions": { "count": 0, "ci95": [0, 1.17] }, "bee": { "count": 2, "ci95": [0.07, 2.29] }, "agree": null },
   { "habit": "fillers", "captionsPer100": 2.87, "beePer100": 3.48, "captions": { "count": 9, "ci95": [1.31, 5.44] }, "bee": { "count": 11, "ci95": [1.74, 6.23] }, "agree": null } ],
  "claim": "too-little-data",
  "note": "the same meetings heard by Bee and by the meeting's captions, Bee's lines cut to each meeting's time, counted with the same habit rules; aggregates only. The pre-registered check counts Bee only. 1 of the 1 have synthetic captions copied from Bee's own lines, so the two are not compared." }
```

- `captions` and `bee` (additive): each side's count of the habit and its 95% interval per 100 words (Poisson, Byar).
- `agree`: `null` (not compared) until one side has at least `minCount` of the habit and the other side has it too, or both sides have `enoughWords` words (and `minWords` at the least). A handful of a habit is never compared, whatever the word count. Then `true` only when the two intervals overlap and the rates differ by at most the larger of `tolerance.per100` and `tolerance.relative` times the higher rate. Captions copied from Bee's own lines (the synthetic demo) are never compared.
- `claim`: `practised-agree` (unsure words and filler "like" both agree), `practised-differ`, `too-little-data` (either practised habit not compared) or `no-pairs`. Only `practised-agree` lets a screen say captions and Bee gave similar numbers; with `too-little-data` the TV says there is too little data to compare.

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
- `event` is the next meeting, or one that started up to 5 minutes ago (`startsInMin` below 0). `?upcoming=1` gives only a meeting that has not started yet: the coaching skill's heartbeat uses it, so a meeting under way never hides the next one. Any other value is `400 bad_request`.
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

Connect with the bridge client (`tv-voice-bridge`, vendored as `vendor/tv-voice-bridge-0.3.5.tgz`) or with raw frames.

- **TV / Alexa simulator / any viewer:** `{"type":"hello","v":1,"role":"screen","clientId":"tv-mirror","name":"tv"}`. The hub replies with `welcome {code, joinUrl, serverTime}`. A screen without a code creates a room, and its code pairs a phone.
- **Phone mic:** `{"type":"hello","v":1,"role":"mic","clientId":"phone-1","code":"HJ3H"}`.
- **Clock.** Event times are on the hub clock. In demo mode, the hub clock is the demo clock (2026-10-20). Estimate the offset as `welcome.serverTime - Date.now()`, as the bridge client does.

**Hub to every peer** (every room, every role): each event is `{"type":"app","topic":"<event>","payload":{seq, at, ...}}`.

- `seq` increases strictly across all events. Render in `seq` order and drop duplicates by `seq`.
- On joining, a peer gets `hub.state` (`seq: 0`), the same object as `GET /api/state`. It carries `bootId` (new on every hub start) and `lastSeq` (the last `seq` published when the snapshot was taken); both are optional for older hubs. It also carries `practiceToday`, today's drill tally (the hub's local day), so a screen needs no separate fetch for DRILLS TODAY; `stats.updated` carries it after that, and the hub publishes `stats.updated` again when its local day turns, so a screen left on overnight shows a zero tally, not yesterday's.
  - **Reconnect** (same `bootId`): events at or below `lastSeq` are already in the snapshot; apply the ones above it.
  - **Restart** (a different `bootId`): `seq` started again at 1, so drop the old high-water mark. Without this, a TV that had seen seq 340 ignored the next 340 events.
- **Drill sessions expire.** A session (or a lone open card) with no card, attempt or verdict for 10 minutes is ended (`session.ended`), unless Bee is still checking an attempt. Alexa's `SessionEndedRequest` also ends the session that skill session started (its id rides in the session attributes); a session started since by anyone else is left alone. Either way, an abandoned drill does not keep live nudges muted as `drill-active` or keep matching everyday speech as attempts.
- **Event order.** `attempt.provisional` is always published before that attempt's `attempt.verified` and `attempt.graded`.
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
| `stats.updated` | after every settled attempt, and when the hub's local day turns | `{dataLabel, practiceToday, weekPer100: {words, hedges, vague, fillers, restarts}, transferHeadline, deck}` |
| `session.ended` | a session ends; sent again with the updated summary when Bee settles one of its attempts late (and no drill has started since) | `{summary}` |

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
  "transferHeadline": "Unsure words and filler \"like\" dropped in your real conversations since you started practising; the one you didn't practise stayed the same",
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

- **Data.** `real/deck.json` (cards from the existing pipeline; `npm run hub:cards` adds deterministic hedge and "like" cards from the wearer's own Bee lines), `real/hub-attempts.json`, and the analysed sessions (`real/corpus.json`, `real/class-*.json`, `real/meetings.json`, plus `real/live/sessions.json`: finished conversations the running hub ingested itself, see [`live.md`](live.md)). All are gitignored.
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
8. **Session summary.** The summary counts counted, unverified and bee-overrules attempts, and each line once (`lines` add up to `cards`).
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
  - Use `GET /api/transfer` for the chart: before/after per habit with the `ci95` whiskers, the verdict chip, and the control habit shown beside the drilled ones. Show `unregistered` as "not pre-registered". Word the overall result from `claim` (or show `headline`); never decide from the verdicts that the drilling worked.
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
  | `start_drill` | `POST /api/session/start {by:"mcp", size}` |
  | `submit_attempt(text)` | `POST /api/attempt {source:"mcp", text}` (returns at once) |
  | `get_verdict(attempt_id)` | `GET /api/attempts/<id>` |
  | `drill_status` | `GET /api/session` |
  | `next_card` | `POST /api/session/next` |
  | `end_drill` | `POST /api/session/end` |
  | `how_did_i_do(range)` | `GET /api/stats` |
  | `did_it_transfer` | `GET /api/transfer` |
  | `pre_meeting_brief` | `GET /api/brief` |

- **Waiting for Bee: two turns.** A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn.
  - `submit_attempt` returns at once with `narration` and the attempt id. End the turn there and keep the session open.
  - The next turn ("how did I do?") calls `get_verdict(attempt_id)`, which maps to `GET /api/attempts/<id>`. When `verdictReady` is false, narrate the waiting line and invite the user to ask again after `retryAfterMs`.
  - Never block a turn waiting for Bee. Worst case, the verdict is ready about 45 s after speech end (stream at 30 s, poll, then give up).
- **What not to do.** Never present a `provisional` grade as the result. Bee's grade is the one that counts.
- **Web simulator.** It can subscribe to `GET /api/events` (SSE) instead of the WebSocket.

# Contract v2

Frozen on 2026-10-16, before packets A, B and C start. The lead owns the files that define it (see [Ownership](#ownership)); a packet never edits them. If a packet needs a contract change, it stops and asks the lead.

v2 adds:

- live coaching from Bee's stream: a rolling conversation window, opt-in wrist nudges with latency hops, and a recap after each conversation;
- `coachNow`, a deterministic "how am I doing?" narration for Alexa and MCP;
- practice meters from the phone mic (room-scoped, 10 Hz) and a practice summary;
- the speaking mirror's focus, plugins, a public-access gate, static mounts and fixture mode.

The examples below are **hand-written synthetic payloads** for the invented demo wearer "Ada". They live in [`fixtures/contract-v2/`](../fixtures/contract-v2/), are typed against `contract.ts` in [`src/hub/contractExamples.ts`](../src/hub/contractExamples.ts), and the blocks in this document are generated from them (`npm run contract:fixtures`). `test/contract-v2.test.ts` fails if a file or a block drifts. Times are on the demo clock (2026-10-20 13:30 EDT = `1792517400000`).

**Fixture files** (`fixtures/contract-v2/`):

| File | Shape | Used for |
|---|---|---|
| `live.json` | `LiveState` | `GET /api/live` (mid-conversation snapshot) |
| `live-mode-on.json`, `live-mode-off.json` | `LiveModeResponse` | `POST /api/live/mode` |
| `recap.json` | `Recap` | `GET /api/recaps/<id>`, `recap.ready` |
| `recaps.json` | `RecapList` | `GET /api/recaps` |
| `coach-now.json` | `CoachNow` | `GET /api/coach/now` (after the conversation) |
| `demo-live.json` | `DemoLiveResponse` | `POST /api/demo/live` |
| `events-live.json` | `{events: {atMs, topic, payload}[]}` | the sequenced events of the demo story |
| `practice-meters.json` | `{frames: PracticeMeters[]}` | one second of meters at 10 Hz |
| `events-practice.json` | `{events: [...]}` | `mirror.focus`, `practice.summary` |
| `demo-mirror.json` | `DemoMirrorResponse` | `POST /api/demo/mirror` |
| `requests.json` | request bodies and bridge frames | every v2 request and client frame |
| `mcp-tools.json` | `MCP_TOOLS` | the MCP tool list |
| `alexa-how-am-i-doing.json` | Alexa request and response envelopes | one `HowAmIDoingIntent` turn |

## Privacy rules (v2)

1. **Wearer-only text.** The only transcript text a v2 route or topic may carry is the wearer's own words:
   - `Recap.moment.text` (at most 12 words) and its `rephrase`;
   - `PracticeMeters.caption`, the interim words of the person practising. It is room-scoped, sent only to that room's screens, and never persisted.

   `LiveWindow`, `Nudge`, `NudgeSkipped`, `ConversationEnded`, `LiveState` and `CoachNow` carry **no** transcript text. Nudge and wrist text is generated from the rule (`"[coach] 5 unsure words in 2 minutes. ..."`, at most 60 characters) and never quotes a transcript.
2. **Other speakers are counted only.** They appear as `others.lines`, `others.words`, `otherLines` and `talkShare`. Their text is never stored, served, logged, put in a fixture or sent to a model. The live engine keeps the v1 rule: stream text stays in memory until Bee tags it as the wearer (score at least 0.5), and anything else is forgotten after 3 minutes.
3. **The coaching principles are never served.** `coach/principles.local.md` (the operator's own notes, gitignored) is read at runtime by packet A only, to set thresholds and to phrase optional model recaps.
   - Its text never appears in a response, an event, a log, a fixture, a commit or a model output. A model phrasing that shares a 5-word shingle with it is rejected, and the template phrasing is used instead.
   - The committed [`coach/principles.template.md`](../coach/principles.template.md) is a generic default.
   - `npm run leak-check` fails on any 5-word shingle of the private principles, and on any term listed in `coach/private-terms.local.txt`, found in a committable file.
4. **Persistence.** Live state goes under `<stateDir>/live/`: `real/live/` in live mode (gitignored, and screened as wearer text by the leak check) or `out/demo/live/` in demo mode.
5. **No model call in a request path.** `/alexa`, `/mcp`, `GET /api/coach/now` and every other route answer deterministically. The only model call in v2 is the optional recap phrasing: off the request path, serialized, with a 6 s timeout and the template as the fallback.
6. **Bee is still the input of record.** Phone meters and summaries are `provisional: true`. Alexa and phone drill text is provisional exactly as in v1.

## Public-access gate (`src/hub/gate.ts`)

A tunnel (`ngrok http 8791`, run by the operator) would expose the wearer's words, and so would any web page the wearer opens while the hub runs (a page can call `http://127.0.0.1:8791` from the browser). Every request passes two checks first: trust and Origin.

- **When a request is public.** It carries a proxy header (`x-forwarded-for`, `forwarded`, `x-forwarded-host`, `x-real-ip`, `cf-connecting-ip`; ngrok adds `x-forwarded-for`), or its `Host` is not loopback or LAN, or its **socket** does not come from this machine. Loopback means `localhost`, `127.0.0.0/8` or `::1`. LAN means `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6 ULA or link-local, `*.local`, `*.home.arpa`, or this machine's hostname. A missing `Host` counts as public.
  - **LAN devices are public by default.** A connection from another device on the LAN (a LAN socket address) is trusted only when the hub runs with `--lan` (or `HUB_TRUST_LAN=1`). Use it for a real Fire TV stick on home Wi-Fi; never on shared Wi-Fi. The VVD's reverse port forward, the Vite dev proxies and the hub's own clients connect from loopback and need nothing.
  - TCP tunnels (`ngrok tcp`, `ssh -R`) arrive from loopback with no proxy header and would look local: use `ngrok http` only. As a backstop, while `PUBLIC_BASE_URL` is set, `/mcp` needs the bearer and `/alexa` the Alexa signature from every caller, loopback included. `/api`, SSE and `/ws` stay open to loopback (the TV on this machine holds no token).
- **What a public request may reach:**

  | Public request | Allowed when |
  |---|---|
  | `POST /alexa` | always (the skill itself checks the skill id and timestamp) |
  | `GET`/`HEAD` `/p/*`, `/sim/*` | always (static files only) |
  | `/mcp` (any method) | `Authorization: Bearer $MCP_TOKEN`; `OPTIONS` without it |
  | `/ws` WebSocket upgrade | the pair token: the subprotocol `k.<base64url(PAIR_TOKEN)>` offered next to `speaking-mirror` (the phone page), or `?k=$PAIR_TOKEN` |
  | `GET /api/stats`, `GET /api/transfer`, `GET /api/recaps` (exact paths; not `/api/recaps/<id>`) | the pair token in the header `x-pair-token: <base64url(PAIR_TOKEN)>` (the phone page's Progress tab). Never in the URL: `?k=` does not open them. The Origin check still runs first, so a foreign page holding the token gets `403 forbidden_origin` |
  | anything else | never: `403 {"error":"forbidden","message":"..."}`; a refused upgrade gets a 403 line and its socket destroyed |

- **Trusted** requests (loopback, or LAN with `--lan`) are not gated by the table above. The TV joins `/ws` without `k`. MCP from a trusted client needs no token, and a plugin must not weaken the gate for public requests.
- **Origin check (every request, trusted or not).** A request without `Origin` is a non-browser client (Alexa, the MCP SDK, curl, the Vega app) and passes. A request whose `Origin` is not allowed gets `403 {"error":"forbidden_origin"}`, except `GET`/`HEAD` of the static pages (`/tv/`, `/p/`, `/sim/`), `/mcp` with the bearer token, and the `OPTIONS /mcp` preflight (a browser sends it without `Authorization`; it returns no data), which echo the `Origin`. A `/ws` upgrade with a foreign `Origin` is refused unless it presents the pair token. Allowed origins:
  - the hub's own: `http://{localhost, 127.0.0.1, [::1], <lan-ip>, <hostname>, <hostname>.local}:<port>`, and the same origin as a loopback or LAN `Host`;
  - `PUBLIC_BASE_URL`;
  - the Vite dev servers on the same hosts: `5183` (tv/web), `5184` (web/phone), `5175` (web/sim);
  - `HUB_ALLOWED_ORIGINS` (comma-separated, for anything else).
- **CORS.** There is no wildcard. An allowed `Origin` is echoed in `access-control-allow-origin`, and every answer carries `vary: origin`. A request without `Origin` gets no CORS header.
- **Tokens.** `PAIR_TOKEN` and `MCP_TOKEN` come from the environment. When one is unset, the hub reuses the one an earlier start saved in `<stateDir>/tokens.json` (gitignored, mode 0600), or generates a random one and saves it there; `--rotate-tokens` makes new ones. Only a newly generated pair token is printed in full, once (`hub: PAIR_TOKEN is unset; generated: ...`). The MCP token is only ever printed as its last 4 characters (read it from `tokens.json`, or export your own), and so is a reused pair token. Tokens never appear in an HTTP response, an event or a log line. The one exception is by design: the pair token is in the bridge `welcome.joinUrl` of an **authenticated** peer (the TV needs it for the QR code). A peer is authenticated when it presented the pair token, or when it is trusted and its `Origin` is allowed or absent. Any other peer gets `welcome.joinUrl` without `#k=`. `/api/health` reports only whether each token came from `env` or was `generated`.
- **`PUBLIC_BASE_URL`** (for example the ngrok `https://` origin) is the base of the phone join URL. `welcome.joinUrl` is `<PUBLIC_BASE_URL or http://<lan-ip>:<port>>/p/<code>#k=<PAIR_TOKEN>` (the `#k=` part for authenticated peers only); the TV turns it into a QR code. The token rides in the URL fragment, which the browser never sends to a server, so it stays out of tunnel logs; the phone page reads it (or an older `?k=`), removes it from the address bar, and connects to `wss://<host>/ws` (or `ws://` on the LAN) offering the subprotocols `speaking-mirror` and `k.<base64url(k)>`, so the token is in no URL a proxy or tunnel logs (the bridge may select only `speaking-mirror`, so the hub answers with it and never with the token, whatever order the subprotocols come in; a tunnel's request inspector still shows request headers). Hub logs carry paths only, never a query string.
- **Bridge frames are validated before the bridge sees them** (`src/hub/bridgeGuard.ts`): field types and lengths per message type, at most 256 kB per frame, one `hello` per socket, and no binary frames. A refused frame gets `{"type":"error","code":"bad-message"}`, and a socket-level error closes that socket only. A screen's malformed room code is dropped, so it gets a fresh room. A `clientId` that the other role already holds in that room is refused. A peer with more than 256 kB queued misses `practice.meters` frames, and one above 4 MB is disconnected. A room with no screen (its TV left) is closed by the bridge after 60 s, and a phone still in it is told the room closed.
- **SSE and `/api/*` are trusted-only** (loopback, or the LAN with `--lan`), except the three paired reads above. With the pair token they answer a phone through the tunnel, or on the LAN without `--lan`, so the phone's Progress tab shows the same week, before and after and recaps as the TV (masked like every JSON answer). The token opens nothing else: `/api/live`, `/api/settings`, `/api/instrument`, SSE, health and every write stay trusted-only. The simulator shows the SSE feed only when it is opened on the LAN. Opened through the tunnel, it uses `/mcp` alone. It takes the MCP token from its URL fragment (`/sim/#t=<MCP_TOKEN>`, which is never sent to a server) or from a prompt.

## Plugins (`src/hub/plugin.ts`, `src/hub/plugins.ts`)

```ts
interface HubPlugin {
  name: string;
  prefixes: string[]; // path prefixes it owns, matched on segment boundaries ("/api/live" matches /api/live and /api/live/mode)
  attach?(ctx: PluginCtx): void; // once, before the server listens
  route?(req, res, url: URL, ctx: PluginCtx): Promise<boolean>; // true = answered; false = fall through
  onApp?(room, msg: AppMsg, from: PeerInfo, ctx: PluginCtx): IntentResult | undefined; // undefined = not mine
  describe?(): { owner; status: "stub" | "ready" | "degraded" | "off"; routes: string[]; topics?: string[]; note?: string };
  stop?(): void;
}
interface PluginCtx {
  hub: CoachHub; setup: Setup; bridge: BridgeHub;
  stateDir: string | null; // "real" (live), "out/demo" or null (demo); write under <stateDir>/<plugin>/
  pace: number; demo: boolean; fixtureV2: boolean;
  log(event, data?): void; // JSON lines: event names and ids only
  publish(topic: SequencedTopic, data): HubEvent; // seq + SSE + recent + every peer; throws for room topics
  broadcastToScreens(room: Room | string | null, topic: RoomTopic, payload): number; // one room's screens (null: every room); <= 20 Hz per room and topic; returns screens reached (0 when throttled; the latest throttled frame is still sent when the window ends)
  selfUrl(): string; // http://127.0.0.1:<port>, for a loopback hub client (a LAN request for the gate)
  auth: { mcpBearerOk(authorization): boolean; pairTokenOk(k): boolean }; // the tokens themselves are never handed out
  isPublic(req): boolean;
  json(res, status, data, opts?: { premasked?: boolean }): void; // masked for the request's mode, unless the plugin masked it itself (the Alexa plugin)
  readJson(req): Promise<object>;
}
```

**Registry.** The registry is fixed, in this order. Each module exports the named factory, and packets keep the export names, prefixes and routes.

| Plugin | Module (factory) | `owner` in health | Prefixes |
|---|---|---|---|
| `live` | `src/hub/live/plugin.ts` (`createLivePlugin`) | live coaching | `/api/live`, `/api/recaps`, `/api/coach`, `/api/demo/live` |
| `mirror` | `src/hub/mirror.ts` (`createMirrorPlugin`) | practice mirror | `/api/demo/mirror` |
| `static` | `src/hub/static.ts` (`createStaticPlugin`) | hub | `/tv/`, `/p/`, `/sim/` |
| `alexa` | `src/alexa/plugin.ts` (`createAlexaPlugin`) | Alexa skill | `/alexa` |
| `mcp` | `src/mcp/plugin.ts` (`createMcpPlugin`) | MCP server | `/mcp` |

**Request order.**

1. The gate.
2. Fixture mode, if it is on.
3. The plugins, in registry order, for a path under their prefixes. `OPTIONS` requests reach the plugins too, so the MCP plugin can answer its own preflight.
4. The generic `OPTIONS` answer: `204` with the allowed `Origin` echoed (never `*`), methods `GET, POST, DELETE, OPTIONS`, and headers `content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id`.
5. The v1 routes.
6. `404 not_found`.

A plugin that throws gets `500 {"error":"plugin_error"}`.

**Bridge frames.** For bridge `app` frames, the v1 topics are handled first. Any other topic is offered to each plugin's `onApp` in order, and the first result that is not `undefined` wins: `null` means handled with no intent.

**Stubs.** Until a packet lands, its plugin is a stub. Each planned route answers `501 {"error":"not_implemented","message":"...","plugin","owner","routes"}`, and `describe().status` is `"stub"`.

**`core.ts` helpers** (packet A owns `core.ts` and must keep these):

- `hub.publish(topic, data)` throws for a room topic or for any topic not in `SEQUENCED_TOPICS`.
- `hub.publishLiveWindow(window)` publishes `live.window` at most once per 3 s per `conversationId`. A window that arrives too soon is held (a newer one replaces it) and published when the 3 s are up. It returns `"sent"` or `"held"`.
- `hub.cancelLiveWindow(conversationId)` drops a held window. Call it before `conversation.ended`.
- `hub.dispose()` clears the timers.

`Setup` gains `stateDir` and `pace`.

## Routes (v2)

| Method and path | Owner | Request | 2xx response | Errors |
|---|---|---|---|---|
| `GET /api/live` | A (`live`) | | `200 LiveState` | |
| `POST /api/live/mode` | A (`live`) | `LiveModeRequest {enabled, minutes? (1-180, default 60), by?, rules?}` | `200 LiveModeResponse {mode, narration}`, then `live.mode` | `400 bad_request` |
| `GET /api/recaps?limit=10` | A (`live`) | `limit` 1-50 | `200 RecapList {dataLabel, synthetic, recaps[]}` (newest first) | |
| `GET /api/recaps/<id>` | A (`live`) | | `200 Recap` | `404 unknown_recap` |
| `GET /api/coach/now` | A (`live`) | | `200 CoachNow` | |
| `GET /api/coach/facts` | W (`live`) | | `200 BeeMemory {dataLabel, synthetic, enabled, status, goal, insights, facts, note, stopped}`; `status: "off"` (the default) makes no Bee call | |
| `POST /api/coach/cue` | W (`live`) | `CueRequest {inMinutes? (0-180, default 0), by?}` | `200 CueResponse {cue, wrist, deduped, narration}` | `400 bad_request`, `409 cues_off`, `409 no_practised_habit`, `409 quiet_hours`, `429 cue_cap`, `503 wrist_down` |
| `GET /api/settings?source=bee` | A (`live`) | `source` bee (default) or all | `200 SettingsResponse` (conversation settings; a secondary view) | `400 bad_source` |
| `POST /api/sessions/<id>/setting` | A (`live`) | `SettingRequest {setting: "meeting" \| "work" \| "casual" \| null}`; `<id>` a stats session id, a recap's `conversationId` or a recap id | `200 SettingResponse {id, tag, recapIds}`, then `stats.updated` | `400 bad_request`, `404 unknown_session` |
| `POST /api/demo/live` | A (`live`) | `DemoLiveRequest {script?: "story" \| "monologue" \| "short"}` | `202 DemoLiveResponse` | `400 demo_only`, `400 bad_request` |
| `POST /api/demo/mirror` | B (`mirror`) | `DemoMirrorRequest {script?: "practice-take" \| "focus", view?, room?}` | `202 DemoMirrorResponse` | `400 demo_only`, `400 bad_request` |
| `POST /alexa` | C (`alexa`) | Alexa request envelope | `200` Alexa response envelope | `400 alexa_rejected` (bad skill id, or a timestamp more than 150 s off) |
| `POST /mcp` (`GET`/`DELETE` answer 405) | C (`mcp`) | MCP JSON-RPC over Streamable HTTP, stateless | JSON-RPC result | JSON-RPC errors; tool errors as `isError: true` |
| `GET /tv/*`, `/p/*`, `/sim/*` | lead (`static`) | | the built files; paths without an extension fall back to `index.html` | `404 not_built` (with the build command), `404 not_found`, `400 bad_path`, `405 method_not_allowed` |

New error codes: `not_implemented` (501), `forbidden` (403), `unknown_recap` (404), `unknown_session` (404), `not_built` (404), `bad_path` (400), `method_not_allowed` (405), `plugin_error` (500), `alexa_rejected` (400), `cues_off` (409), `no_practised_habit` (409), `quiet_hours` (409), `cue_cap` (429), `wrist_down` (503).

**Live mode policy** (frozen numbers; packet A implements them):

- Off by default. Turning it on lasts `minutes` (default 60), then it turns itself off with `reason: "expired"` and a `live.mode` event.
- Nudges are at least 3 min apart, and the same rule fires at most once per 10 min. Caps: 6 per hour, 20 per day.
- No nudge in a conversation's first 60 s, in quiet hours (22:00 to 08:00 local) or while a drill card is open.
- Every suppression publishes `nudge.skipped` with its reason. When live mode is off, a rule that fires is `nudge.skipped` with reason `off`.
- Rules (thresholds relative to the wearer's baseline):
  - `hedge-streak`: at least max(3, 2 × expected) hedges in 120 s;
  - `like-streak`: at least max(4, 2 × expected) "like" fillers in 120 s;
  - `monologue`: 90 s or more;
  - `fast-rate`: off by default.
- Recaps are computed for every conversation with at least 60 wearer words, live mode or not. They go to the wrist only when live mode is on; otherwise `delivery.wrist` is `"off"`.

### `POST /api/live/mode` (Alexa: "turn on live coaching")

Request: `{"enabled": true, "minutes": 60, "by": "alexa"}`. Response:

<!-- fixture: live-mode-on.json -->
```json
{
  "mode": {
    "rules": {
      "hedge-streak": true,
      "like-streak": true,
      "monologue": true,
      "fast-rate": false
    },
    "quietHours": {
      "startHour": 22,
      "endHour": 8
    },
    "warmupMs": 60000,
    "cooldownMs": 180000,
    "ruleCooldownMs": 600000,
    "capPerHour": 6,
    "capPerDay": 20,
    "enabled": true,
    "since": 1792517430000,
    "expiresAt": 1792521030000,
    "changedAt": 1792517430000,
    "by": "alexa",
    "reason": "on",
    "sent": {
      "lastHour": 0,
      "today": 0
    }
  },
  "narration": "Live coaching is on for 60 minutes. I'll set a reminder on your wrist if a habit keeps coming up."
}
```
<!-- /fixture -->

### `GET /api/live`

[`live.json`](../fixtures/contract-v2/live.json) is a snapshot taken mid-conversation, just after the nudge. It has the `mode`, the current `conversation` (`LiveWindow`, or null), `drillActive`, `baseline`, `wrist` (`WristStatus`), `lastNudge`, `recentNudges`, `recentSkips` (newest first, at most 10) and `lastRecapId`. The baseline (`range`, additive: `"week"`, or `"all"` when the week holds too few words and every Bee conversation is used):

<!-- fixture: live.json#/baseline -->
```json
{
  "source": "bee week (non-drill conversations; synthetic)",
  "range": "week",
  "words": 1400,
  "hedgesPer100": 1.43,
  "likesPer100": 1.79,
  "fillersPer100": 2.43,
  "wpm": 140
}
```
<!-- /fixture -->

### `GET /api/recaps/<id>` (and `recap.ready`)

<!-- fixture: recap.json -->
```json
{
  "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
  "synthetic": true,
  "id": "rcp_demo_0001",
  "conversationId": "demo-0000-4000-8000-000000000101",
  "startedAt": 1792517460000,
  "endedAt": 1792517868000,
  "durationMs": 408000,
  "createdAt": 1792517868300,
  "replay": true,
  "metrics": {
    "wearerWords": 520,
    "wpm": 138,
    "baselineWpm": 140,
    "talkShare": 0.57,
    "longestMonologueMs": 74000,
    "pauses": {
      "count": 19,
      "longestMs": 3100
    },
    "habits": [
      {
        "key": "hedges",
        "label": "unsure words (I guess, I think, maybe, kind of...)",
        "count": 11,
        "per100": 2.12,
        "baselinePer100": 1.43,
        "verdict": "worse"
      },
      {
        "key": "filler:like",
        "label": "filler \"like\"",
        "count": 6,
        "per100": 1.15,
        "baselinePer100": 1.79,
        "verdict": "better"
      },
      {
        "key": "vague",
        "label": "vague answers",
        "count": 1,
        "per100": 0.19,
        "baselinePer100": 0.64,
        "verdict": "better"
      },
      {
        "key": "restart",
        "label": "starting over (the the, I I)",
        "count": 3,
        "per100": 0.58,
        "baselinePer100": 0.86,
        "verdict": "typical"
      }
    ]
  },
  "headline": "Unsure words ran high: 2.1 per 100 words against your usual 1.4. Filler \"like\" was down.",
  "moment": {
    "text": "I guess we could maybe ship the export on Friday.",
    "at": 1792517601000,
    "habit": "hedges",
    "rephrase": "We could ship the export on Friday."
  },
  "narration": "That conversation ran about 7 minutes. You used 11 unsure words, 2.1 out of every 100 words you said against your usual 1.4, and your pace held at 138 words a minute. Try it without the unsure words: \"We could ship the export on Friday.\"",
  "wristText": "[coach] Recap: more unsure words than usual, pace steady",
  "phrasing": "template",
  "nudges": {
    "sent": 1,
    "skipped": 1
  },
  "delivery": {
    "wrist": "replay",
    "todoId": null
  }
}
```
<!-- /fixture -->

### `GET /api/coach/now` (Alexa: "how am I doing?"; MCP `how_am_i_doing`)

The narration is deterministic, with at most 4 sentences. It leads with the live conversation (`basis: "live"`), else the last recap of the day (`"recap"`), else the week (`"week"`). Then, only when a drilled habit has a next conversation since its first drill, one sentence with the first signal (`GET /api/transfer` `firstSignal`; "too short to compare" instead of a number when a side has under 100 words). It then adds the week's top habit, due drills and the live-mode status.

<!-- fixture: coach-now.json -->
```json
{
  "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
  "synthetic": true,
  "generatedAt": 1792517913000,
  "basis": "recap",
  "narration": "Your last conversation ran high on unsure words: 11, or 2.1 out of every 100 words you said, against your usual 1.4. First signal, from one conversation and not proof: in your next conversation after practising, unsure words went from 2.6 to 0.8 and filler \"like\" from 3.2 to 0.8 per 100 words. This week, unsure words are at 1.4 per 100 words, and 2 lines are ready to practise. Live coaching is on until 2:30 PM.",
  "mode": {
    "rules": {
      "hedge-streak": true,
      "like-streak": true,
      "monologue": true,
      "fast-rate": false
    },
    "quietHours": {
      "startHour": 22,
      "endHour": 8
    },
    "warmupMs": 60000,
    "cooldownMs": 180000,
    "ruleCooldownMs": 600000,
    "capPerHour": 6,
    "capPerDay": 20,
    "enabled": true,
    "since": 1792517430000,
    "expiresAt": 1792521030000,
    "changedAt": 1792517430000,
    "by": "alexa",
    "reason": "on",
    "sent": {
      "lastHour": 1,
      "today": 1
    }
  },
  "live": null,
  "lastRecap": {
    "id": "rcp_demo_0001",
    "endedAt": 1792517868000,
    "headline": "Unsure words ran high: 2.1 per 100 words against your usual 1.4. Filler \"like\" was down."
  },
  "week": {
    "words": 1400,
    "hedgesPer100": 1.43,
    "likesPer100": 1.79,
    "vaguePer100": 0.64,
    "topHabit": {
      "key": "hedges",
      "label": "unsure words",
      "per100": 1.43
    }
  },
  "drills": {
    "dueNow": 2,
    "nextCardId": "demo:hedge-i-guess"
  },
  "transferHeadline": "Unsure words and filler \"like\" dropped in your real conversations since you started practising; the one you didn't practise stayed the same"
}
```
<!-- /fixture -->

### `GET /api/coach/facts` (Bee memory; packet W)

The coach's one goal fact in Bee, and Bee's insight and fact counts (`BeeMemory`, `src/hub/live/facts.ts`, [live.md](live.md) "Bee memory"). Opt-in: `COACH_FACTS=1` in live mode with the Bee stream. `status`:

- `"off"` (the default): no Bee call of any kind; `goal`, `insights` and `facts` are null.
- `"demo"`: nothing is written; `goal` is the text the coach would write (`factId: null`).
- `"pending"`: on, no confirmed goal fact yet. With `goal: null` nothing is being saved: the goal is written after the next Bee-verified pass. With a goal, its create or confirm is on its way.
- `"synced"`: the goal fact exists in Bee, confirmed, with this text.
- `"failed"`: the last write failed, or a create Bee does not list yet or never listed (looked for at most 5 times, never made again). The facts breaker (3 failed calls, 30 min) never makes the status `"failed"` by itself, so failed count reads never read as a save that failed. Live coaching is not affected.

`stopped` (additive, always sent) tells the failures apart. It is `true` only when the status is `"failed"` because the coach stopped looking for a create Bee never listed: nothing tries it again on its own, also after a restart, until the operator follows the reset steps in [live.md](live.md) "Bee memory". The goal may still be in Bee (a create that exited 0 without an id did land), so a screen says Bee never listed it, never that it didn't save. It is `false` for every other status and for every failure the hub tries again (a failed write, a look still due, the open breaker). A hub from before the field sends no `stopped`; a screen reads that as `false`.

`goal.text` is template text only (numbers, the fixed habit names, the transfer verdicts; `GOAL_TEXT_RE`). `insights` and `facts` are counts read every 6 h, never their text. `note` is always `BEE_MEMORY_NOTE`. When the memory changes the hub re-sends `stats.updated`.

Demo hub:

```json
{
 "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)",
 "synthetic": true,
 "note": "Bee's chat and Alexa+ may not read coach-written facts.",
 "enabled": true,
 "status": "demo",
 "goal": {
  "factId": null,
  "text": "Speaking goal (Speaking Mirror): fewer unsure words and filler \"like\". Since Oct 15: unsure words 2.1 → 0.6 per 100 words; filler \"like\" 2.5 → 0.8 per 100 words; 4 lines passed, checked by Bee.",
  "confirmed": false,
  "updatedAt": 1792411626000
 },
 "insights": null,
 "facts": null,
 "stopped": false
}
```

Live, after a pass (illustrative ids and counts):

```json
{ "dataLabel": "real data (gitignored)", "synthetic": false, "note": "Bee's chat and Alexa+ may not read coach-written facts.",
  "enabled": true, "status": "synced",
  "goal": { "factId": "901", "text": "Speaking goal (Speaking Mirror): fewer unsure words and filler \"like\". Since Oct 17: unsure words 2.6 → 0.8 per 100 words; filler \"like\" needs more speech; 3 lines passed, checked by Bee.", "confirmed": true, "updatedAt": 1792530000000 },
  "insights": { "count": 0, "readAt": 1792528000000 }, "facts": { "count": 12, "readAt": 1792528000000 }, "stopped": false }
```

Live, after the coach stopped looking for a create Bee never listed (illustrative counts):

```json
{ "dataLabel": "real data (gitignored)", "synthetic": false, "note": "Bee's chat and Alexa+ may not read coach-written facts.",
  "enabled": true, "status": "failed",
  "goal": { "factId": null, "text": "Speaking goal (Speaking Mirror): fewer unsure words and filler \"like\". Since Oct 17: unsure words 2.6 → 0.8 per 100 words; filler \"like\" needs more speech; 3 lines passed, checked by Bee.", "confirmed": false, "updatedAt": null },
  "insights": { "count": 0, "readAt": 1792528000000 }, "facts": { "count": 12, "readAt": 1792528000000 }, "stopped": true }
```

### `POST /api/coach/cue` (the if-then wrist cue; packet W)

`CueRequest {inMinutes? (0-180, default 0), by?}` -> `200 CueResponse` (`src/hub/live/cue.ts`, [live.md](live.md) "Wrist cue"). One fixed line, at most `WRIST_TEXT_MAX` characters, through the wrist queue as a Bee to-do with an alarm `inMinutes` from now (never sooner than the lead). Opt-in: `COACH_CUES=1` in live mode; the demo hub always answers on the replay wrist.

- `cue.habit` is a pre-registered drilled habit already practised (`CUE_HABITS`): never the control (`restart`), never an unpractised habit.
- `deduped: true`: a cue for the same habit has its alarm within 10 min of this one's (the alarms are compared, not the request times); that cue comes back and nothing new reaches the wrist. Its narration says "already set for <time>" only while the alarm is still to come, else "went off N min ago".
- `wrist.status: "failed"` (200): Bee did not take the to-do; it counts toward neither the dedupe nor the cap. A request that arrived while that send was in flight gets the same failed answer, never `deduped: true`.
- Errors: `400 bad_request`; `409 cues_off`; `409 no_practised_habit`; `409 quiet_hours` (the alarm falls between 22:00 and 08:00 local); `429 cue_cap` (3 a day); `503 wrist_down` (the wrist circuit is open).
- The texts: `[coach] If asked for status: result first, no "I guess".` (`hedges`) and `[coach] If you need a second: pause, don't say "like".` (`filler:like`). Never a calendar title or a transcript line. The hub has no calendar timer: the coaching skill decides when.

Demo hub, `{"inMinutes": 10, "by": "skill"}`:

```json
{
 "cue": { "id": "cue_mvgyktu000", "habit": "filler:like", "text": "[coach] If you need a second: pause, don't say \"like\".", "alarmAt": 1792518000072, "by": "skill" },
 "wrist": { "channel": "replay", "status": "replay", "todoId": null, "error": null },
 "deduped": false,
 "narration": "Demo cue, no Bee call: the wrist alarm would go off at 1:40 PM. If you need a second: pause, don't say \"like\"."
}
```

Then `{}` at once (its alarm, the wrist lead from now, is within 10 min of 1:40 PM): the same `cue` and `wrist`, with `"deduped": true` and the narration "That cue is already set for 1:40 PM, so I didn't send another."

Live, the wrist answer is `{"channel": "bee-todo", "status": "scheduled", "todoId": "<Bee to-do id>", "error": null}`, and the narration starts "Cue set: your wrist alarm goes off at ...".

### Conversation settings: `GET /api/settings` and `POST /api/sessions/<id>/setting`

Each conversation gets a setting, so the coach compares like with like: `meeting`, `work` or `casual` (shown as "Meeting", "Work talk", "Casual", `SETTING_NAME`). It is a **secondary, labelled view**: `GET /api/transfer` (headline, claim, verdicts, first signal) never reads it, and `test/settings.test.ts` and `npm run contract:check` assert that the transfer is identical with and without settings data. Additive: older hubs answer `404 not_found`, and a screen then hides the strip.

- **Automatic tag** (`SettingTag.source: "auto"`), deterministic, from counts and times only:
  1. `meeting`: a captions session; a Bee conversation a captions session matches by time (`pairMeetings`, 45 min); or one that overlaps a calendar event the hub has seen (start and end times only; without an end, 30 min; from 10 min before).
  2. `work`: a weekday inside the work hours (`COACH_WORK_HOURS`, default `09:00-18:00`, in `BEE_TZ`) with 2 to 4 distinct speakers.
  3. `casual`: everything else. `confidence: "low"` when, on a weekday in work hours, the speaker count was missing (`speakers-unknown`) or outside 2-4 (`speakers-out-of-range`).
- **The wearer's choice wins** (`source: "you"`). `setting: null` goes back to the automatic tag. It is saved in `<stateDir>/live/settings.json` (ids, a setting, times; gitignored under `real/live/`). A recap's `conversationId` (the stream's uuid) and the stats session Bee completes later (its numeric id) are matched by time, both ways, when their spans mostly overlap. A choice set by a stats session's id stays on that session and never moves to another stats session.
- **Rates** need `minWords` (the pre-registration's `min_words_per_period`, 400) English words; below that a rate is `null` and the line says "too little speech". Drill lines are left out, as in the transfer.
- **Recaps** carry `setting` (the choice when there is one, else the automatic tag) and `metrics.baselineSetting`: the setting whose usual the recap compared against, when that setting has at least 400 words (this week, else all Bee conversations); otherwise `null` and the overall usual. The headline then says where: `... against your usual 1.4 at work.` A correction changes the chip, the per-setting rates and the served comparison: when a recap's setting is no longer the one its usual came from, `GET /api/recaps`, `GET /api/recaps/<id>` and `GET /api/coach/now` say where the usual came from (`... against your usual 1.4 from work talk.`). Only the setting's words right after a usual change, never a quote or the wearer's moment, and setting it back restores the first wording. `recap.ready` keeps the wording the recap was made with, so the TV refetches `GET /api/recaps/<id>` after the wearer's last press and shows the served headline and narration while its chip shows that setting.
- **`CoachNow.lastRecap.setting`** names the last conversation's setting.

```json
GET /api/settings (SYNTHETIC demo, trimmed)
{
  "dataLabel": "SYNTHETIC DEMO DATA (invented; not anyone's real results)", "synthetic": true,
  "source": "bee", "minWords": 400,
  "note": "a secondary view: the setting of each conversation, so like is compared with like; the pre-registered before and after (GET /api/transfer) does not use it",
  "workHours": { "start": "09:00", "end": "18:00", "days": "Mon-Fri", "tz": "America/Toronto" },
  "sessions": [{ "id": "demo-bee-1010", "kind": "conversation", "date": "2026-10-10", "startMs": 1791675000000, "words": 223, "tag": { "setting": "casual", "source": "auto", "confidence": "high", "reasons": ["weekend"] } }],
  "rates": [
    { "setting": "meeting", "name": "Meeting", "sessions": 1, "words": 316, "enough": false, "per100": { "hedges": null, "filler:like": null, "vague": null, "restart": null } },
    { "setting": "work", "name": "Work talk", "sessions": 5, "words": 1400, "enough": true, "per100": { "hedges": 1.43, "filler:like": 1.79, "vague": 0.64, "restart": 0.86 } },
    { "setting": "casual", "name": "Casual", "sessions": 4, "words": 885, "enough": true, "per100": { "hedges": 0.9, "filler:like": 1.13, "vague": 0.23, "restart": 0.68 } }
  ],
  "practised": [{ "habit": "hedges", "label": "unsure words (I guess, I think, maybe, kind of...)", "cutoverAt": 1792080600000, "bySetting": [
    { "setting": "meeting", "name": "Meeting", "before": { "sessions": 1, "words": 316, "count": 8, "per100": 2.53 }, "after": { "sessions": 0, "words": 0, "count": 0, "per100": 0 }, "enough": false, "deltaPer100": null },
    { "setting": "work", "name": "Work talk", "before": { "sessions": 2, "words": 614, "count": 15, "per100": 2.44 }, "after": { "sessions": 3, "words": 786, "count": 5, "per100": 0.64 }, "enough": true, "deltaPer100": -1.8 },
    { "setting": "casual", "name": "Casual", "before": { "sessions": 2, "words": 451, "count": 6, "per100": 1.33 }, "after": { "sessions": 2, "words": 434, "count": 2, "per100": 0.46 }, "enough": true, "deltaPer100": -0.87 }
  ] }],
  "line": "By setting · Unsure words: meeting: too little speech · work talk 2.4 → 0.6 · casual 1.3 → 0.5"
}

POST /api/sessions/demo-bee-1017/setting {"setting": "meeting"}
{ "id": "demo-bee-1017", "tag": { "setting": "meeting", "source": "you", "confidence": "high", "reasons": ["you"] }, "recapIds": [] }
```

### `POST /api/demo/live` (demo only)

The demo replays a scripted Bee conversation for Ada through the same engine as live events:

- `story`: a nudge, a cooldown skip, then a recap;
- `monologue`: a 90 s monologue nudge;
- `short`: under 60 wearer words, so `conversation.ended` has `recap: "skipped-short"`.

The scripts do not change live mode. Turn it on first with `POST /api/live/mode`, or the first streak becomes `nudge.skipped` (reason `off`). Times scale with `--pace`.

<!-- fixture: demo-live.json -->
```json
{
  "replay": true,
  "script": "story",
  "conversationId": "demo-0000-4000-8000-000000000101",
  "description": "Ada's 7-minute conversation (synthetic): 5 hedges in 2 minutes -> nudge.sent; a second streak inside the 3-minute cooldown -> nudge.skipped; 90 s idle -> conversation.ended -> recap.ready. With live coaching off, the first streak is nudge.skipped (reason off).",
  "pace": 1,
  "steps": [
    {
      "atMs": 1000,
      "what": "conversation.started"
    },
    {
      "atMs": 31000,
      "what": "live.window"
    },
    {
      "atMs": 96000,
      "what": "live.window"
    },
    {
      "atMs": 151000,
      "what": "live.window"
    },
    {
      "atMs": 152490,
      "what": "nudge.sent"
    },
    {
      "atMs": 216000,
      "what": "live.window"
    },
    {
      "atMs": 263000,
      "what": "live.window"
    },
    {
      "atMs": 263040,
      "what": "nudge.skipped"
    },
    {
      "atMs": 319000,
      "what": "live.window"
    },
    {
      "atMs": 409000,
      "what": "conversation.ended"
    },
    {
      "atMs": 409300,
      "what": "recap.ready"
    }
  ]
}
```
<!-- /fixture -->

## Topics (v2)

All sequenced topics go to every bridge peer in every room, to SSE (`GET /api/events`) and to `GET /api/events/recent`, with a strictly increasing `seq`. The payloads below omit the `seq` and `at` the hub adds.

<!-- topics:v2 -->
| Topic | Kind | Published by | Payload | When |
|---|---|---|---|---|
| `conversation.started` | sequenced | A (`live`) | `ConversationStarted {conversationId, startedAt, replay}` | Bee `new-conversation`, or the first wearer line of a new uuid |
| `live.window` | sequenced | A (`live`), via `hub.publishLiveWindow` | `{window: LiveWindow}` | after wearer lines; at most 1 per 3 s per conversation |
| `nudge.sent` | sequenced | A (`live`) | `{nudge: Nudge}` | a rule fired, the policy allowed it, and the wrist call returned |
| `nudge.skipped` | sequenced | A (`live`) | `{skip: NudgeSkipped}` | a rule fired and the policy suppressed it (`reason`) |
| `conversation.ended` | sequenced | A (`live`) | `ConversationEnded` | Bee leaves CAPTURING, 90 s idle, or a new conversation uuid |
| `recap.ready` | sequenced | A (`live`) | `{recap: Recap}` | after `conversation.ended` (unless skipped), before the wrist |
| `live.mode` | sequenced | A (`live`) | `{mode: LiveMode}` | `POST /api/live/mode`, expiry, wrist circuit open |
| `practice.summary` | sequenced | B (`mirror`) | `{summary: PracticeSummary}` | a mic sends its take summary |
| `mirror.focus` | sequenced | B (`mirror`) | `MirrorFocus {view, by, reason, recapId, takeId, room?}` | a peer asks the mirror to show a view (`app mirror.focus`), or the demo. A phone mic's focus carries its `room`, and only that room's screens follow it |
| `practice.meters` | room | B (`mirror`), via `ctx.broadcastToScreens` | `PracticeMeters` (+ `from`) | the mic's 10 Hz frames, relayed to that room's screens only (at most 20 Hz) |
<!-- /topics:v2 -->

**Room-scoped** means no `seq`, never on SSE, never in `/api/events/recent`, never persisted, and never sent to `mic` peers. `hub.publish("practice.meters", ...)` throws.

**Rendering.** Render sequenced events in `seq` order and drop duplicates. Render room frames as they arrive; they are disposable.

**Client to hub (v2 bridge frames):**

| Frame | From | Effect |
|---|---|---|
| `app {topic:"practice.meters", payload: PracticeMeters}` | mic | relayed to the screens of the mic's room; no intent back |
| `app {topic:"practice.summary", payload: PracticeSummary}` | mic | published as `practice.summary`; intent `practice.summary` |
| `app {topic:"mirror.focus", payload:{view, reason?}}` | any | published as `mirror.focus` with `by` = the peer's name (and `room` = the mic's room for a phone mic) |

`MirrorView` is `week | transfer | drill | live | practice | recap`.

### `conversation.started`

<!-- fixture: events-live.json#/events/0/payload -->
```json
{
  "conversationId": "demo-0000-4000-8000-000000000101",
  "startedAt": 1792517460000,
  "replay": true
}
```
<!-- /fixture -->

### `live.window`

`recent` counts the last 120 s. `rules` gives each rule's current value against its threshold, with `over` true when the value reaches it.

<!-- fixture: events-live.json#/events/3/payload -->
```json
{
  "window": {
    "conversationId": "demo-0000-4000-8000-000000000101",
    "startedAt": 1792517460000,
    "updatedAt": 1792517610000,
    "replay": true,
    "lang": "en",
    "wearer": {
      "lines": 12,
      "words": 214,
      "talkMs": 91000,
      "wpm": 141
    },
    "others": {
      "lines": 9,
      "words": 152
    },
    "talkShare": 0.58,
    "monologue": {
      "currentMs": 21000,
      "longestMs": 48000
    },
    "pauses": {
      "count": 7,
      "longestMs": 2600
    },
    "recent": {
      "windowMs": 120000,
      "hedges": 5,
      "likes": 2,
      "fillers": 3,
      "vague": 1,
      "restarts": 1
    },
    "totals": {
      "hedges": 5,
      "likes": 3,
      "fillers": 4,
      "vague": 1,
      "restarts": 1
    },
    "skipped": {
      "frenchLines": 0,
      "drillLines": 0
    },
    "rules": [
      {
        "rule": "hedge-streak",
        "value": 5,
        "threshold": 4.72,
        "unit": "count",
        "over": true
      },
      {
        "rule": "like-streak",
        "value": 2,
        "threshold": 5.91,
        "unit": "count",
        "over": false
      },
      {
        "rule": "monologue",
        "value": 21000,
        "threshold": 90000,
        "unit": "ms",
        "over": false
      },
      {
        "rule": "fast-rate",
        "value": 141,
        "threshold": 175,
        "unit": "wpm",
        "over": false
      }
    ]
  }
}
```
<!-- /fixture -->

### `nudge.sent`: the latency hops

The hops come in this order (`NUDGE_HOP_ORDER`):

1. `spokenAt`: the end of the wearer line that crossed the threshold.
2. `beeAt`: Bee's wearer tag for that line reached the hub.
3. `detectedAt`: the rule fired and the policy allowed it.
4. `todoAt`: `bee todos create` returned.
5. `alarmAt`: the to-do's alarm time (the hub cannot see the buzz itself).

`latencyMs` gives the differences: `bee` = `beeAt` − `spokenAt`, `detect`, `todo`, and `total` = `alarmAt` − `spokenAt`. In this example: Bee 5.9 s, detection 40 ms, the to-do 1.45 s and a 10 s alarm lead, so the wrist alarm is set for **17.4 s** after Ada stopped speaking. If the wrist call failed, `todoAt` and `alarmAt` are null and `wrist.status` is `"failed"`.

<!-- fixture: events-live.json#/events/4/payload -->
```json
{
  "nudge": {
    "id": "ndg_demo_0001",
    "conversationId": "demo-0000-4000-8000-000000000101",
    "rule": "hedge-streak",
    "text": "[coach] 5 unsure words in 2 minutes. Say it plainly.",
    "evidence": {
      "rule": "hedge-streak",
      "value": 5,
      "threshold": 4.72,
      "unit": "count",
      "over": true,
      "windowMs": 120000,
      "expected": 2.36
    },
    "hops": {
      "spokenAt": 1792517604100,
      "beeAt": 1792517610000,
      "detectedAt": 1792517610040,
      "todoAt": 1792517611490,
      "alarmAt": 1792517621490
    },
    "latencyMs": {
      "bee": 5900,
      "detect": 40,
      "todo": 1450,
      "total": 17390
    },
    "wrist": {
      "channel": "replay",
      "status": "replay",
      "todoId": null,
      "leadMs": 10000,
      "error": null
    },
    "replay": true
  }
}
```
<!-- /fixture -->

### `nudge.skipped`

<!-- fixture: events-live.json#/events/7/payload -->
```json
{
  "skip": {
    "id": "skp_demo_0001",
    "conversationId": "demo-0000-4000-8000-000000000101",
    "rule": "hedge-streak",
    "reason": "cooldown",
    "detail": "a nudge went out 1 min 52 s ago; nudges are at least 3 min apart",
    "at": 1792517722040,
    "retryAfterMs": 68000,
    "evidence": {
      "rule": "hedge-streak",
      "value": 5,
      "threshold": 4.58,
      "unit": "count",
      "over": true,
      "windowMs": 120000,
      "expected": 2.29
    },
    "replay": true
  }
}
```
<!-- /fixture -->

### `conversation.ended`

<!-- fixture: events-live.json#/events/9/payload -->
```json
{
  "conversationId": "demo-0000-4000-8000-000000000101",
  "startedAt": 1792517460000,
  "endedAt": 1792517868000,
  "reason": "idle",
  "wearerWords": 520,
  "otherLines": 17,
  "recap": "pending",
  "replay": true
}
```
<!-- /fixture -->

### `practice.meters` (10 Hz, room-scoped)

[`practice-meters.json`](../fixtures/contract-v2/practice-meters.json) holds one second of a take: 10 frames. The phone sends `{"type":"app","topic":"practice.meters","payload":<frame>}`. The hub relays `{"type":"app","topic":"practice.meters","payload":{...frame,"from":"phone-1"}}` to the room's screens. Measurement:

- volume is RMS dBFS (with the mic's automatic gain control off);
- pitch is YIN, 70 to 400 Hz;
- `monotone` means a range under 3 semitones over the last 5 s;
- `wpm` is estimated from the syllable rate;
- a pause is 250 ms or more.

The Vega app renders at most 5 Hz. One frame:

<!-- fixture: practice-meters.json#/frames/3 -->
```json
{
  "takeId": "take_demo_01",
  "frame": 123,
  "t": 12300,
  "at": 1792518012300,
  "rmsDbfs": -24.1,
  "band": "ok",
  "voiced": true,
  "pitchHz": 205.1,
  "pitchRangeSt": 4.6,
  "monotone": false,
  "wpm": 152,
  "pause": {
    "active": false,
    "currentMs": 0,
    "count": 5
  },
  "caption": "So the export"
}
```
<!-- /fixture -->

### `practice.summary`

<!-- fixture: events-practice.json#/events/1/payload -->
```json
{
  "summary": {
    "takeId": "take_demo_01",
    "room": "HJ3H",
    "from": "phone-1",
    "startedAt": 1792518000000,
    "endedAt": 1792518030000,
    "durationMs": 30000,
    "frames": 300,
    "volume": {
      "meanDbfs": -24.5,
      "p10Dbfs": -31.2,
      "p90Dbfs": -19.6,
      "quietShare": 0.08,
      "loudShare": 0.02
    },
    "pitch": {
      "medianHz": 192,
      "rangeSt": 5.8,
      "voicedShare": 0.71,
      "monotone": false
    },
    "rate": {
      "wpm": 178
    },
    "pauses": {
      "count": 9,
      "perMin": 18,
      "meanMs": 520,
      "longestMs": 1400
    },
    "words": 89,
    "flags": [
      "fast"
    ],
    "provisional": true
  }
}
```
<!-- /fixture -->

### `mirror.focus`

<!-- fixture: events-practice.json#/events/0/payload -->
```json
{
  "view": "practice",
  "by": "phone-1",
  "reason": "practice take started",
  "recapId": null,
  "takeId": "take_demo_01"
}
```
<!-- /fixture -->

### `POST /api/demo/mirror` (demo only)

The mirror plays a synthetic practice take: meter frames to the screens at 10 Hz, then `practice.summary`. With `script: "focus"`, it publishes `mirror.focus` for `view` instead.

<!-- fixture: demo-mirror.json -->
```json
{
  "replay": true,
  "script": "practice-take",
  "takeId": "take_demo_01",
  "frames": 10,
  "hz": 10,
  "durationMs": 1000,
  "rooms": 1
}
```
<!-- /fixture -->

## Alexa and MCP (packet C)

**Alexa** (`POST /alexa`). The skill checks the skill id (`ALEXA_SKILL_ID`) and that the timestamp is within 150 s, then maps each intent onto a hub route through a loopback hub client (`ctx.selfUrl()`):

| Intent | Route |
|---|---|
| `LaunchRequest`, `StartDrillIntent` | `POST /api/session/start` |
| `AttemptIntent` | `POST /api/attempt {source:"alexa"}`; says "checking with Bee" and keeps the session open |
| `HowDidIDoIntent` | `GET /api/attempts/<id>` (polled for at most 6.5 s, with a progressive response) |
| `HowAmIDoingIntent` | `GET /api/coach/now` |
| `LiveCoachOnIntent` and `LiveCoachOffIntent` | `POST /api/live/mode` |
| `DidItTransferIntent` | `GET /api/transfer` |
| `AMAZON.NextIntent` | `POST /api/session/next` |
| `AMAZON.StopIntent` and `AMAZON.CancelIntent` | `POST /api/session/end` |

The catch-all slot rescues "how did I do", "how am I doing", "next" and "stop". The skill package uses generic sample values only. [`alexa-how-am-i-doing.json`](../fixtures/contract-v2/alexa-how-am-i-doing.json) shows one turn.

**MCP** (`/mcp`). The server is stateless Streamable HTTP. Each tool calls one route, and its result is `content: [{type:"text", text: <narration>}]` plus `structuredContent` (the route's JSON), with `isError: true` when the route answers 400 or more.

<!-- fixture: mcp-tools.json#/tools -->
```json
[
  {
    "name": "start_drill",
    "route": "POST /api/session/start",
    "args": "{ size?: number }"
  },
  {
    "name": "submit_attempt",
    "route": "POST /api/attempt",
    "args": "{ text: string, card_id?: string }"
  },
  {
    "name": "get_verdict",
    "route": "GET /api/attempts/<id>",
    "args": "{ attempt_id: string }"
  },
  {
    "name": "drill_status",
    "route": "GET /api/session",
    "args": "{}"
  },
  {
    "name": "next_card",
    "route": "POST /api/session/next",
    "args": "{}"
  },
  {
    "name": "end_drill",
    "route": "POST /api/session/end",
    "args": "{}"
  },
  {
    "name": "how_am_i_doing",
    "route": "GET /api/coach/now",
    "args": "{}"
  },
  {
    "name": "habit_stats",
    "route": "GET /api/stats",
    "args": "{ range?: string, source?: \"bee\" | \"all\" }"
  },
  {
    "name": "did_it_transfer",
    "route": "GET /api/transfer",
    "args": "{ habit?: string }"
  },
  {
    "name": "pre_meeting_brief",
    "route": "GET /api/brief",
    "args": "{}"
  },
  {
    "name": "live_coach",
    "route": "POST /api/live/mode",
    "args": "{ enabled: boolean, minutes?: number }"
  },
  {
    "name": "last_recap",
    "route": "GET /api/recaps?limit=1",
    "args": "{}"
  }
]
```
<!-- /fixture -->

## Health (v2)

`GET /api/health` (LAN only) adds the following fields. It never includes a token.

```json
{ "ok": true, "contractVersion": 2, "mode": "demo", "fixtureV2": false, "publicBaseUrl": null,
  "plugins": [
    { "name": "live", "prefixes": ["/api/live", "/api/recaps", "/api/coach", "/api/demo/live"], "owner": "live coaching", "status": "stub",
      "routes": ["GET /api/live", "POST /api/live/mode", "GET /api/recaps", "GET /api/recaps/<id>", "GET /api/coach/now", "POST /api/demo/live"], "topics": ["..."] },
    { "name": "static", "prefixes": ["/tv/", "/p/", "/sim/"], "owner": "hub", "status": "ready", "routes": ["GET /tv/*", "GET /p/*", "GET /sim/*"],
      "note": "/tv/ not built (npm run tv:web:build); /p/ not built (npm run web:build); /sim/ not built (npm run web:build)" },
    "..."
  ],
  "gate": { "publicRoutes": ["POST /alexa", "GET /p/*", "GET /sim/*", "/mcp (Authorization: Bearer $MCP_TOKEN)", "/ws upgrade (pair token as subprotocol k.<base64url> or ?k=)"], "pairToken": "generated", "mcpToken": "env" },
  "masking": "off",
  "...": "the v1 fields" }
```

`masking` (additive) is `"on (N terms)"` or `"off"`: the display masking of private terms (`src/hub/mask.ts`, docs/live.md "Filming"). It never names a term. When it is on, every string a person reads or hears in a response, an SSE event or a WebSocket frame has each term replaced (`▒▒▒` for screens; `"name"` for what Alexa speaks in `POST /alexa`, its output speech and reprompt, and for requests with `x-hub-mask: speech`, which the Alexa and MCP hub client sends). The APL screen in a `POST /alexa` answer has `▒▒▒` in its datasource, and its document is sent as it is (expressions and resource names are not words). Ids, keys, codes and links are never masked, and the hub grades and stores the unmasked text.

## Fixture mode (`npm run hub -- --demo --fixture-v2`)

Fixture mode lets B and C build against the v2 routes before A lands.

- **It needs `--demo`.** It answers before the plugins, so it behaves the same before and after packet A replaces the live stub.
- **The live routes** `GET /api/live`, `GET /api/recaps`, `GET /api/recaps/<id>` and `GET /api/coach/now` return the fixture files.
  - `POST /api/live/mode` returns `live-mode-on.json` or `live-mode-off.json`, depending on `enabled`, and publishes `live.mode`.
  - `POST /api/demo/live` returns `demo-live.json` (202) and publishes every event in `events-live.json` at `atMs × pace`. Use `--pace 0.05` to see the 7-minute story in about 20 s.
- **`POST /api/demo/mirror` `{room?}`** returns `demo-mirror.json` (202). It relays the 10 frames of `practice-meters.json` to the screens at 10 Hz (not paced), then publishes `events-practice.json` (`mirror.focus`, then `practice.summary`).
- **Everything else** (v1, `/alexa`, `/mcp`, the static mounts) behaves as usual.
- **`/api/health`** shows `fixtureV2: true`.

## Static mounts (`src/hub/static.ts`)

| Mount | Directory | Built by | Public |
|---|---|---|---|
| `/tv/` | `tv/web/dist` | `npm run tv:web:build` (B: `tv/web/package.json`, Vite `base: "/tv/"`) | no |
| `/p/` | `dist/web/phone` | `npm run web:phone:build` (B: `web/phone/vite.config.ts`) | yes |
| `/sim/` | `dist/web/sim` | `npm run web:sim:build` (C: `web/sim/vite.config.ts`) | yes |

- **Vite configs.** `web/phone` and `web/sim` are built with the root `vite`, so each config must set `root` to its own directory, `base` (`"/p/"`, `"/sim/"`), `build.outDir` (`"../../dist/web/phone"`, `"../../dist/web/sim"`) and `build.emptyOutDir: true`.
- **Errors.** A mount that is not built answers `404 not_built` with the build command.
- **Single-page fallback.** Paths without an extension fall back to the mount's `index.html`, so `/p/HJ3H#k=...` works.
- **Refused paths.** Dot segments (raw or encoded), encoded slashes, backslashes, NUL bytes, dotfiles and symlinks that leave the mount get `400 bad_path`.

## Coaching principles and thresholds

[`coach/principles.template.md`](../coach/principles.template.md) is the generic default rubric. It covers:

- rate, volume, melody and pitch, tonality and pauses;
- clarity (hedges and vague answers);
- turn-taking and monologue length.

For each habit it says what Bee can measure (words, rate from timing, pauses, monologue) and what only the phone mic can (volume, pitch). It ends with a fenced JSON block of thresholds (`CoachThresholds` in `contract.ts`) that packet A reads. The operator may replace the template with `coach/principles.local.md` (gitignored; same structure, same JSON block). Its text is never served (see the privacy rules).

## Ownership

Each packet edits only its own files. The lead's files are frozen for the packets.

| Owner | Files | Fills in | Check module |
|---|---|---|---|
| **A: live** | `src/hub/live/**`, `src/hub/core.ts`, `src/hub/bee.ts`, `src/hub/setup.ts`, `src/hub/demoData.ts`, `scripts/wrist-probe.ts`, `scripts/demo-replay.ts`, `docs/live.md`, `test/live-*.test.ts` | `src/hub/live/plugin.ts` (`createLivePlugin`) | `scripts/checks/live.ts` |
| **B: mirror** | `src/hub/mirror.ts`, `tv/web/**`, `tv/vega/**`, `web/phone/**`, `scripts/tv-sync.ts`, `test/mirror-*.test.ts`, `test/tv-*.test.ts`, `test/phone-*.test.ts` | `src/hub/mirror.ts` (`createMirrorPlugin`) | `scripts/checks/mirror.ts` |
| **W: Bee write-back** | `src/hub/live/facts.ts`, `src/hub/live/factsParse.ts`, `src/hub/live/cue.ts`, `test/live-facts.test.ts`, `test/live-cue.test.ts` (inside packet A's `src/hub/live/**`) | `GET /api/coach/facts`, `POST /api/coach/cue` in `createLivePlugin` | `scripts/checks/live.ts` |
| **C: Alexa and MCP** | `src/alexa/**`, `src/mcp/**`, `alexa/**`, `web/sim/**`, `scripts/alexa-deploy.ts`, `test/alexa-*.test.ts`, `test/mcp-*.test.ts` | `src/alexa/plugin.ts` (`createAlexaPlugin`), `src/mcp/plugin.ts` (`createMcpPlugin`) | `scripts/checks/alexa.ts`, `scripts/checks/mcp.ts` |
| **lead (frozen)** | `src/hub/contract.ts`, `src/hub/plugin.ts`, `src/hub/plugins.ts`, `src/hub/server.ts`, `src/hub/gate.ts`, `src/hub/static.ts`, `src/hub/fixtureV2.ts`, `src/hub/contractExamples.ts`, `docs/CONTRACT.md`, `fixtures/contract-v2/**`, `coach/principles.template.md`, `scripts/contract-check.ts`, `scripts/checks/types.ts`, `scripts/contract-v2-examples.ts`, `scripts/leak-check.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `test/contract-*.test.ts`, `test/hub-gate.test.ts`, `test/hub-static.test.ts`, `test/hub-plugins.test.ts`, `test/deps-mcp-sdk.test.ts` | | |

Packet A keeps the `core.ts` helpers above and the `Setup` fields `stateDir` and `pace`. A dependency a packet needs in the root `package.json` goes through the lead. `tv/web` and `tv/vega` have their own `package.json` (B).

## npm scripts (v2)

| Script | Runs | Owner of the target |
|---|---|---|
| `tv:web:dev` and `tv:web:build` | `npm --prefix tv/web run dev` / `build` | B |
| `tv:vega:build` | `npm --prefix tv/vega run build` | B |
| `tv:sync` | `tsx scripts/tv-sync.ts` (copies the shared views from web to Vega) | B |
| `web:phone:build`, `web:sim:build`, `web:build` (both) | `vite build --config web/<x>/vite.config.ts` | B (phone), C (sim) |
| `alexa:deploy` | `tsx scripts/alexa-deploy.ts` (updates the existing dev skill via `ask smapi`) | C |
| `wrist:probe` | `tsx scripts/wrist-probe.ts` (Watch alarm lead at 5, 10, 20 and 30 s) | A |
| `demo:replay` | `tsx scripts/demo-replay.ts` (the whole story, no Bee, no AWS, with a hop timeline) | A |
| `contract:fixtures` | `tsx scripts/contract-v2-examples.ts` | lead |
| `check` | `typecheck` + `test` + `contract:check` + `leak-check` | lead |

## The cross-surface check, v2 additions

After the v1 flows, `npm run contract:check` asserts:

- **Plugins.** Health reports `contractVersion: 2` and the five plugins in registry order. No token appears in health or in any other HTTP response.
- **Routes.** Every v2 route is owned: it never answers `not_found`.
- **Gate.**
  - LAN requests pass.
  - A request with `x-forwarded-for` (ngrok), or with a public `Host`, gets 403 on `/api/*`.
  - Public `POST /alexa` and `GET /p/` pass.
  - Public `/mcp` needs the bearer token.
  - Public `/ws` needs `k`.
  - Public `GET /api/stats`, `/api/transfer` and `/api/recaps` need `x-pair-token` (the mirror module checks it), and the token opens no other route.
- **Static.** Traversal attempts (raw, encoded and double-encoded) never serve a file from outside the mount.
- **Room topics.** `practice.meters` frames from a phone never appear on SSE or in `/api/events/recent`.
- **Topics.** The topic table above matches `V2_TOPICS` and `ROOM_TOPICS`, and every v1 topic is in the v1 event table.
- **Fixture mode.** A second hub (`--demo --fixture-v2`) serves the fixture files. `POST /api/demo/live` publishes the fixture events in order on SSE and to the TV. `POST /api/demo/mirror` sends meters to the room's screens, but never to the phone, SSE or recent events.
- **Packet checks.** The check then imports `scripts/checks/{live,mirror,alexa,mcp}.ts`. Each one exports `run(ctx): Promise<{name, passed, failed, pending?}>` (see `scripts/checks/types.ts`) and asserts its packet's flows against the same demo hub. They report "pending" until the packet lands.
