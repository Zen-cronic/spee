# Live coaching (packet A)

The live engine turns Bee's live stream into three kinds of feedback:

- an opt-in **wrist nudge** while a habit streaks;
- a **recap** after every conversation;
- an on-demand answer to **"how am I doing?"** (`GET /api/coach/now`, used by Alexa and MCP).

The payloads are frozen in [`CONTRACT.md`](CONTRACT.md) (v2) and [`src/hub/contract.ts`](../src/hub/contract.ts). This page covers how the engine produces them, the defaults, and how to run it on real devices.

## Data flow

```
bee stream (one subscriber, src/hub/bee.ts)
  -> BeeVerifier: drills, plus the internal hooks bee.line / bee.conversation / bee.todo-deleted (core.ts)
  -> ConversationWindow (live/window.ts)       rolling metrics, wearer text in memory only
  -> rules (live/rules.ts)                     relative to the baseline (live/baseline.ts)
  -> policy (live/policy.ts)                   code decides; reads numbers only
  -> wrist (live/wrist.ts)                     Bee to-do with an alarm, or the replay channel
  -> nudge.sent | nudge.skipped
end of conversation -> conversation.ended -> recap (live/recap.ts) -> recap.ready -> wrist -> disk
Bee marks it COMPLETED -> live ingest (ingest.ts) -> stats session -> stats.updated (Progress, first signal)
```

- **No second stream.** The hub keeps its one `bee stream` process. The verifier emits `bee.line` once Bee has decided a line's speaker: the wearer tag, another person's tag, a low score, or the 3 s tag timeout. Only a wearer line (tag score at least 0.5) carries text. Every other line is a word count.
- **Stream types.** The hub subscribes to `new-utterance,tagged-utterance,new-conversation,update-conversation,delete-conversation,todo-deleted`. Every one of these names was seen on the real stream. If the CLI rejects the list (the stream exits at once with no output), `spawnBeeStream` falls back to the four types the CLI documents, and logs `bee.stream.types.fallback`.
- **Trust split.** Rules and policy read structured numbers only. The only model call is the optional recap phrasing. It runs off the request path, and code checks its output before using it. `coachNow()` is deterministic.

## Files

| File | What it does |
|---|---|
| `src/hub/live/plugin.ts` | Routes, wiring, wrist selection (`createLivePlugin`) |
| `src/hub/ingest.ts` | `LiveIngest`: finished Bee conversations become stats sessions while the hub runs |
| `src/hub/live/engine.ts` | Conversation lifecycle, nudges, recaps, `coachNow()`, persistence |
| `src/hub/live/window.ts` | `ConversationWindow`: rate, talk share, monologue, pauses, 2-minute counts, rule evidence |
| `src/hub/live/rules.ts` | Which rules fire; the generated wrist text |
| `src/hub/live/policy.ts` | Live mode (on, off, expiry), cooldowns, caps, quiet hours, warm-up, drill and wrist suppression |
| `src/hub/live/baseline.ts` | The wearer's baseline rates and rate of speech |
| `src/hub/live/wrist.ts` | `BeeTodoWrist` (queue, retries, breaker, ledger, cleanup) and `ReplayWrist` |
| `src/hub/live/recap.ts` | Template recap: metrics, verdicts, the moment and its rephrase |
| `src/hub/live/recapPrompt.ts` | Optional Claude Haiku phrasing and its acceptance checks |
| `src/hub/live/principles.ts` | The principles loader: thresholds and the runtime-only rubric |
| `src/hub/live/demoScripts.ts` | Synthetic scripts for "Ada" (`story`, `monologue`, `short`) |
| `src/hub/setup.ts` | `DemoDirector.replayConversation`: Bee-shaped replay events |
| `scripts/demo-replay.ts` | `npm run demo:replay`: the whole story with a hop timeline |
| `scripts/wrist-probe.ts` | `npm run wrist:probe`: operator-run Watch alarm probe |
| `scripts/checks/live.ts` | The live assertions in `npm run contract:check` |

## Rules (thresholds from the principles file)

The thresholds come from the JSON block at the end of `coach/principles.local.md` if it exists, otherwise from `coach/principles.template.md`. They are relative to the wearer's baseline.

