# Live coaching

The live engine turns Bee's live stream into three kinds of feedback:

- an opt-in **wrist nudge** while a habit streaks;
- a **recap** after every conversation;
- an on-demand answer to **"how am I doing?"** (`GET /api/coach/now`, used by Alexa and MCP).

Two opt-in Bee write-backs sit beside it: one **goal fact** kept in Bee's memory (`GET /api/coach/facts`, see "Bee memory") and an **if-then cue** on the wrist before a conversation (`POST /api/coach/cue`, see "Wrist cue").

**Latency.** Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it. A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn.

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
Bee-verified pass -> Bee memory (live/facts.ts): one goal fact, created, confirmed, then updated   (COACH_FACTS=1)
POST /api/coach/cue -> cue (live/cue.ts) -> wrist (kind "cue")                                    (COACH_CUES=1)
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
| `src/hub/live/facts.ts` | Bee memory: the one goal fact (template, ledger, its own breaker) and the insight and fact counts |
| `src/hub/live/factsParse.ts` | Defensive readers for the `bee facts` and `bee insights` JSON, and the read-only spike |
| `src/hub/live/cue.ts` | The if-then wrist cue: which habit, dedupe, the daily cap, quiet hours |
| `src/hub/live/recap.ts` | Template recap: metrics, verdicts, the moment and its rephrase |
| `src/hub/settings.ts` | Conversation settings: the automatic tag, the wearer's correction, per-setting rates and baselines |
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
- The demo baseline (synthetic week) is 1834 words, hedges 1.2, "like" 1.58 and fillers 2.07 per 100, at 140 wpm.
- **The usual for the setting.** A recap compares with the wearer's usual in that conversation's setting when the setting has at least 400 words ("Settings" below), otherwise with this baseline.

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

- **Text.** At most 60 characters, starting `[coach] `. It is generated from the rule and its numbers, for example `[coach] 4 unsure words in 2 minutes. Say it plainly.`, and never quotes a transcript. Any other text is refused before the CLI is called.
- **Alarm lead.** `NUDGE_ALARM_LEAD_S` (default 10). The alarm time is rounded up to the whole second, in the format the probe verified (`2026-10-16T20:22:10Z`).
- **Queue.** One CLI call at a time, at least 1.5 s apart, each with a 10 s timeout. Creates go ahead of cleanups, and a create that waited over 30 s in the queue is dropped as stale.
- **Retries.** A failed create is retried twice. After a **timeout**, the to-do list is checked first: if the create landed (same text, alarm within 2 s), it is adopted instead of duplicated. A create that exits 0 is never retried: when its output has no id (a notice line before or after the JSON is read past), the list is checked once, and if the to-do is not there either the nudge is `scheduled` with a null `todoId` (no cleanup) and the circuit does not count it.
- **Circuit breaker.** 3 consecutive failed create calls open the circuit for 10 min. The engine turns live mode off (`wrist-down`) and publishes `live.mode`. A nudge whose wrist call failed is still `nudge.sent`, with `wrist.status: "failed"` and null `todoAt`/`alarmAt`.
- **Ledger.** `<stateDir>/live/todos.json` (`real/live/` in live mode, gitignored). It holds the id, kind, the generated text, the alarm, the cleanup action and the state.
- **Cleanup.**
  - A nudge or cue to-do is **deleted** 10 min after its alarm.
  - A recap to-do is **completed** (it shows ticked in the Bee app) 30 min after its alarm.
  - Cleanups are checked every minute.
  - At startup and every hour, a sweep lists the to-dos and deletes any open `[coach] ` to-do whose alarm passed more than 30 min ago, that the ledger does not track (a crash, old probes), and that is the coach's own: an id it created (kept past the ledger's trim) or text in exactly the shape it generates (a nudge, a recap, a cue, a wrist probe). A personal to-do such as "[coach] prep 1:1 notes" is never touched, and any truthy `completed` counts as done.
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
  - Headline: `Unsure words ran high: 4.2 per 100 words against your usual 1.4. Filler "like" was down.`
  - Narration: 3 sentences.
  - Wrist text: `[coach] Recap: more unsure words than usual, pace steady`.
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
    - the setting's words ("at work") stand right after each usual, as the template has them, and nowhere else, so a later correction re-words every one of them;
    - nothing shares a 5-word shingle with the principles.
  - Otherwise the template stays (`phrasing: "template"`).
