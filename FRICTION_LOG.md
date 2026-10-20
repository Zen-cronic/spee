# Friction log: Speaking Mirror

Speaking Mirror is a speaking coach. Bee, on an Apple Watch, hears your real conversations; a Fire TV app shows your habits and the drills built from your own lines; and an Alexa skill, Speech Coach, runs the drills by voice. This log covers every Amazon product the submission touched: Bee, the Alexa Skills Kit and APL, Fire TV on Vega OS (including the open-source tv-voice-bridge, which carries a phone's voice to the TV), and AWS.

- **Dates covered:** 2026-10-12 to 2026-10-20. All times are EDT (UTC−4).
- **How the entries were gathered:** each entry was written when the friction happened, from the terminal output, the device logs, the build notes and the commits, with the exact error text. On 2026-10-20 the entries were re-checked wherever that was possible without new recordings (the Bee docs, the Amazon developer docs, the upstream pull request and a fresh Vega build), and the status column reflects that check. "Observed once, not re-checked" marks an observation that happened once and was not repeated.
- **Severity:** Blocker (no workaround, work stopped) · High (the workaround cost more than 1 h) · Medium (the workaround cost under 1 h) · Low (cosmetic, or a docs nit).
- **Status:** open (still present, no workaround) · worked around (still present; our workaround is in the entry) · fixed upstream (Amazon changed it).
- **Setup:** Toronto, Canada. Canadian Apple ID and App Store; Apple Watch SE 3 (GPS, 40 mm) and iPhone; Bee app 1.2.157; `@beeai/cli` 0.8.0; no Bee hardware (it ships to the US only). Ubuntu 24.04 (x86_64, KVM) with Vega CLI 1.4.4 and Vega SDK 0.24.12112, the Vega Virtual Device (VVD), and a Fire TV Stick (`armv7l`, Vega OS 2.0) on Wi-Fi. React Native 0.83 for Vega (`@amazon-devices/react-native-kepler` ~4.0). The Alexa skill is a development-stage custom skill, tested from the Alexa iPhone app (English, Canada) and from the Fire TV's Alexa. AWS in us-east-1.
- **An earlier Vega prototype:** entries marked "(earlier Vega prototype)" were hit while building an earlier Vega prototype for this hackathon, on the same machine, SDK and VVD, on 2026-10-14 and 2026-10-15. The Speaking Mirror TV app started from that prototype's Vega shell. Each of those entries says whether this project hit the problem again.
- **Left out on purpose:** device addresses and serials; account, skill and agreement ids; and anyone else's words. Bee conversation ids can be shared with the Bee team on request.

| ID | Product | Title | Severity | Status |
|---|---|---|---|---|
| FL-1 | Bee Apple Watch app | The Watch app freezes after the Watch disconnects from the iPhone | Medium | worked around |
| FL-2 | Bee docs, hackathon FAQ | Developer Mode silently needs a paired device | High | worked around (doc unchanged on 2026-10-20) |
| FL-3 | Bee API | The wearer's speaker label exists but is undocumented | Low | worked around |
| FL-4 | Bee Apple Watch app | The "Voice Notes" button setting does nothing on a Watch without an Action Button | Medium | worked around |
| FL-5 | Bee transcription | French speech is partly translated into English | High | worked around (scope change) |
| FL-6 | Bee API | Stopping a recording doesn't end the conversation, and offsets restart | Medium | worked around |
| FL-7 | Bee Apple Watch app | The only Watch voice-note path goes through Siri | Medium | worked around |
| FL-8 | Bee docs, API | The live stream carries undocumented timestamps and a wearer-tag event | Low | worked around (doc unchanged on 2026-10-20) |
| FL-9 | Bee transcription, API | Transcripts carry no confidence and take no custom vocabulary | Medium | worked around |
| FL-10 | Bee to-dos, Apple Watch | A to-do alarm reaches the Watch only while Bee records and the iPhone is locked | Medium | worked around |
| FL-11 | Bee CLI | The facts and insights JSON is untyped and undocumented | Low | worked around |
| FL-12 | Alexa on Fire TV | "Alexa, quiz me" starts Alexa's own quiz, not the skill | Low | worked around |
| FL-13 | Alexa on Fire TV | A speech-only skill response covers the app with a plain "Speech Coach" card | Medium | worked around (not yet seen on the TV) |
| FL-14 | Alexa Skills Kit | "How did I do" lands in the catch-all slot, not its own intent | Medium | worked around |
| FL-15 | Alexa Skills Kit | The 8 s response limit is shorter than Bee's line, so a drill takes two turns | Medium | worked around |

---

## Bee

### FL-1: The Bee Watch app freezes on a static screen and "tap to start" stops responding after the Watch disconnects from the iPhone (Bee Apple Watch app)
- **Date:** 2026-10-15 ~14:00–14:20 EDT (observed once, not re-checked)
- **Task attempted:** record a scripted French voice note on the Apple Watch for a transcription test.
- **Steps taken:**
  1. Opened Bee on the Apple Watch.
  2. Tapped "tap to start". Nothing happened, and the Bee screen stayed static.
  3. The Watch showed it was disconnected from the iPhone.
- **Expected result:** recording starts. If the iPhone link is down, the app says so, or records locally and syncs later.
- **Actual result:** a frozen Bee screen, with no error, no "phone disconnected" message and no way to start recording.
- **Severity:** Medium
- **Workaround used (about 20 min):**
  1. Force-quit Bee on the Watch (double-click the Digital Crown, swipe left on Bee, tap ✕).
  2. Opened Bee on the iPhone and kept it in the foreground for a moment.
  3. Reopened Bee on the Watch, which recovered. Restarting the devices was not needed.
- **Actionable suggestion:**
  - (a) When the iPhone link is down, show a "Reconnect to iPhone / open Bee on iPhone" state instead of a frozen screen.
  - (b) Let the Watch buffer a recording locally and sync it when the link returns.
  - (c) Say in the Developer Mode and Apple Watch docs that the Bee iPhone app must be running for the Watch app to start a recording.

### FL-2: Developer Mode silently needs a paired device, and the hackathon FAQ said otherwise (Bee docs / hackathon FAQ)
- **Date:** 2026-10-12 to 2026-10-15 (research, then first-hand setup); re-checked 2026-10-20
- **Task attempted:** enable Bee Developer Mode so the Bee CLI can connect, from Canada, without Bee hardware.
- **Steps taken:**
  1. Installed the Bee iOS app from the Canadian App Store.
  2. With no Watch paired, the app showed only "Set up a Bee device" / "Try with Apple Watch". There was no Settings → Version row to tap 5 times.
  3. The hackathon FAQ and Discord had said no device was needed. The organizer later corrected this on the forum: "enabling developer mode DOES require pairing either an Apple Watch or Bee device."
  4. Bought an Apple Watch, paired it in Bee, then Settings → Version ×5, `bee login`, `bee status`. Verified 2026-10-15 ~11:20 EDT.
- **Expected result:** https://docs.bee.computer/docs/developer-mode states that a paired device is a prerequisite.
- **Actual result:** the page lists only "update the app → Settings → tap Version 5 times". The prerequisite is undocumented, and the FAQ contradicted it. Re-checked 2026-10-20: the page (last updated June 7, 2026) is unchanged.
- **Severity:** High (it required buying hardware, after about 3 days of uncertainty)
- **Workaround used:** an Apple Watch SE 3. The whole path (Watch → Developer Mode → `bee login`) works from Canada with a Canadian Apple ID; we found no earlier first-hand report of it from outside the US.
- **Actionable suggestion:** add "Requires a paired Bee device or Apple Watch" to the Developer Mode page, and state that the Watch path works outside the US.

### FL-3: The wearer's speaker label is present on Watch conversations but undocumented, contradicting the open report that every speaker is "Unknown" (Bee API / docs)
- **Date:** 2026-10-15 ~12:00 EDT
- **Task attempted:** separate the wearer's own speech from other people's in Watch conversations, so that only the wearer's lines are coached.
- **Steps taken:**
  1. `bee conversations get <id> --json` on four real Watch conversations.
  2. Read the `speaker` field of each utterance against who spoke.
  3. Compared with [bee-cli issue 19](https://github.com/bee-computer/bee-cli/issues/19) ("Speaker is always "Unknown" in the developer API, even with my voice enrolled in the app"; 15,578 of 15,578 utterances "Unknown").
- **Expected result:** either every speaker is "Unknown", as the issue reports, or the docs describe a wearer label.
- **Actual result:**
  - Wearer lines carry the wearer's display name; other people's lines carry `"Unknown"`.
  - The name form varies within one account: the first name on some lines, the first and last name on others.
  - In one conversation the label was absent while it was still `CAPTURING`; in another it was present during `CAPTURING`.
  - Some French voice-assistant audio was labelled as the wearer: 9 of 151 wearer lines were flagged as possible mislabels.
- **Severity:** Low (a positive surprise, but undocumented)
- **Workaround used:** accept every name form the Bee profile gives (`bee me`, or `BEE_WEARER_LABELS`), and run a mislabel detector over the wearer's lines ([`src/real/corpus.ts`](src/real/corpus.ts), scored with `npm run mislabel:score`). Time not recorded separately.
- **Actionable suggestion:** document `speaker`: when the wearer label appears, its format, that it can be missing during `CAPTURING`, and its known false positives from media and assistant audio. Better, add a stable `is_wearer: true` flag instead of a display name.

### FL-4: The "Action Button → Hold and Speak → Voice Notes" setting does nothing on an Apple Watch without an Action Button, and there is no documented way to record a voice note from a Watch (Bee Apple Watch app / docs)
- **Date:** 2026-10-15 ~14:30 EDT (observed once, not re-checked)
- **Task attempted:** record a Bee voice note (an API "journal", the wearer-only channel) from an Apple Watch SE 3.
- **Steps taken:**
  1. In the Bee iPhone app: Settings → Action Button → Hold and Speak → **Voice Notes**.
  2. On the Watch, pressed and held the Bee screen and spoke.
  3. `bee journals list --json` returned `{"journals": []}`. The recording appeared as a **conversation** in `bee conversations list` instead.
- **Expected result:** a voice note (journal) is created, or the setting says it applies only to Bee hardware or an Apple Watch Ultra's Action Button.
- **Actual result:** the setting silently has no effect. The SE 3 has only the Digital Crown and the side button, and no voice-note control was found in the Watch app.
- **Severity:** Medium
- **Workaround used:** conversation recordings, which the wearer label (FL-3) makes usable for wearer-only analysis. Time not recorded.
- **Actionable suggestion:** say which hardware the Action Button setting applies to; add a voice-note control to the Watch app (a tap target or a complication); document how journals are created on each device.

### FL-5: French speech recorded on a Watch is partly transcribed or translated into English on an account whose primary language is English (Bee transcription)
- **Date:** 2026-10-15 14:23–14:41 EDT
- **Task attempted:** a transcription test. A 109-word scripted French text with 10 planted learner errors and 4 fillers, read aloud and recorded on the Watch.
- **Steps taken:**
  1. Reading 1 at 14:23, with English as the account's primary language.
  2. Reading 2 at ~14:31, after setting French as the primary language mid-conversation.
  3. Reading 3 at 14:40, with French primary.
  4. `bee conversations get <id> --json`, compared line by line with the script.
- **Expected result:** a French transcript, with the learner errors kept verbatim.
- **Actual result:** several French phrases came back as **English**, and the fillers were dropped every time.

  | Reading | Setting | Planted errors kept verbatim | Fillers kept |
  |---|---|---|---|
  | 1 (14:23) | English primary | 3/10 | 0/4 |
  | 2 (~14:31) | French primary, set mid-conversation | 4/10 | 0/4 |
  | 3 (14:40) | French primary | 2/10 | 0/4 ("ben" → "Bon") |

  - Reading 1: "la problème…" → "The problem is…"; "c'est un difficile exercice" → "and it's a difficult exercise"; "j'habite en Toronto" → "and I be in Toronto"; "Hier soir, j'ai allé à mon cours de français" → "Yers monde de France".
  - Reading 3 still produced English: "and I'm in Toronto", "Yes soir she allowed my courses", "and exit for my project examens".
  - Confound: all three readings were appended to one conversation that started under the English setting (FL-6).
  - By contrast, a natural French conversation earlier the same day kept learner errors ("cette groupe").
- **Severity:** High (for any language-learning use)
- **Workaround used:** none for scripted reading. The product changed scope: its pre-registered habits (2026-10-16) are English unsure words and filler "like", and French appears only as vocabulary moments. The French drill plan was dropped after a day of tests.
- **Actionable suggestion:** per-recording language selection, or automatic language ID that handles code-switching, instead of one account-level primary language. Never translate. Expose a `language` field per utterance in the API.

### FL-6: "Stopping" a Watch recording doesn't end the conversation; later recordings are appended to it, and their `start`/`end` offsets restart at 0 (Bee API)
- **Date:** 2026-10-15 14:23–14:41 EDT (one conversation; observed once, not re-checked)
- **Task attempted:** record three separate test readings as three separate conversations.
- **Steps taken:**
  1. Started a recording on the Watch, then stopped it.
  2. Repeated twice more, minutes apart, once after changing the primary language.
  3. `bee conversations list` and `bee conversations get <id> --json`.
- **Expected result:** one conversation per recording, or at least offsets that keep increasing.
- **Actual result:**
  - All three readings were appended to the same `CAPTURING` conversation.
  - Inside it, the third reading's utterances restart at `start: 36`, after earlier lines at `start: 380`, so sorting by `start` interleaves the recordings. Only `spoken_at` (epoch ms) increases monotonically.
  - Recordings appeared in the iPhone app a few minutes before the API returned them.
  - We first misread the transcript because of this.
- **Severity:** Medium (it silently scrambles transcripts for any client that orders by offset)
- **Workaround used:** order utterances by `spoken_at` and rebuild one timeline relative to the conversation start ([`src/real/corpus.ts`](src/real/corpus.ts)), with a regression test in [`test/real.test.ts`](test/real.test.ts). Time not recorded separately.
- **Actionable suggestion:**
  - Document that conversations are segmented on the server and can absorb later recordings.
  - Make offsets monotonic within a conversation, or add a recording (segment) id per utterance.
  - Let a client close a conversation.

### FL-7: The only voice-note path found on an Apple Watch SE 3 goes through Siri (Digital Crown hold), and it saves the Siri request as a Bee journal (Bee Apple Watch app)
- **Date:** 2026-10-15 ~14:32 EDT (observed once, not re-checked)
- **Task attempted:** record a Bee voice note from the Watch (see FL-4).
- **Steps taken:**
  1. Held the Digital Crown on the SE 3.
  2. Said "Hello, how can I get help with this Bee app?"
  3. `bee journals list --json`.
- **Expected result:** a Bee voice-note button on the Watch, independent of Siri.
- **Actual result:** Siri opened, and a Bee journal (voice note) was created with that text (state `READY`). No in-app voice-note control was found on the Watch.
- **Severity:** Medium
- **Workaround used:** conversation recordings with wearer labels serve the same purpose. No extra time.
- **Actionable suggestion:** add a voice-note control to the Bee Watch app, and document the Siri / App Intents path if it is intended.

### FL-8: The live stream (`bee stream`) carries timestamps and a speaker-identification event that the realtime docs don't describe (Bee docs / API)
- **Date:** 2026-10-16 14:35–14:40 EDT; docs re-checked 2026-10-20
- **Task attempted:** measure whether Bee's live feed is fast enough to grade a spoken drill line on a TV.
- **Steps taken:**
  1. `bee stream --types all --json`, with a local receive timestamp on every line.
  2. Recorded about a minute of speech on the Watch (9 utterances).
- **Expected result (per https://docs.bee.computer/docs/realtime):** `new-utterance` = `{utterance:{text,speaker}, conversation_uuid}`, with no timestamps.
- **Actual result:**
  - `new-utterance` also includes `id`, `sample_id`, `start`, `end` and `spoken_at`.
  - An undocumented `tagged-utterance` event (`utterance_id`, `person_id`, `person_first_name`, `speaker_score`) arrives about 0.5 s later and identifies the wearer live (8/9 utterances; scores 0.64–0.86). The first utterance of the recording was never tagged.
  - Delay from the end of speech to `new-utterance`: 4.3–14.7 s (median 5.4 s).
  - Re-checked 2026-10-20: the realtime page still shows `new-utterance` without timestamps and does not list `tagged-utterance`.
- **Severity:** Low (a positive surprise, but undocumented)
- **Workaround used:** read the extra fields defensively, and poll the conversation as a fallback, because the stream is at-most-once. No extra time.
- **Actionable suggestion:** document the `tagged-utterance` event and the timestamp fields, what `speaker_score` means, and when a tag may never arrive. Publish the typical latency.

### FL-9: Bee transcripts carry no confidence and take no custom vocabulary, so misheard words become fake speaking "errors" (Bee transcription / API)
- **Date:** 2026-10-15 ~12:45 EDT (the first real-data run) and 2026-10-16 14:36 EDT (the live stream)
- **Task attempted:** turn the wearer's real recurring speech errors into drill lines, from four real Watch conversations (about 2,000 words of the wearer's speech).
- **Steps taken:**
  1. The real-data pipeline (`npm run real`) fetched the conversations with `bee conversations get <id> --json` and asked a model for candidate errors in the wearer's lines.
  2. Looked in the payload for a way to tell a real error from a misrecognition. The utterance fields are `text`, `speaker`, `start`, `end` and `spoken_at` (plus `id` and `sample_id` on the stream).
  3. Watched the live stream (FL-8) while saying known phrases.
- **Expected result:** a per-word or per-utterance confidence (or alternatives), or a way to give Bee the words it keeps mishearing (names of people, products and tools).
- **Actual result:**
  - No confidence field anywhere. `speaker_score` (FL-8) rates the speaker, not the words.
  - Of 34 candidate items, 19 (56%) quoted a likely misrecognition. Without a guard they would have been drilled as if the wearer had said them; on an earlier real stand-up, misheard tool names had already leaked into the coaching.
  - Live: "drill card" came back as "drill car".
- **Severity:** Medium
- **Workaround used:** a model "ASR guard" that quarantines items quoting a suspected mishearing, then a second model check (precision on the kept items went from 40% to 75%, 15 items to 8), a deterministic glossary of known misheard terms, and fuzzy matching when grading a spoken line ([`src/hub/fuzzy.ts`](src/hub/fuzzy.ts)). Time not recorded separately (part of the 2026-10-15 rebuild).
- **Actionable suggestion:** add a per-word confidence to `conversations get` and to `new-utterance`, and a per-account custom vocabulary (settable from the CLI) that the recognizer is biased toward.

### FL-10: A Bee to-do alarm reaches the Apple Watch only while Bee is recording and the iPhone is locked; otherwise it lands on the iPhone (Bee to-dos / Apple Watch)
- **Date:** 2026-10-16 14:55–16:24 EDT (four runs); CLI docs re-checked 2026-10-20
- **Task attempted:** put a short coaching cue on the wrist during a conversation, using a Bee to-do with an alarm.
- **Steps taken:**
  1. `bee todos create --text "<cue>" --alarm-at <iso, 2 min ahead> --json` with the iPhone in use: the alarm showed on the iPhone only, with the full text.
  2. The same with the iPhone locked: it reached the Watch.
  3. Probe to-dos with alarm leads of 5, 10, 20 and 30 s, iPhone locked, Bee **not** recording: every alarm fired on time, on the iPhone; none reached the Watch.
  4. Leads of 10 and 30 s, iPhone locked and out of sight, Bee recording: both reached the Watch.
  5. `bee todos complete <id>`: the tick showed in the Bee iPhone app. Every test to-do was deleted afterwards.
- **Expected result:** the docs say where a to-do alarm is delivered, and a developer can target the Watch.
- **Actual result:** alarms fire on time with as little as a 5–10 s lead, but reach the Watch only while the iPhone is locked **and** Bee is recording. Nothing in the docs says so: https://docs.bee.computer/docs/cli documents `--alarm-at` only.
- **Severity:** Medium
- **Workaround used (about 15 min of probes):** live nudges fire only during a Bee recording, with a 10 s lead; the demo locks the phone before the wrist beat; recaps, sent after a recording stops, say "wrist or phone". `npm run wrist:probe` repeats the lead probe.
- **Actionable suggestion:** document where alarms are delivered and when; add a delivery target (Watch, phone or both) to `todos create`; and report delivery in the `todo-updated` event.

### FL-11: The facts and insights JSON is untyped in the CLI and undocumented (Bee CLI)
- **Date:** 2026-10-20 17:01–17:10 EDT; docs re-checked the same day
- **Task attempted:** keep one coaching-goal fact in Bee's memory, and read how many facts and insights Bee has.
- **Steps taken:**
  1. Read `@beeai/cli` 0.8.0: the facts and insights calls are typed `unknown`.
  2. Read https://docs.bee.computer/docs/cli: the facts section shows only Markdown example output (`# Fact 9001`, `- confirmed: false`, `- next_cursor: v1-…`), no JSON.
  3. Wrote tolerant readers, then a read-only spike, `npx tsx src/hub/live/factsParse.ts inspect`. It runs `bee facts list --limit 5 --json`, the same with `--unconfirmed`, and `bee insights list --limit 5 --json`, and prints only each output's shape, never a fact's text.
- **Expected result:** a documented JSON shape (or TypeScript types) for every `--json` output.
- **Actual result:** the real shape, found only by the spike:
  - `bee facts list --json` → `{facts: [{id: number, text: string, tags: string[], created_at: number, confirmed: boolean}], next_cursor: string | null, timezone: string}`;
  - `bee insights list --json` → `{insights: [...], next_cursor, timezone}`.
  - The readers parsed facts 5/5, unconfirmed 4/4 and insights 5/5.
  - Separately, no doc says whether Bee's chat, Daily Insights or the Alexa+ integration read a fact a developer writes.
- **Severity:** Low
- **Workaround used:** readers that accept the likely shapes ([`src/hub/live/factsParse.ts`](src/hub/live/factsParse.ts)), confirmed by the spike. The spike ran in seconds; the readers were part of the feature build (not timed).
- **Actionable suggestion:** publish a JSON example and a schema (or ship TypeScript types in `@beeai/cli`) for every `--json` command, and say which Bee surfaces read developer-written facts.

## Alexa

### FL-12: "Alexa, quiz me" on a Fire TV starts Alexa's own quiz instead of the enabled development skill (Alexa on Fire TV)
- **Date:** 2026-10-20 14:19 EDT (observed once, not re-checked)
- **Task attempted:** start a drill by voice from the Fire TV, with the Speech Coach development skill enabled for testing on the same Amazon account as the Fire TV.
- **Steps taken:**
  1. The Speaking Mirror app on the stick showed the prompt "Alexa, quiz me".
  2. Said "Alexa, quiz me" to the Fire TV.
- **Expected result (our assumption):** with "quiz me" as a sample of the skill's `StartDrillIntent`, the enabled skill would answer.
- **Actual result:** Alexa started its own quiz. A custom skill answers only when it is named, so our prompt was wrong.
- **Severity:** Low
- **Workaround used:** the TV now says "Alexa, ask Speech Coach to quiz me" (a one-line copy change, committed the same afternoon).
- **Actionable suggestion:** let a development-stage skill test name-free routing on the developer's own devices, or have Alexa offer "Did you mean Speech Coach?" when an enabled skill has an exact sample match.

### FL-13: On a Fire TV, a speech-only skill response replaces the app on screen with a plain "Speech Coach" card for a few seconds (Alexa on Fire TV / APL)
- **Date:** 2026-10-20 14:26 EDT (observed once, not re-checked)
- **Task attempted:** run a voice drill while Speaking Mirror stays on the TV, so that the viewer sees the drill in the TV app.
- **Steps taken:**
  1. Speaking Mirror running on the stick.
  2. "Alexa, ask Speech Coach to quiz me." The skill answered with speech and a reprompt, and no APL directive.
- **Expected result:** the app stays visible behind Alexa, or the Fire TV docs say what a speech-only response shows.
- **Actual result:** the screen showed only the text "Speech Coach" while the skill spoke and listened, and the app came back only a few seconds later.
- **Severity:** Medium
- **Workaround used (about 35 min, from the go-ahead at 14:27 to the first commits at 15:01):** every turn with something to show now sends an `Alexa.Presentation.APL.RenderDocument` with one of five Speaking Mirror screens ([`alexa/apl/speaking-mirror.json`](alexa/apl/speaking-mirror.json)), only when `supportedInterfaces` lists `Alexa.Presentation.APL`, and a response that ends the session sets `settings.idleTimeout` to 6 s. Redeployed to the development skill (both locales `SUCCEEDED`). Not yet seen on the Fire TV: the hub now logs one `alexa.device` line per kind of device, to record what the Fire TV reports ([docs/alexa.md](docs/alexa.md), "Screens (APL)").
- **Actionable suggestion:** document on the APL and Fire TV pages what a speech-only skill response shows on Fire TV and for how long, and give a skill a way to keep the foreground app visible during a voice exchange.

### FL-14: Inside a skill session, "how did I do" arrives in the catch-all slot instead of its own intent (Alexa Skills Kit)
- **Date:** 2026-10-16 15:06–15:12 EDT (a spike on the Alexa iPhone app; observed once, not re-checked)
- **Task attempted:** a two-intent turn design. A catch-all `AttemptIntent` takes any sentence the user repeats (a custom slot, sample `{attempt}`), and `HowDidIDoIntent` (samples "how did i do", "did i pass") asks for the verdict.
- **Steps taken:**
  1. "Alexa, open speech coach", then said the drill sentence.
  2. Said "how did I do".
  3. Read the request the endpoint received.
- **Expected result:** an exact sample of `HowDidIDoIntent` routes to `HowDidIDoIntent`.
- **Actual result:** the request arrived as `AttemptIntent`, with "how did I do" as the slot value.
- **Severity:** Medium
- **Workaround used:** whole-utterance rescue rules ([`src/alexa/route.ts`](src/alexa/route.ts)) move "how did I do", "how am I doing", "next", "stop", "quiz me", "help" and the live-coaching commands back to their intents, while a drill sentence that merely contains such a word ("The next release ships Friday.") stays an attempt. Time not recorded separately.
- **Actionable suggestion:** document how a lone-slot sample competes with exact samples of other intents, prefer an exact sample match over a catch-all, and publish a recommended pattern for a free-text answer turn.

### FL-15: A custom skill must answer within 8 s, but Bee's line for the same attempt arrives later, so a drill verdict takes two turns (Alexa Skills Kit)
- **Date:** 2026-10-16 15:06–15:12 EDT (the spike); the lag figures are FL-8's
- **Task attempted:** grade a spoken drill line from Bee's own wearer-tagged transcript, not from Alexa's, and speak the verdict in the same turn.
- **Steps taken:**
  1. "Alexa, open speech coach" → the skill read a drill line → the user repeated it.
  2. The endpoint watched `bee stream` for the wearer-tagged line for up to 6.5 s, under Alexa's 8 s limit.
- **Expected result:** a way to answer after the line arrives: a longer limit for a skill that declares it, or a supported follow-up in the open session.
- **Actual result:** Bee missed the 6.5 s window. Its tagged line arrived 3.4 s into the user's next turn ("how did I do"). A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn.
- **Severity:** Medium
- **Workaround used:** a two-turn drill: "Got it, checking with Bee. Ask me how you did in about 15 seconds." An early "how did I do?" sends a progressive response ("Checking with Bee.") and polls every 600 ms for at most 6.5 s ([`src/alexa/skill.ts`](src/alexa/skill.ts)). The progressive response has not yet run on a device. Time not recorded separately (it shaped the skill design).
- **Actionable suggestion:** a documented asynchronous result pattern for custom skills (deliver one short spoken result into the open session within a bounded time), or a longer limit for a skill that declares it.