| Rule | Fires when | Default |
|---|---|---|
| `hedge-streak` | hedges in the rule's `windowMs` (default 120 s, the window the nudge text names) reach max(`streakMin`, `expectedMultiplier` x expected) | max(3, 2 x expected) |
| `like-streak` | "like" as a filler, the same way | max(4, 2 x expected) |
| `monologue` | one wearer turn lasts `nudgeMs` or more | 90 s |
| `fast-rate` | the 2-minute rate reaches `wpmFast` | 175 wpm, **off** (`fastRateNudge: false`) |

Notes on how the rules are computed:

- **Expected.** The expected count is the baseline rate times the wearer's words in the window, so a quiet stretch needs fewer hedges to fire than a busy one.
- **One firing per streak.** After a rule acts (sent or skipped), only lines after that one count toward its next firing. A monologue nudges once per turn.
- **French lines** count as talk but not toward habits. **Drill lines** (lines that confirmed a drill attempt) are excluded from every metric.
- **Turns and pauses.** A turn ends at another speaker's line or at a silence over 10 s. A pause is a gap of 1 s or more inside a turn.
- **Rate** needs at least 10 s of timed wearer speech. It uses lines of at least 1 s and 3 words, timed by Bee's `start`/`end`.

**Baseline.**

- Habit rates come from Bee conversations (drills and voice notes excluded): this week, or every Bee conversation when the week has under 400 words.
- The rate of speech is the median per-line rate in `real/corpus.json`. It was 140 wpm on 2026-10-16, and 140 is also the fallback and the demo value.
- The demo baseline (synthetic week) is 1400 words, hedges 1.43, "like" 1.79 and fillers 2.43 per 100, at 140 wpm.

## Policy defaults (frozen in the contract)

| Setting | Value |
|---|---|
| Live mode | **off** by default; on for `minutes` (default 60, 1 to 180), then off with reason `expired` (and a `live.mode` event) |
| Cooldown | 3 min between any two nudges |
| Rule cooldown | 10 min between nudges of the same rule |
| Caps | 6 per hour, 20 per day |
| Warm-up | no nudge in the first 60 s of a conversation |
| Quiet hours | 22:00 to 08:00 local (`BEE_TZ`, default America/Toronto) |
| Drill | no nudge while a drill session runs, an attempt waits for Bee, or a card opened in the last 5 min |
| Wrist down | 3 consecutive failed to-do creates open the circuit for 10 min and turn live mode off (reason `wrist-down`) |

- **Every suppression** publishes `nudge.skipped` with its reason. The checks run in this order: `off`/`wrist-down`, `quiet-hours`, `drill-active`, `warmup`, `cap-day`, `cap-hour`, `cooldown`, `rule-cooldown`.
- **Restarts.** Live mode is not persisted, so a hub restart leaves it off (the safe default).
- **Demo pace.** Story durations (cooldowns, warm-up, the hourly cap) are multiplied by `--pace` when compared with the hub clock. Speech metrics use Bee's recording times, so they are the same at any pace. Mode expiry and quiet hours always use the hub clock, unscaled.

## The wrist

`BeeTodoWrist` runs `bee todos create --text "[coach] ..." --alarm-at <iso> --json` through `execFile`, never a shell. The CLI owns authentication, and the hub never reads the token.

- **Text.** At most 60 characters, starting `[coach] `. It is generated from the rule and its numbers, for example `[coach] 4 hedges in 2 min. Say it plainly.`, and never quotes a transcript. Any other text is refused before the CLI is called.
- **Alarm lead.** `NUDGE_ALARM_LEAD_S` (default 10). The alarm time is rounded up to the whole second, in the format the probe verified (`2026-10-16T20:22:10Z`).
- **Queue.** One CLI call at a time, at least 1.5 s apart, each with a 10 s timeout. Creates go ahead of cleanups, and a create that waited over 30 s in the queue is dropped as stale.
- **Retries.** A failed create is retried twice. After a **timeout**, the to-do list is checked first: if the create landed (same text, alarm within 2 s), it is adopted instead of duplicated. A create that exits 0 is never retried: when its output has no id (a notice line before or after the JSON is read past), the list is checked once, and if the to-do is not there either the nudge is `scheduled` with a null `todoId` (no cleanup) and the circuit does not count it.
- **Circuit breaker.** 3 consecutive failed create calls open the circuit for 10 min. The engine turns live mode off (`wrist-down`) and publishes `live.mode`. A nudge whose wrist call failed is still `nudge.sent`, with `wrist.status: "failed"` and null `todoAt`/`alarmAt`.
- **Ledger.** `<stateDir>/live/todos.json` (`real/live/` in live mode, gitignored). It holds the id, kind, the generated text, the alarm, the cleanup action and the state.
- **Cleanup.**
  - A nudge to-do is **deleted** 10 min after its alarm.
  - A recap to-do is **completed** (it shows ticked in the Bee app) 30 min after its alarm.
  - Cleanups are checked every minute.
  - At startup and every hour, a sweep lists the to-dos and deletes any open `[coach] ` to-do whose alarm passed more than 30 min ago, that the ledger does not track (a crash, old probes), and that is the coach's own: an id it created (kept past the ledger's trim) or text in exactly the shape it generates (a nudge, a recap, a wrist probe). A personal to-do such as "[coach] prep 1:1 notes" is never touched, and any truthy `completed` counts as done.
  - A `todo-deleted` stream event for a pending ledger entry (deleted by the wearer in the Bee app, or by us) marks it `gone`, so it is never cleaned up twice.