- **Delivery.**
  - `recap.ready` comes first. Then, only when live mode is on, the wrist to-do (with the same lead). Then the recap is written to `<stateDir>/live/recaps.json`.
  - `delivery.wrist` in `recap.ready` is `scheduled` (bee-todo, the call is queued), `replay`, or `off`. `GET /api/recaps/<id>` shows the outcome (`todoId`, or `failed`).
  - Recaps fire after the recording stopped, so the alarm lands on the wrist **or the phone**.

## "How am I doing?" (`GET /api/coach/now`)

Deterministic, at most 4 sentences:

1. **The lead.** The live conversation (`basis: "live"`, from 20 wearer words). Otherwise today's last recap (`"recap"`), which leads with the habit that ran high or a long turn. Otherwise the week (`"week"`).
2. **The first signal**, only when a drilled habit has a next conversation since its first drill: `First signal, from one conversation and not proof: in your next conversation after practising, filler "like" went from 5.4 to 2.1 per 100 words.` With under 100 words on a side it says the conversation was too short to compare, never a number.
3. **The week.** The top habit's rate (hedges or vague answers when they have at least 3 occurrences, otherwise fillers or restarts) and the number of due drills.
4. **Live mode.** `Live coaching is on until 2:30 PM.` or `Live coaching is off.`

## Bee memory (`GET /api/coach/facts`)

The coach keeps **one goal fact** in Bee's memory, and reads how many insights and facts Bee has. It is the developer-built counterpart of Bee's own goals. No source says Bee's chat, Daily Insights or Alexa+ read a fact a developer wrote, so the route always says: "Bee's chat and Alexa+ may not read coach-written facts."