- **Channel selection.**
  - Demo mode uses `ReplayWrist`: no CLI, the same hops with a 1.45 s create and the alarm lead, scaled by the pace.
  - Live mode uses `BeeTodoWrist`.
  - `COACH_WRIST=replay` is a live dry run that never creates a to-do. Live mode with `--no-bee` also uses the replay channel.

## End of a conversation and the recap

**Evidence.** A text-stripped `bee stream --types all` capture on 2026-10-16 showed:

- **`update-conversation`** with the full conversation object: `id`, `conversation_uuid`, `start_time`, `end_time` (set when the recording stopped) and `state: "PROCESSING"`. It arrived within a second of `end_time`.
- **`delete-conversation`**, with the same object, about 0.4 s after the update. This happened for both recordings in the capture.
- **`todo-deleted`**: `{todo: {id, conversationId, text, completed, alarmAt, appleId}}`.
- **Keepalives**: `{timestamp}` with no type.
- **Bee's own end is slow.** It came about 6.5 min after the last line, so the idle timer usually ends a conversation first.
- **Timing fields.** Utterance `start`/`end` are seconds from the start of the recording; `spoken_at` is whole seconds.

`test/live-stream-shapes.test.ts` replays synthetic lines of these shapes (invented ids and text).

**End detection**, in this order:

1. **Bee leaves CAPTURING.** `update-conversation` for the current conversation, with a state other than `CAPTURING` or a non-null `end_time`. The end is held for a 20 s delete grace (scaled by the pace): long enough for a `delete-conversation` to cancel the recap, and for Bee's last lines (they lag the stop by 4 to 15 s) to land in this window and its recap. Then `conversation.ended` has reason `bee-state` and `endedAt` is Bee's `end_time`.
2. **90 s idle.** No line for `recap.idleEndMs` (90 s, scaled by the pace), which is the usual case. `endedAt` is the end of the last line.
3. **A new conversation uuid.** The current conversation ends with reason `new-conversation`.

**Deleted conversations.** `delete-conversation` drops the window and cancels a queued recap. It also **retracts** a recap that was already made, from memory and from `recaps.json`. Events already sent stay sent. A deleted conversation never gets a recap again, and its later lines are ignored.

**When a conversation is announced.** `conversation.started` is published at the first counted wearer line, not at `new-conversation`. A recording with only other voices (a TV, a radio), or only drill lines, is never announced and ends silently.

**Recap content.**

- **Skips.** A conversation is skipped under 60 wearer words (`skipped-short`), or under 60 English words (`skipped-french`).
- **Metrics:**
  - wearer words, rate and baseline rate, talk share;
  - longest turn and pauses;
  - four habits (`hedges`, `filler:like`, `vague`, `restart`) with per-100 rates. The verdict comes from a Poisson z-score against the baseline: |z| >= 1 is `worse` or `better`, otherwise `typical`.
- **Moment.** One wearer sentence of 4 to 12 words showing the worst habit (hedges or "like"), with a mechanical rephrase (`stripHedges` / `stripFillers`).
- **Phrasing (template).**
  - Headline: `Hedges ran high: 4.2 per 100 words against your usual 1.4. "Like" was down.`
  - Narration: 3 sentences.
  - Wrist text: `[coach] Recap: hedges high, pace steady`.
  - When no habit ran high but one turn reached 90 s, the recap leads with the long turn.
- **Optional model phrasing** (`COACH_RECAP_LLM=1`, live mode only; loaded lazily so the AWS SDK stays out of demo and tests):
  - Claude Haiku 4.5 on Bedrock (`us.anthropic.claude-haiku-4-5-20251001-v1:0`, profile `hackathon-1`, through `callTool`).
  - One call at a time, with a 6 s timeout.
  - The output replaces the template only when:
    - the shape and lengths are right;
    - the wrist text starts `[coach] ` and is at most 60 characters;
    - the narration has at most 3 sentences;
    - every quote is the moment or its rephrase;
    - every number of the template is kept and none is added, each still about the same fact: a number belongs to the nearest habit, minutes, words, words-a-minute or per-100-words word in its clause, and "usual" marks the baseline, so swapping the hedge count and the minutes is refused;
    - nothing shares a 5-word shingle with the principles.
  - Otherwise the template stays (`phrasing: "template"`).
- **Delivery.**
  - `recap.ready` comes first. Then, only when live mode is on, the wrist to-do (with the same lead). Then the recap is written to `<stateDir>/live/recaps.json`.
  - `delivery.wrist` in `recap.ready` is `scheduled` (bee-todo, the call is queued), `replay`, or `off`. `GET /api/recaps/<id>` shows the outcome (`todoId`, or `failed`).
  - Recaps fire after the recording stopped, so the alarm lands on the wrist **or the phone**.

## "How am I doing?" (`GET /api/coach/now`)

Deterministic, at most 4 sentences:

1. **The lead.** The live conversation (`basis: "live"`, from 20 wearer words). Otherwise today's last recap (`"recap"`), which leads with the habit that ran high or a long turn. Otherwise the week (`"week"`).
2. **The first signal**, only when a drilled habit has a next conversation since its first drill: `First signal, from one conversation and not proof: in your next conversation after drilling, "like" went from 5.4 to 2.1 per 100 words.` With under 100 words on a side it says the conversation was too short to compare, never a number.
3. **The week.** The top habit's rate (hedges or vague answers when they have at least 3 occurrences, otherwise fillers or restarts) and the number of due drills.
4. **Live mode.** `Live coaching is on until 2:30 PM.` or `Live coaching is off.`

## Finished conversations feed the stats (live ingest)

The live hub picks up finished conversations by itself. The weekly stats, the transfer check and its first signal (Progress on the TV, and "how am I doing?") update once Bee has finished a conversation. You do not need `npm run real` or a hub restart.

- **Triggers.**
  - `update-conversation` with state `COMPLETED` on the stream: fetched at once.
  - `update-conversation` when a recording stops (state `PROCESSING`): re-fetched after 1, 2, 4, 8, then every 10 min until Bee completes it, for up to 6 h.
  - A list poll every 10 min (the first 30 s after start) covers events the stream missed: every `COMPLETED` conversation of the last 24 h that the hub does not have yet, at most 10 per poll.
  - A `delete-conversation` does not cancel the fetch (Bee sends one right after a recording stops). A conversation Bee no longer returns is dropped.
- **Same rules as the offline pipeline.**
  - The conversation is fetched with `bee conversations get <id> --json` (the `CliBeeSource` path).
  - It goes through `conversationLines` (`src/real/corpus.ts`): the wearer filter and the mislabel detector that `npm run real` and `npm run class` use.
  - One conversation on its own takes only a label the Bee profile (or `BEE_WEARER_LABELS`) names as the wearer, as the drill poll does. Without `bee me` and without `BEE_WEARER_LABELS`, the conversation waits (`bee.ingest.deferred`) and `bee me` is retried every 10 min.
  - No model call. Everything is deterministic.
- **Drill lines stay out.** Lines Bee heard as drill attempts are left out of the transfer periods and the first signal, as before (`drillLineKeys`).
- **After each ingest.** The hub publishes `stats.updated`, so the screens refetch the stats and `GET /api/transfer`. `GET /api/coach/now` reads the transfer on every ask.
- **Storage.**
  - `<stateDir>/live/sessions.json` (`real/live/sessions.json`, gitignored) holds the wearer's lines and per-conversation counts, in the shape of `real/corpus.json`.
  - `loadRealSessions` merges it after the offline files at the next start.
  - A session an offline file already has is kept as the offline run wrote it, so a later `npm run real` still wins.