- **Off by default.** `COACH_FACTS=1` turns it on, in live mode with the Bee stream only. Off makes no Bee call of any kind (no write, no count). Demo mode writes nothing: the route shows the goal the coach would write, with `status: "demo"`.
- **The text** is a template filled with numbers, the fixed habit names and the pre-registered transfer verdicts, for example: `Speaking goal (Speaking Mirror): fewer unsure words and filler "like". Since Oct 17: unsure words 2.6 → 0.8 per 100 words; filler "like" needs more speech; 3 lines passed, checked by Bee.` A guard (`GOAL_TEXT_RE`) refuses any other text before the CLI is called. It never carries transcript text, another speaker's words or another fact's text.
- **When it writes.**
  - The first Bee-verified pass (graded on Bee's own text, counted, passed) runs `bee facts create --text "<goal>" --json`, then `bee facts confirm <id> --json`: a new fact comes back unconfirmed.
  - After that, always the **same id**: `bee facts update <id> --text "<goal>" --confirmed true --json`. A drilled habit's verdict changing (checked on `stats.updated`) updates it at once. A text-only change (the pass count) waits for a pass or the 6-hourly read, at most once every 10 min.
- **Never a second fact.** The ledger `<stateDir>/live/facts.json` (`real/live/` in live mode) records the intent before every create, and a create whose outcome is not known is never made again.
  - A create that timed out, or a hub stopped during one, is looked for first (`bee facts list --unconfirmed`, then `bee facts list`, each following its cursor for up to 5 pages, matched by its exact text) and adopted.
  - While Bee does not list it (a create that timed out, or one that exited 0 without printing an id), nothing else is written, and the coach looks for it at most 5 times: right after the create, then 1, 2, 4 and 8 min after the look before (about 15 min in all), once one is due: at a pass, the 6-hourly read, its own timer or a restart. A restart keeps that schedule: it looks only when a look is due, and otherwise sets the timer for the time left, so restarting the hub between takes never uses up the looks. A hub stopped during the create, or a ledger from before the look count, looks at once. Never on `stats.updated`, so a stuck create never keeps pulling Bee's facts. A look counts only when both lists answered, so a Bee outage never uses them up. A look whose timer fires while the breaker (below) is open waits for it to close, then runs on that same timer, with no pass needed. The status is `failed` meanwhile, also after a restart.
  - If Bee never lists it, the coach stops looking, and the status stays `failed` with `stopped: true`, also after a restart; the TV's Bee memory row says the coach stopped trying instead of "the hub tries again", and the health note says `Bee facts: live (failed: Bee never listed the goal create, so it is not made again; see docs/live.md)`. To start over: stop the hub, look for the goal fact in the Bee app and delete it if it is there, delete `real/live/facts.json`, and start the hub. The next pass writes one goal fact.
  - A fact you delete in the Bee app is forgotten, and the next pass writes one goal fact again. To stop it, start the hub without `COACH_FACTS=1`.
- **Counts only.** One minute after start and then every 6 h: `bee insights list --limit 100 --json` and `bee facts list --limit 100 --json`, following a cursor for up to 5 pages. Only the counts are kept.
- **Its own breaker.** Calls are serialized on one queue (the goal's and the count read's alike), 1.5 s apart, with a 10 s timeout. 3 consecutive failed calls open the breaker for 30 min (`status: "failed"`). It never touches the wrist or live mode, so live coaching carries on.
- **The route.** `status` is `off`, `demo`, `pending` (no confirmed fact yet), `synced` or `failed`; `stopped` is true only for a `failed` the coach no longer retries (it stopped looking, above), false for every failure the hub tries again; `goal` is `{factId, text, confirmed, updatedAt}`; `insights` and `facts` are `{count, readAt}`. When the memory changes, the hub re-sends `stats.updated` so a screen refetches.
- **The JSON shape is unverified.** bee-cli 0.8.0 types these calls as `unknown`, so the readers in `src/hub/live/factsParse.ts` accept the likely shapes (a bare or wrapped object or list, string or number ids, notice lines) and return nothing for anything else. The read-only spike below checks them on the account. When the hub cannot read a create's output, it logs `facts.create.unreadable` with the output's shape (keys and types), never its text.

## Wrist cue (`POST /api/coach/cue`)

One if-then cue on the wrist before a conversation: `{inMinutes?, by?}` (`inMinutes` 0 to 180, default 0 for the alarm lead).

- **Opt-in.** `COACH_CUES=1` in live mode. The demo hub always answers, on the replay wrist (no Bee call). Off: `409 cues_off`.
- **The text** is one fixed line per habit, at most 60 characters: `[coach] If asked for status: result first, no "I guess".` (unsure words) and `[coach] If you need a second: pause, don't say "like".` (filler "like"). It never carries a calendar title or a transcript line.
- **Which habit.** Only a pre-registered drilled habit that has been practised (a counted drill). Never the habit kept undrilled (starting over), because a cue about it would be practice and spoil the check. Never a habit not practised yet (`409 no_practised_habit`). Of the practised ones, the one with the higher latest rate.
- **Limits.** A cue whose alarm is within 10 min of an earlier cue's alarm (the same habit) is that cue again: the answer is the first cue with `deduped: true`, and no second to-do. The alarms are compared, not when each cue was asked for, so a cue asked for hours ahead never stops one for an earlier meeting, and meetings 14 min or more apart each get their cue (the skill cues 8 to 12 min before each). The narration never says a cue is "already set" for an alarm that has gone off. A request that arrives while a cue for the same habit is being sent waits for that send: if Bee did not take the to-do, it gets the same failed answer (`wrist.status: "failed"`, `deduped: false`), never "already set". At most 3 cues a day. None whose alarm falls in quiet hours, 22:00 to 08:00 (`409 quiet_hours`). Over the cap: `429 cue_cap`. Wrist circuit open: `503 wrist_down`.
- **Delivery.** Through the wrist queue as kind `"cue"`: a Bee to-do whose alarm is `inMinutes` from now, never sooner than the lead, deleted 10 min after its alarm. The Watch buzzes only while Bee records and the iPhone is locked.
- **No calendar timer in the hub.** The coaching skill (`skills/speaking-coach/scripts/coach.mjs`, `cue` and `heartbeat`) decides when, from `GET /api/brief?upcoming=1` (the next meeting that has not started).
- **Ledger.** `<stateDir>/live/cues.json` (live mode): cue ids, the fixed text and alarm times, so dedupe and the cap survive a restart.

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

## Settings

Every conversation gets a setting, so the coach compares like with like: **Meeting**, **Work talk** or **Casual**. It is a secondary view. The pre-registered before and after (`GET /api/transfer`, the Progress headline) never uses it, and a test checks that it is identical with and without settings data.

- **The automatic tag** (`src/hub/settings.ts` `autoSetting`) is deterministic, with no model call, and reads counts and times only, never anyone's words:
  1. **Meeting**: a meeting-captions session; a Bee conversation a captions session matches by time (`pairMeetings`); or one that overlaps a calendar event the hub has seen in Bee's today brief (times only, never the title; an event without an end counts as 30 min, from 10 min before its start).
  2. **Work talk**: a weekday inside the work hours (`COACH_WORK_HOURS`, default `09:00-18:00`, in `BEE_TZ`) with 2 to 4 distinct speakers.
  3. **Casual**: everything else.
- **Unknown inputs.** When a weekday conversation in work hours has no speaker count, or one outside 2 to 4, it is Casual with `confidence: "low"` (reason `speakers-unknown` or `speakers-out-of-range`). We picked Casual-low over an "unknown" setting so every conversation has one of the three plain words, and the wearer fixes a wrong guess with one press.
- **Speaker counts** come from the per-conversation counts: the number of distinct speaker labels (`SessionStats.speakers`, new in the offline files and the live ingest). An older file without it counts 2 when it has lines that are not the wearer's. Bee usually labels everyone but the wearer "Unknown", so 2 often means "two or more". A live conversation (for its recap) counts the wearer plus one when any line was someone else's.
- **The calendar** is read from Bee's today brief when a conversation starts and when `GET /api/settings` is asked (at most every 5 min), and only when the hub talks to Bee or runs the demo. Its times are kept in memory only, so a past day's meetings are found only for days the hub was running.
- **One-press correction.** `POST /api/sessions/<id>/setting {setting}` (`meeting`, `work`, `casual`, or `null` for automatic) takes a stats session id, a recap's conversation id or a recap id. It is a mutating route behind the same gate as the others (loopback, or LAN with `--lan`; refused through a tunnel or from a foreign Origin). The choice wins over every rule and is saved in `<stateDir>/live/settings.json` (`real/live/` in live mode, gitignored; ids, a setting and times only). The live stream's conversation id and the id Bee gives the finished conversation differ, so the two are matched by start time. The hub then publishes `stats.updated`.
- **On the TV.** The recap shows a chip ("Work talk") in its top corner: **Right** changes it (Meeting, Work talk, Casual, then round again). On Live, "Last conversation" has the same chip: move **Down** from the tabs to it and press **OK**. A choice shows "set by you".
- **Per-setting results** (`GET /api/settings`): each setting's habit rates, and for each practised habit its rate before and after the first practice within each setting. Drill lines are left out, and a setting under 400 words says "too little speech" instead of a number. Progress shows one quiet line right under the result, for example `By setting · Unsure words: meeting: too little speech · work talk 2.4 → 0.6 · casual 1.3 → 0.5`, hidden when no setting has enough speech on both sides. It never replaces the pre-registered headline.
- **Recaps** compare with the usual for their setting when that setting has 400 words (this week, else all Bee conversations): `Unsure words ran high: 4.2 per 100 words against your usual 1.4 at work.` Otherwise the overall usual, worded as before. The number rules are unchanged: the setting is words, never a slot. A later correction changes the chip, the stats and the served comparison: the recap then says where its usual came from (`... against your usual 1.4 from work talk.`) in `GET /api/recaps`, in "how am I doing?" and on the TV, which refetches the recap after your last press. A quote or the moment is never re-worded, and setting it back restores the first wording.
- **"How am I doing?"** names the setting of the last conversation: `Your last conversation, a meeting, ran high on ...`, or `... against your usual 1.6 in meetings.` when the recap used that setting's usual.

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
  - `facts.json`: the goal fact's id and its template text, and Bee's insight and fact counts (never another fact's or an insight's text);
  - `cues.json`: cue ids, the fixed cue text and alarm times;
  - `sessions.json`: finished conversations the hub ingested, as the wearer's lines plus per-conversation counts. Other speakers' lines are counted, never stored.
- **Where state lives.** `real/live/` in live mode (gitignored, and screened as wearer text by `npm run leak-check`), `out/demo/live/` in demo mode.
- **Logs.** Event names and ids only.
- **Proof.** The story plants a colleague line (marker `zebra orchid`). `test/live-engine.test.ts`, `test/live-plugin.test.ts`, `scripts/checks/live.ts` and `npm run demo:replay` all assert that it never reaches an event, a response or a file.

## Filming: masking private terms

The hub can hide names on everything a person sees or hears, so a screen recording of the real product shows no colleague, client or company names. It is display-only: grading, stats and the files under `real/` keep the real words.

1. List the names, one per line, in `coach/mask-terms.local.txt` (gitignored; lines starting with `#` are comments). The leak check's `coach/private-terms.local.txt` is masked too, so you only add what is not there already.
2. Restart the hub (`npm run hub`). It reads both files at start. Check `curl -s localhost:8791/api/health`: `"masking": "on (N terms)"`. The hub never prints, logs or serves the terms themselves.
3. Film. Each term is matched as a whole word, in any case, and a phrase ("Jordan Quill") across any spaces: "Acme" hides "ACME's" but not "Acmeville" (list that too if needed).

What is masked, all in the hub's output path (`src/hub/mask.ts`):

- **Screens** see `▒▒▒`: every JSON response (cards, attempts with the preview and Bee's text, recaps, coach narration, stats, the brief), the SSE stream, every WebSocket frame to the TV and phone (events, `hub.state`, relayed phone transcripts, practice captions) and the hub's home page.
- **Speech** says "name": the Alexa skill's answers and progressive responses, and MCP tool text and results (the `/sim/` page reads them aloud).
- **The Watch** sees `▒▒▒` in a recap to-do. `real/live/todos.json` records the to-do as sent, masked.
- **Not masked:** ids, keys, codes and links (so surfaces still match cards and attempts), and every file the hub persists.

Turn it off with `npm run hub -- --no-mask` or `HUB_MASK=0`; health then says `"masking": "off"`. With neither file present it is off. Only the hub command reads the two files: a hub started from code (`startHubServer`, as the tests do) masks only the terms it is given, and none by default.

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
   - Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it.
   - The hops: Bee's tag, then detection (milliseconds), the to-do create (about 1 to 2 s) and the 10 s alarm lead. On a slow Bee line the alarm can come up to about 30 s after the line.
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

### Bee memory and one cue (consented writes)

These write to your Bee account: **one goal fact** and **one or two to-dos** (cues). Nothing else writes; the spike only reads.

1. **The read-only spike (before any write):** `npx tsx src/hub/live/factsParse.ts inspect`. It runs `bee facts list --limit 5 --json`, the same with `--unconfirmed`, and `bee insights list --limit 5 --json`, and prints only each output's shape (keys, value types, array lengths) and what the readers made of it (`parsed.count`, confirmed flags, `cursor`), never a fact's text. If `output.shape` shows items with an `id` but `parsed.count` is 0, the readers need adjusting: share the shape lines, never the raw output.
2. **Start the hub:** `COACH_FACTS=1 COACH_CUES=1 npm run hub`. The live plugin's health note ends `Bee facts: live (pending); cues: on`.
3. **The one fact.** Say "Alexa, ask Speech Coach to quiz me", then say the line. After Bee's pass, within about a minute, `curl -s localhost:8791/api/coach/facts` shows `"status": "synced"` and `goal.factId`. Check that one fact only with `bee facts get <factId> --json` (not `bee facts list`, which prints every fact, and facts can name other people).
4. **The one cue.** With the iPhone locked and Bee recording, run `node skills/speaking-coach/scripts/coach.mjs cue --in 0` (or `curl -s -X POST localhost:8791/api/coach/cue -H 'content-type: application/json' -d '{"inMinutes":0,"by":"operator"}'`). The Watch buzzes about 10 s later. Note `wrist.todoId` in the answer. Running it again within 10 min answers `deduped: true` and makes no second to-do.
5. **Restart the hub:** no second fact (`real/live/facts.json` keeps the id), and within 10 min of the cue's alarm it is still deduped (`real/live/cues.json`).
6. **Undo.**
   - The cue to-do deletes itself 10 min after its alarm. To remove it at once: `bee todos delete <todoId> --json`.
   - The fact: stop the hub, run `bee facts delete <factId> --json`, then delete `real/live/facts.json`, and start the hub without `COACH_FACTS=1`. While `COACH_FACTS=1` is set, the next pass writes one goal fact again.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `NUDGE_ALARM_LEAD_S` | 10 | alarm lead for nudge and recap to-dos |
| `COACH_WRIST` | `bee-todo` (live), `replay` (demo or `--no-bee`) | `replay` = live dry run, no to-dos |
| `COACH_RECAP_LLM` | unset | `1` = Claude Haiku recap phrasing in live mode (Bedrock, profile `hackathon-1`) |
| `HUB_MASK` | on when a terms file exists | `0` = no display masking (same as `--no-mask`); see "Filming" above |
| `COACH_WORK_HOURS` | `09:00-18:00` | work hours for the Work talk setting (weekdays, `BEE_TZ`) |
| `COACH_INGEST` | on (live mode with the stream) | `off` = finished conversations are not ingested; run `npm run real` and restart as before |
| `COACH_FACTS` | unset (off: no Bee call) | `1` = keep one goal fact in Bee and read the insight and fact counts, live mode with the stream only (see "Bee memory") |
| `COACH_CUES` | unset (off) | `1` = `POST /api/coach/cue` sends a wrist cue in live mode (the demo hub always answers, on the replay wrist) |
| `BEE_BIN`, `BEE_TZ`, `BEE_WEARER_PERSON_ID` | | as for the hub (`CONTRACT.md` "Live mode") |

## Known limits

- **Live mode is not persisted:** a hub restart turns it off.
- **Ingest waits for Bee.** A conversation counts only once Bee marks it `COMPLETED`. That is Bee's own processing, from a few minutes to about an hour after the recording stops. The hub then takes it within a minute of the stream event, or by the next 10-min poll.
- **Ingested data is not retracted.** A conversation you delete in the Bee app after it was ingested stays in `real/live/sessions.json`, and in the stats, until you remove it from that file.
- **Delete races.** A `delete-conversation` that arrives after an idle-ended recap retracts the recap from storage, but `recap.ready` was already published (there is no retraction event).
- **Talk share.** Other speakers are only those lines Bee did not tag as the wearer, so a missed wearer tag counts toward the others.
- **Recap moments** exist only for hedges and "like" (vague answers and restarts have no mechanical rephrase).
- **Wrist lead.** The Watch only buzzes while Bee records and the iPhone is locked; otherwise the alarm lands on the iPhone.
- **Coach-written facts.** No source says Bee's chat, Daily Insights or Alexa+ read them. Bee may merge or reword facts; the coach then no longer finds its own by its text.
- **The facts JSON shape** is unverified until the spike (see "Bee memory and one cue").

## Contract change requests

These are worked around in code until the frozen contract changes:

1. **A deleted conversation's status.** `ConversationEnded.recap` has no value for "Bee deleted it". Today a deleted conversation ends with `recap: "skipped-short"`. Proposed: add `"skipped-deleted"`.
2. **A recap retraction event.** There is no event for it. Proposed: a sequenced `recap.retracted {recapId, conversationId, reason: "bee-deleted"}`, so the TV can drop a recap card.
3. **`delivery.wrist` at `recap.ready`.** It is `"scheduled"` before the Bee to-do call returns, because the contract orders `recap.ready` before the wrist. Proposed: document this, or add `"pending"`.