- **Robustness.**
  - One Bee CLI call at a time, each with the `BEE_CLI_TIMEOUT_MS` timeout (default 30 s), tracked like the other children.
  - Three failed calls in a row open a circuit for 10 min (`bee.ingest.circuit-open`).
  - A failure is logged once per kind: the error's name and code, never its message, which can quote CLI output.
  - A failed write is logged once (`bee.ingest.persist-error`), and the session still counts until the next restart.
  - Nothing in the ingest stops the hub.
- **Off switches.** `COACH_INGEST=off`, or `--no-bee` (no stream). Demo mode never ingests and never calls Bee.
- **Proof.** `test/hub-ingest.test.ts` uses a fake Bee CLI and a fake stream. It checks that a `COMPLETED` event moves the first signal from `no-next-conversation` to `measured`, the de-duplication with the offline files, the poll fallback, failure isolation, and a planted other-speaker line that must not reach the file, an event, a response or a log.

## Coaching principles

`coach/principles.local.md` (the operator's notes, gitignored) wins over the committed generic template.

- **Thresholds** come from its final fenced JSON block. A block that does not parse falls back to the template's numbers.
- **The rubric text** is held in memory and injected into the optional recap prompt only. It is never logged, served, published or written to disk.
- **What the hub reveals.** Health reports only which file is in use: `principles: local|template`.

## Privacy

- **Wearer text.** Text exists only for wearer-tagged lines, held in memory in the conversation window, and dropped once the conversation is over.
- **Other speakers.** Their lines are word counts, from the verifier onwards. They are never in an event, a response, a log or a file.
- **What is persisted** (under `<stateDir>/live/`):
  - `recaps.json`: metrics, plus a moment of at most 12 of the wearer's own words;
  - `nudges.json`: generated text and numbers;
  - `todos.json`: generated text and ids;
  - `sessions.json`: finished conversations the hub ingested, as the wearer's lines plus per-conversation counts. Other speakers' lines are counted, never stored.
- **Where state lives.** `real/live/` in live mode (gitignored, and screened as wearer text by `npm run leak-check`), `out/demo/live/` in demo mode.
- **Logs.** Event names and ids only.
- **Proof.** The story plants a colleague line (marker `zebra orchid`). `test/live-engine.test.ts`, `test/live-plugin.test.ts`, `scripts/checks/live.ts` and `npm run demo:replay` all assert that it never reaches an event, a response or a file.

## Demo

- **`POST /api/demo/live {script}`** (demo hub only) replays a synthetic conversation for "Ada" through the same parser, verifier and engine as live events:
  - `story`: a hedge streak, then `nudge.sent`, then a second streak and `nudge.skipped` (cooldown), then idle and `recap.ready`;
  - `monologue`: a 90 s turn, then `nudge.sent` (monologue);
  - `short`: `skipped-short`.

  Turn live mode on first, or the streaks are skipped with reason `off`.
- **`npm run demo:replay`** runs the whole story in-process (no Bee, no Watch, no AWS) at pace 0.05 and prints story-time beats with the nudge hops: Bee tag 5.9 s, detection, to-do 1.45 s, alarm 10 s, so the **Watch buzzes about 17.4 s after Ada stopped speaking**. It then prints the recap and "how am I doing?". Use `--pace 1` for real time and `--script all` for the three scripts.

## Real-device run (operator)

Before you start: an authenticated `bee` CLI (`bee me` works), the Watch running Bee, `real/` data present, and the clock in EDT.

1. **Probe the alarm lead (once):**
   1. Start a Bee recording on the Watch and **lock the iPhone**.
   2. Run `npm run wrist:probe -- --leads 5,10,20,30`. It creates one `[coach] probe Ns` to-do per minute, on the minute.
   3. Note which buzzed on the Watch, and when (log: `real/live/wrist-probe.jsonl`).
   4. Run `npm run wrist:probe -- --cleanup`.
   5. If 10 s is unreliable, set `NUDGE_ALARM_LEAD_S` to the shortest lead that buzzed every time.
2. **Start the hub:** `npm run hub` (live: `bee stream` spawned, wrist = Bee to-dos). Optionally add `COACH_RECAP_LLM=1` for model phrasing, or `COACH_WRIST=replay` for a dry run with no to-dos. Check `curl -s localhost:8791/api/health`: the live plugin should show `status: "ready"`, `wrist: bee-todo`.
3. **Turn live coaching on:** say "Alexa, turn on live coaching", or run `curl -s -X POST localhost:8791/api/live/mode -H 'content-type: application/json' -d '{"enabled":true,"minutes":60,"by":"operator"}'`. It lasts 60 min.
4. **Talk:**
   1. Keep Bee recording on the Watch and the **iPhone locked**.
   2. Talk with someone for at least a minute. The warm-up is 60 s, and quiet hours run from 22:00 to 08:00.
   3. Then use about 4 hedges within 2 minutes ("I guess", "maybe", "I think", "kind of").
5. **Expected timings:**
   - Bee's tagged line reaches the hub about 5.4 to 6 s after you stop speaking (range 4.3 to 14.7 s).
   - Detection takes milliseconds; the to-do create takes about 1 to 2 s.
   - The alarm fires 10 s later, so the **Watch buzzes about 17 to 20 s** after the line that completed the streak (up to about 30 s on a slow Bee line).
   - The TV live view shows the hops. `GET /api/live` shows `lastNudge.hops` and `latencyMs`.
   - A second streak within 3 min is `nudge.skipped` (cooldown).
6. **End the conversation:** stop talking for 90 s, or stop the Bee recording. Stopping the recording ends it 20 s after Bee's `update-conversation`.
   - `conversation.ended`, then `recap.ready`, then the recap to-do (10 s lead).
   - The recording has stopped, so the recap alarm may land on the iPhone rather than the Watch.
   - Ask "Alexa, how am I doing?" to hear the recap.
7. **Cleanup checks:**
   - The nudge to-do disappears 10 min after its alarm.
   - The recap to-do shows ticked 30 min after its alarm.
   - `real/live/todos.json` shows each entry `done`.
   - Restarting the hub runs the stale `[coach]` sweep.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `NUDGE_ALARM_LEAD_S` | 10 | alarm lead for nudge and recap to-dos |
| `COACH_WRIST` | `bee-todo` (live), `replay` (demo or `--no-bee`) | `replay` = live dry run, no to-dos |
| `COACH_RECAP_LLM` | unset | `1` = Claude Haiku recap phrasing in live mode (Bedrock, profile `hackathon-1`) |
| `COACH_INGEST` | on (live mode with the stream) | `off` = finished conversations are not ingested; run `npm run real` and restart as before |
| `BEE_BIN`, `BEE_TZ`, `BEE_WEARER_PERSON_ID` | | as for the hub (`CONTRACT.md` "Live mode") |

## Known limits

- **Live mode is not persisted:** a hub restart turns it off.
- **Ingest waits for Bee.** A conversation counts only once Bee marks it `COMPLETED`. That is Bee's own processing, from a few minutes to about an hour after the recording stops. The hub then takes it within a minute of the stream event, or by the next 10-min poll.
- **Ingested data is not retracted.** A conversation you delete in the Bee app after it was ingested stays in `real/live/sessions.json`, and in the stats, until you remove it from that file.
- **Delete races.** A `delete-conversation` that arrives after an idle-ended recap retracts the recap from storage, but `recap.ready` was already published (there is no retraction event).
- **Talk share.** Other speakers are only those lines Bee did not tag as the wearer, so a missed wearer tag counts toward the others.
- **Recap moments** exist only for hedges and "like" (vague answers and restarts have no mechanical rephrase).
- **Wrist lead.** The Watch only buzzes while Bee records and the iPhone is locked; otherwise the alarm lands on the iPhone.

## Contract change requests

These are implemented around the frozen contract, pending the lead:

1. **A deleted conversation's status.** `ConversationEnded.recap` has no value for "Bee deleted it". Today a deleted conversation ends with `recap: "skipped-short"`. Proposed: add `"skipped-deleted"`.
2. **A recap retraction event.** There is no event for it. Proposed: a sequenced `recap.retracted {recapId, conversationId, reason: "bee-deleted"}`, so the TV can drop a recap card.
3. **`delivery.wrist` at `recap.ready`.** It is `"scheduled"` before the Bee to-do call returns, because the contract orders `recap.ready` before the wrist. Proposed: document this, or add `"pending"`.
4. **The lead's tests for the stubs.** `test/hub-plugins.test.ts` still expects the live plugin to be a stub (status `"stub"`, every route 501). Now that packet A has landed, those two assertions need the lead's update. Packets B and C trip the same test.
