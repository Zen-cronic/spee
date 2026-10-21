# Friction log: Spee

Spee was called Speaking Mirror until 2026-10-21; the entries before that date use the new name.

Spee is a speaking coach. Bee, on an Apple Watch, hears your real conversations; a Fire TV app shows your habits and the drills built from your own lines; and an Alexa skill, listed as Spee and opened as "speech coach", runs the drills by voice. This log covers every Amazon product the submission touched: Bee, the Alexa Skills Kit and APL, Fire TV on Vega OS (including the open-source tv-voice-bridge, which carries a phone's voice to the TV), and AWS.

- **Dates covered:** 2026-10-12 to 2026-10-20. All times are EDT (UTC−4).
- **How the entries were gathered:** each entry was written when the friction happened, from the terminal output, the device logs, the build notes and the commits, with the exact error text. On 2026-10-20 the entries were re-checked wherever that was possible without new recordings (the Bee docs, the Amazon developer docs, the upstream pull request and a fresh Vega build), and the status column reflects that check. "Observed once, not re-checked" marks an observation that happened once and was not repeated.
- **Severity:** Blocker (no workaround, work stopped) · High (the workaround cost more than 1 h) · Medium (the workaround cost under 1 h) · Low (cosmetic, or a docs nit).
- **Status:** open (still present, no workaround) · worked around (still present; our workaround is in the entry) · fixed upstream (Amazon changed it).
- **Setup:** Toronto, Canada. Canadian Apple ID and App Store; Apple Watch SE 3 (GPS, 40 mm) and iPhone; Bee app 1.2.157; `@beeai/cli` 0.8.0; no Bee hardware (it ships to the US only). Ubuntu 24.04 (x86_64, KVM) with Vega CLI 1.4.4 and Vega SDK 0.24.12112, the Vega Virtual Device (VVD), and a Fire TV Stick (`armv7l`, Vega OS 2.0) on Wi-Fi. React Native 0.83 for Vega (`@amazon-devices/react-native-kepler` ~4.0). The Alexa skill is a development-stage custom skill, tested from the Alexa iPhone app (English, Canada) and from the Fire TV's Alexa. AWS in us-east-1.
- **An earlier Vega prototype:** entries marked "(earlier Vega prototype)" were hit while building an earlier Vega prototype for this hackathon, on the same machine, SDK and VVD, on 2026-10-14 and 2026-10-15. The Spee TV app started from that prototype's Vega shell. Each of those entries says whether this project hit the problem again.
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
| FL-16 | Vega SDK, Amazon devices agent skills | No app-level speech-to-text, and Amazon's agent skill pointed to an archived library | High | worked around; docs fix filed upstream (open) |
| FL-17 | Vega media player | URL mode refuses http and a local-CA https URL with a bare MediaError 4 | High | worked around |
| FL-18 | Vega media player | MSE says yes to `audio/mpeg` but never plays it; only fragmented MP4/AAC works | High | worked around |
| FL-19 | Vega Virtual Device | WebSocket frames over about 1.4 KB are dropped on the VVD's NAT path | Medium | worked around |
| FL-20 | Vega build, React Native for Vega | A custom Metro resolver ships core React Native, and the crash leaves no JS error | Medium | worked around |
| FL-21 | Vega CLI | `run-app` says "Successfully launched" when the new build is not running | Medium | worked around |
| FL-22 | Fire TV Stick, Vega CLI | Connecting a real stick: "No devices found", then "Connection refused" | Medium | worked around |
| FL-23 | Vega manifest | The docs call `icon` required; the validator calls it optional | Low | open |
| FL-24 | React Native for Vega | Text and animated styles render differently from react-native-web | Low | worked around |
| FL-25 | Amazon Bedrock | Every Anthropic model fails until a use-case form is submitted | Medium | worked around |
| FL-26 | Amazon Bedrock, AWS Marketplace | A model call accepts a Marketplace offer even when the call fails | Medium | worked around |
| FL-27 | Hackathon rules, Devpost form | The private-repo sharing instructions disagree, and the list changed | Low | worked around |
| FL-28 | Hackathon rules, office hours | Office hours said development may continue; the written update forbids it | Low | worked around |

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
  1. The Spee app on the stick showed the prompt "Alexa, quiz me".
  2. Said "Alexa, quiz me" to the Fire TV.
- **Expected result (our assumption):** with "quiz me" as a sample of the skill's `StartDrillIntent`, the enabled skill would answer.
- **Actual result:** Alexa started its own quiz. A custom skill answers only when it is named, so our prompt was wrong.
- **Severity:** Low
- **Workaround used:** the TV now says "Alexa, ask Speech Coach to quiz me" (a one-line copy change, committed the same afternoon).
- **Actionable suggestion:** let a development-stage skill test name-free routing on the developer's own devices, or have Alexa offer "Did you mean Speech Coach?" when an enabled skill has an exact sample match.

### FL-13: On a Fire TV, a speech-only skill response replaces the app on screen with a plain "Speech Coach" card for a few seconds (Alexa on Fire TV / APL)
- **Date:** 2026-10-20 14:26 EDT (observed once, not re-checked)
- **Task attempted:** run a voice drill while Spee stays on the TV, so that the viewer sees the drill in the TV app.
- **Steps taken:**
  1. Spee running on the stick.
  2. "Alexa, ask Speech Coach to quiz me." The skill answered with speech and a reprompt, and no APL directive.
- **Expected result:** the app stays visible behind Alexa, or the Fire TV docs say what a speech-only response shows.
- **Actual result:** the screen showed only the text "Speech Coach" while the skill spoke and listened, and the app came back only a few seconds later.
- **Severity:** Medium
- **Workaround used (about 35 min, from the go-ahead at 14:27 to the first commits at 15:01):** every turn with something to show now sends an `Alexa.Presentation.APL.RenderDocument` with one of five Spee screens ([`alexa/apl/speaking-mirror.json`](alexa/apl/speaking-mirror.json)), only when `supportedInterfaces` lists `Alexa.Presentation.APL`, and a response that ends the session sets `settings.idleTimeout` to 6 s. Redeployed to the development skill (both locales `SUCCEEDED`). Not yet seen on the Fire TV: the hub now logs one `alexa.device` line per kind of device, to record what the Fire TV reports ([docs/alexa.md](docs/alexa.md), "Screens (APL)").
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

## Fire TV and Vega

### FL-16: Vega gives a third-party app no speech-to-text, and Amazon's devices agent skill pointed developers to an archived library with no Vega support (Vega SDK / Amazon devices agent skills)
- **Date:** 2026-10-14 (the first Vega spike) to 2026-10-20 (docs fix filed)
- **Task attempted:** let the user say a drill line to the TV app and have the TV show it.
- **Steps taken:**
  1. Looked for a speech API in Vega SDK 0.24 and its docs. The accepted Amazon staff answer in [forum topic 29064](https://community.amazondeveloper.com/t/speech-to-text-api-for-a-webview-app/29064) (2026-09-04): "VegaOS does not expose an app-level speech-to-text API like Android's SpeechRecognizer". The only platform speech-to-text is keyboard dictation into a focused `TextInput` (hold the Alexa button). WebView `getUserMedia` audio is "not yet supported" for third-party apps ([forum topic 28161](https://community.amazondeveloper.com/t/issues-with-microphone-access-for-jitsi-integration-on-vega-os/28161), 2026-07-24).
  2. Read Amazon's devices agent skills, [`rn-tv-ui-best-practices/references/input-handling.md`](https://github.com/AmazonAppDev/devices-agent-skills/blob/main/skills/rn-tv-ui-best-practices/references/input-handling.md) in `AmazonAppDev/devices-agent-skills`, "Voice input". It called `react-native-voice` the common path. That repository is archived on GitHub and ships only iOS and Android native modules.
- **Expected result:** a supported way to get the user's words into a Vega app, and agent guidance that names it.
- **Actual result:** no app-level speech-to-text, and an agent following the skill would reach for a library that cannot work on Vega.
- **Severity:** High
- **Workaround used:** the phone is the microphone. The open-source tv-voice-bridge pairs a phone with the TV by QR code, carries the phone browser's speech recognition to the TV over a WebSocket, and carries the TV's replies back. It was built over 2026-10-14 to 2026-10-20 and is now a separate open-source project. A knock-on cost: phone browsers allow speech recognition only on https (Safari 26 hides it on an insecure page; Chrome reports `insecure-context`), so the phone page needs a tunnel or a LAN certificate.
- **Actionable suggestion:** we filed the docs fix: https://github.com/AmazonAppDev/devices-agent-skills/pull/15 (open on 2026-10-20). It says `react-native-voice` is archived with no Vega support, and that Vega has no app-level speech-to-text API, so dictation goes through the system keyboard. Beyond that: one Vega page listing the voice-input options (dictation, Content Launcher, a companion device), and an app-level speech API or a sanctioned companion-device channel.

### FL-17: The W3C media player in URL mode refuses `http://` and a local-CA `https://` URL, with only "MediaError 4" in JavaScript (Vega media player) (earlier Vega prototype)
- **Date:** 2026-10-14 16:06–16:47 EDT, on the VVD (SDK 0.24.12112); not re-checked on the Vega OS 2.0 stick
- **Task attempted:** play the TV's spoken reply, an mp3 generated by the hub on the developer's machine, with `AudioPlayer` from `@amazon-devices/react-native-w3cmedia` 2.3.2, as its README shows (`audioPlayer.src = url; play()`).
- **Steps taken:**
  1. `new AudioPlayer(); await initialize(); p.src = 'http://<hub>:<port>/api/tts/say_0001.mp3'; await p.play()`.
  2. An `error` event 7 ms later, `p.error.code === 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`), an empty message, and no GET on the hub.
  3. Served the same file over https with a local CA, through `vega device start-port-forwarding --port <port> --forward false`. `vega exec vda shell "curl https://127.0.0.1:<port>/api/health"` gave `000 ssl_verify=20` (200 with `-k`), and the player again gave MediaError 4.
- **Expected result:** http plays (a LAN dev server), or the README and the error say "https required"; and a developer-mode way to trust a dev CA.
- **Actual result (device log, verbatim):**
  - http: `MEDIA_PLAYER:MediaPlayerUtils.cpp(113) isUriSchemeSecure Got an insecure protocol/scheme http, return error` / `DefaultMediaPlayer.cpp(2009) openMedia Invalid URI, return error` / `W3CMEDIA:[MSE_EME] set_src_uri: MPB Call failed with code: 50004.`
  - local CA: `souphttpsrc ... error: Unacceptable TLS certificate (6)`.
  - JavaScript gets only `MEDIA_ERR_SRC_NOT_SUPPORTED`. The w3cmedia README never mentions the scheme rule.
  - Amazon staff wrote on [forum topic 27667](https://community.amazondeveloper.com/t/shaka-player-fails-with-unknown-error-on-http-video/27667) (2026-10-05) that cleartext http in URL mode was fixed in a September 2026 OS update. We have not checked that on the stick.
- **Severity:** High (about 70 min across the three attempts)
- **Workaround used:** first, a private S3 bucket and a presigned https URL per clip (tap → audio start 378 and 391 ms on the VVD), which made a LAN feature depend on the internet. Then, on 2026-10-19, plain http through Media Source Extensions as fragmented MP4/AAC (FL-18), with no certificate and no cloud.
- **Actionable suggestion:** say "URL mode needs a publicly trusted https URL" in the w3cmedia README and the media player guide; put the reason in `MediaError.message` ("insecure scheme http", "untrusted certificate"); and allow http or a user CA for media in developer mode.

### FL-18: Media Source Extensions say yes to `audio/mpeg` but never play raw MP3; only fragmented MP4/AAC works (Vega media player) (earlier Vega prototype, then this project)
- **Date:** 2026-10-14 16:15 EDT (the failure, VVD) and 2026-10-19 (the working path, VVD)
- **Task attempted:** work around FL-17 by fetching the clip over http in JavaScript and feeding it to the player through MSE (`AudioPlayer.srcObject = new MediaSource()`, `addSourceBuffer('audio/mpeg')`, `appendBuffer(bytes)`).
- **Steps taken:**
  1. `MediaSource.isTypeSupported('audio/mpeg', true)` returned `true`; the fetch took 18–24 ms; `appendBuffer` fired `updateend`.
  2. `endOfStream()` right after `updateend`. Device log: `onMediaTypeFound mimeType = application/x-id3`, then `DemuxerImpl::end_of_stream: EndOfStream is called before initialization is completed.` / `Demuxer initialization failed. status: Type : DEMUXER_INVALID_STATE`, then MediaError 3.
  3. Stripped the ID3v2 tag: typefind reported `audio/mpeg probability = 100`, but `loadedmetadata` never fired (waited 2.5 s).
  4. `play()` before `endOfStream()`, then waited 4 s for `playing`: nothing, then MediaError 3.
  5. The same for three files: espeak (22.05 kHz mono), ffmpeg 44.1 kHz stereo 128k with no ID3 or Xing header, and an Amazon Polly generative clip (24 kHz mono).
  6. On 2026-10-19: transcoded the reply to fragmented MP4 with AAC and appended it the same way.
- **Expected result:** raw MP3 through MSE plays, as in browsers and as `isTypeSupported` implies, or `isTypeSupported('audio/mpeg')` returns false.
- **Actual result:**
  - Raw MP3: the demuxer waits for data forever, and the element errors with `MEDIA_ERR_DECODE`.
  - Fragmented MP4/AAC over plain http plays. On the VVD, with a scripted phone, 4 of 4 replies played to the end: speech end → reply audible 217–322 ms.
  - Switching the same player back to an https URL afterwards: `srcObject = null` throws on Vega (the exception text was not recorded), unlike a browser, so the player now sets `src` directly. Checked with http, https, http, https, https, http in a row.
  - The [media player page](https://developer.amazon.com/docs/vega/0.24/media-player.html) lists MSE only for HLS and DASH containers, and MP3 only under URL mode, which fits what we saw.
- **Severity:** High (no client-only path in the first time box; the working path needed a transcoding step and a new player)
- **Workaround used:** the hub transcodes each reply to fragmented MP4/AAC with ffmpeg, and the bridge's Vega player plays it through MSE and refuses raw MP3 over http with a clear message. 25 min on 2026-10-14 without a fix; the fMP4 path on 2026-10-19 was not timed.
- **Actionable suggestion:** make `isTypeSupported('audio/mpeg')` truthful; list the audio-only containers MSE accepts; add an audio-only MSE sample; and let `srcObject = null` clear the stream, as the W3C model does.

### FL-19: WebSocket frames over about 1.4 KB are dropped on the VVD's NAT path to the host (`10.0.2.2`); the reverse port forward loses nothing (Vega Virtual Device) (earlier Vega prototype)
- **Date:** 2026-10-14 16:08 EDT; this project used the reverse forward from the start, so it was not re-checked
- **Task attempted:** drive the TV app over a WebSocket from a hub on the host, at the emulator's host address `ws://10.0.2.2:<port>/ws`.
- **Steps taken:**
  1. Small messages (about 300 B) always arrived: 20 of 20.
  2. A 4,071-character message (a bit over 4 KB on the wire) never arrived on the TV; a Node client in the same room got it.
  3. An echo probe of set sizes: over `10.0.2.2` only 2,100 and 4,000 B arrived; 1,500, 3,000, 4,090, 4,100, 4,500, 8,000, 16,000 and 65,000 B were lost.
  4. `vega device start-port-forwarding -d VirtualDevice --port <port> --forward false`, with the app on `ws://127.0.0.1:<port>/ws`, then the same sweep.
- **Expected result:** a TCP stream delivers every WebSocket frame.
- **Actual result:** over NAT, frames larger than about one TCP segment were lost unpredictably, with no `onerror` or `onclose` in JavaScript and no device log line. Over the reverse forward, 10 of 10 sizes up to 65 KB arrived, and phone tap → TV render measured 6–69 ms.
- **Severity:** Medium (about 40 min to isolate)
- **Workaround used:** the reverse port forward (`127.0.0.1` on the device), now the documented setup in [docs/tv.md](docs/tv.md). The bridge client also has a heartbeat, so a link that goes silent is dropped even when `onclose` never fires.
- **Actionable suggestion:** investigate the VVD's user-mode networking for multi-segment WebSocket frames, and until then say on the VVD page "use `start-port-forwarding --forward false` for host services, not `10.0.2.2`".

### FL-20: A custom Metro `resolveRequest` silently drops the Vega platform mapping, so a "successful" build ships core React Native, and the app aborts at launch with only "signal 6" in the log (Vega build / React Native for Vega) (earlier Vega prototype)
- **Date:** 2026-10-14 16:00–16:01 EDT (observed once, not re-checked)
- **Task attempted:** bundle a shared TypeScript package outside the app folder (TS-ESM imports like `./protocol.js`), which needs a custom Metro resolver.
- **Steps taken:**
  1. Added `resolver.resolveRequest` in `metro.config.js`: strip `.js` for files in the shared folder, else call `context.resolveRequest(...)`.
  2. The template's `build:release` script printed `info build-vega completed` and `manifest validation found 0 errors`.
  3. `vega run-app <app>_x86_64.vpkg <app id>.main -d VirtualDevice` printed `Successfully launched the app`, but the VVD showed the system Settings screen.
  4. `vega device is-app-running` said `<app id>.main is not running`. `vega device start-log-stream` showed `acr_core_dump: Process '<app id>' (PID=…) crashed with signal 6 ... Fingerprint: JSThread_6_...`, and no JavaScript error text.
  5. `vega exec vda -s emulator-5554 pull /var/lib/data/acr/tombstones/crash_….acr ./acr/` → `vda: error: failed to stat remote object '...acr': Permission denied`.
  6. The template's `build:debug` script failed: `error Unable to resolve module ../../src/private/devsupport/rndevtools/ReactDevToolsSettingsManager from .../node_modules/react-native/Libraries/Core/setUpReactDevTools.js`.
  7. The release sourcemap listed 408 modules from core `react-native` and 0 from `@amazon-devices/react-native-kepler`.
- **Expected result:** the documented Metro extension point composes with Vega's platform resolution, or the build fails when the bundle has no Kepler runtime; and a JS crash logs its message.
- **Actual result:** the custom resolver replaced the out-of-tree platform mapping (`react-native` → `@amazon-devices/react-native-kepler` on platform `kepler`). The release build succeeded with the wrong React Native, and the app aborted on its JS thread with no actionable message. Separately, on 2026-10-15 the app's JS context restarted once, 3 s into an audio clip, with nothing in any log (observed once; not reproduced in three later full runs).
- **Severity:** Medium (about 40 min, including the crash diagnosis)
- **Workaround used:** re-apply the mapping inside the custom resolver (`if (platform === 'kepler') moduleName = '@amazon-devices/react-native-kepler'`), plus `nodeModulesPaths` for files outside the app. Spee avoids the problem: its Vega app uses the default Metro config, and its release sourcemap has 15 `@amazon-devices/react-native-kepler` modules and 0 core `react-native` modules ([docs/tv.md](docs/tv.md), "Bundle check").
- **Actionable suggestion:** make `build-vega` assert that the bundle contains the Kepler runtime ("react-native resolved to core RN; a custom resolveRequest may override the Vega platform resolver"); document the composition pattern on the Metro and monorepo page; log an uncaught JS exception (message and first frames) before aborting; and let `vega device copy-logs` fetch the app's own crash reports on the VVD.

### FL-21: `vega run-app` prints "Successfully launched" when the new build is not what is running, and `is-app-installed` says "not installed" for the package name (Vega CLI)
- **Date:** 2026-10-15 12:04 EDT (VVD, earlier Vega prototype) and 2026-10-20 14:12–14:14 EDT (Fire TV Stick, this project); each observed once
- **Task attempted:** install a new build and see it running, on the VVD and on a real stick.
- **Steps taken:**
  1. VVD, app already running: rebuilt, then `vega run-app <app>_x86_64.vpkg <app id>.main -d VirtualDevice` → `Successfully launched the app`. The old JavaScript kept running (the app rejoined the hub with the pairing code held in its old JS context), and `vega device is-app-running` said it was running.
  2. Stick, just after its reboot into TCP/IP mode (FL-22): `npm run tv:vega:build`, then `vega run-app tv/vega/build/armv7-release/speakingmirror_armv7.vpkg com.beecoach.mirror.main -d <device>` → success, but the TV showed nothing.
  3. Stick: `vega device is-app-installed -d <device> --appName com.beecoach.mirror` (the package name) answered not installed; with `com.beecoach.mirror.main` (the component name) it answered installed.
- **Expected result:** `run-app` restarts an app whose package changed, and reports success only once the new build is running; app-state commands accept the package name, or say which name they expect.
- **Actual result:** a silent stale UI on the VVD; a "launched" app that was not on screen on the stick (most likely launched while the stick was still settling after the reboot, then closed); and a false "not installed".
- **Severity:** Medium (about 10 min on the VVD; about 1 min on the stick)
- **Workaround used:** always `vega device terminate-app -d <device> --appName <app id>.main` before `run-app`. If the TV shows nothing: `vega device is-app-running …`, then `vega device launch-app -d <device> --appName com.beecoach.mirror.main` (the app was on screen a minute later, at 14:13). Always use the component name. All of it is in the stick checklist in [docs/tv.md](docs/tv.md).
- **Actionable suggestion:** make `run-app` terminate a running instance when it installs a different vpkg (or add `--restart`), check that the app is running before printing success, and accept either name in `is-app-installed` and `is-app-running` (or answer "did you mean com.beecoach.mirror.main?").

### FL-22: Connecting a real Fire TV Stick to the dev machine: "No devices found" over USB, then "Connection refused" over Wi-Fi until Connection Mode is TCP/IP (Fire TV Stick / Vega CLI)
- **Date:** 2026-10-20 14:01–14:13 EDT (observed once, not re-checked)
- **Task attempted:** install Spee on a Fire TV Stick (Vega OS 2.0) in developer mode, plugged into a monitor's HDMI port and powered from a wall adapter.
- **Steps taken:**
  1. Connected a USB-C cable from the laptop to the monitor and ran `vega device list` → `No devices found`. `lsusb` showed no Lab126 device: the cable reached the monitor, not the stick.
  2. The stick's only USB-C port is its power port, already used by the wall adapter, so there was no free port for data.
  3. Switched to Wi-Fi: Settings → My Fire TV → About → Network gave the stick's address, and `ping` answered. `vega exec vda connect <stick IP>:5555` → `Connection refused`.
  4. Settings → My Fire TV → Developer Options → **Connection Mode → TCP/IP**. The stick rebooted. `vda connect` answered on the second try, about 10 s after the reboot, and `vega exec vda devices` listed `<stick IP>:5555  device`.
- **Expected result:** the developer-mode steps say that a stick connects either through its own power port (a data cable to the computer) or over TCP/IP, and the CLI errors point there.
- **Actual result:** the answer is on [VDA over TCP/IP](https://developer.amazon.com/docs/vega/0.24/vda-over-tcpip) (re-checked 2026-10-20), but neither "No devices found" nor "Connection refused" points to it, and nothing says that the stick's single port is also its power port.
- **Severity:** Medium (about 12 min, including the reboot)
- **Workaround used:** Wi-Fi with Connection Mode TCP/IP, plus the reverse port forward (`vega device start-port-forwarding -d <device> --port 8791 --forward false`), which also works over Wi-Fi. The troubleshooting table in [docs/tv.md](docs/tv.md) has the details.
- **Actionable suggestion:** when `vega device list` finds nothing, suggest TCP/IP mode and `vda connect`; when port 5555 refuses, say "Connection Mode may be USB: Developer Options → Connection Mode → TCP/IP"; and link the TCP/IP page from the developer-mode page, with a note on the stick's single USB-C port.

### FL-23: The manifest docs call `[package] icon` required and describe only the Settings icon; the build's validator calls it optional, and our app shipped without one (Vega manifest)
- **Date:** 2026-10-20 ~15:30 EDT (noticed); re-checked with a fresh build at 17:22 EDT
- **Task attempted:** give the Spee TV app its own launcher tile, using the new logo.
- **Steps taken:**
  1. [`tv/vega/manifest.toml`](tv/vega/manifest.toml) (from the earlier prototype's Vega shell) has no `icon` line. We first concluded the manifest had no icon slot.
  2. Re-check: the [manifest `[package]` page](https://developer.amazon.com/docs/vega/0.24/manifest-package) says "icon (string, required): Image file to be used as the icon for the app within the Settings -> Applications -> Managed Installed Applications screen", a 512x512 PNG of at most 1 MB under `assets/image`.
  3. `npm run tv:vega:build` with that manifest.
- **Expected result:** the validator and the docs agree on whether `icon` is required, and the docs say which surfaces use it (the Settings screen, "Your Apps & Channels", the home row).
- **Actual result:** the build prints `manifest validation found 0 errors`, then `manifest.toml:3:1 info: [package.icon] Icon is not defined in the manifest. System default will be used.`: an info line in a long build log. The doc names only the Settings screen. An Amazon reply on [forum topic 28787](https://community.amazondeveloper.com/t/vega-lat-users-cannot-see-the-app-after-it-has-been-installed-on-their-device/28787) says a wrongly sized icon can keep an app out of "Your Apps & Channels", so the icon matters more than the page suggests.
- **Severity:** Low
- **Workaround used:** none yet. The app runs with the system default icon; a 512 px tile of the logo is ready.
- **Actionable suggestion:** make the validator and the docs agree (an error or a warning if `icon` is required; "optional, defaults to the system icon" if not), list every surface that uses it, and put an `icon` line and a placeholder PNG in the project templates.

### FL-24: React Native for Vega renders text and animated styles differently from react-native-web, which broke views shared by the web TV and the Vega app (React Native for Vega) (earlier Vega prototype, then this project)
- **Date:** 2026-10-15 12:01–12:08 EDT (VVD captures) and 2026-10-19 (this project)
- **Task attempted:** run the same view code in the web TV (react-native-web) and the Vega app.
- **Steps taken (what differed):**
  1. A label `Text` with `letterSpacing: 3` nested inside a paragraph `Text`: on Vega the whole paragraph took the wide tracking; on the web only the label did.
  2. A view whose style switched from a plain style to an `Animated` style (opacity and translate, `useNativeDriver: true`) in the same render that started the animation stayed invisible on Vega.
  3. Very large heavy text (`fontSize: 200`, `fontWeight: '900'`) whose start sat on the safe-zone edge lost the left third of its first glyph on Vega; removing `letterSpacing: -6` did not fix it.
  4. In Spee (2026-10-19), negative letter spacing on light numerals drew a sliver on Vega.
- **Expected result:** the same rendering as react-native-web, or a dev-build warning.
- **Actual result:** the differences above, found only on device captures, not by jest or `tsc`.
- **Severity:** Low (cosmetic, but on the most important numbers on the screen)
- **Workaround used (about 35 min):** sibling `Text`s in a row instead of nesting; attach the animated style from the first render; side padding with a negative margin on big numerals, weight 800 instead of a synthetic 900, and no negative letter spacing on light numerals ([docs/tv.md](docs/tv.md), "Rendering").
- **Actionable suggestion:** document nested-`Text` style inheritance and native-driver attach timing on Vega (or warn in dev builds), don't clip glyph ink at the layout box, and list which weights the system font ships.

## AWS

### FL-25: Amazon Bedrock refuses every Anthropic model, even on non-streaming Converse, until a use-case form is submitted (Amazon Bedrock)
- **Date:** 2026-10-14, until 15:12 EDT
- **Task attempted:** run the coach's proof of concept on Claude Haiku 4.5 through the Bedrock Converse API in us-east-1 (forced tool use, structured output).
- **Steps taken:**
  1. `aws bedrock-runtime converse --region us-east-1 --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 --messages '[{"role":"user","content":[{"text":"ping"}]}]'`
  2. The same from the proof-of-concept code, streaming and non-streaming.
  3. AWS console → Amazon Bedrock → Model access → "Submit use case details for Anthropic".
- **Expected result:** a model listed as available answers, or the error names the console page that fixes it.
- **Actual result:** `ResourceNotFoundException: Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model.` The form is submitted once per account, and AWS says the answers are shared with Anthropic. Access opened at 15:12, about two minutes after the form went in.
- **Severity:** Medium
- **Workaround used:** ran the proof of concept on `openai.gpt-oss-120b-1:0` until the form went through, then re-ran it on Claude. Time not recorded beyond that.
- **Actionable suggestion:** put the console path (or a link) in the error, show the gate in `get-foundation-model-availability`, and mention the form in the hackathon's AWS setup guidance.

### FL-26: Invoking a third-party Bedrock model accepts its AWS Marketplace offer, even when the call fails (Amazon Bedrock / AWS Marketplace)
- **Date:** 2026-10-14 15:08–15:13 EDT (observed once, not re-checked)
- **Task attempted:** a short sweep of Converse calls across the models Bedrock listed in us-east-1, to pick a fallback while Anthropic access was gated (FL-25).
- **Steps taken:**
  1. One Converse call per model, with forced tool use.
  2. One model rejected the request with a `ValidationException` (it does not accept `toolChoice.tool`).
  3. Read the account's email and `aws marketplace-agreement search-agreements`.
- **Expected result:** a failed call subscribes the account to nothing, and a paid Marketplace subscription needs an explicit accept.
- **Actual result:** four Marketplace agreements were created, each with an email "You accepted an AWS Marketplace offer", one of them for the model whose call had failed. The Claude usage that followed bills as Marketplace usage types (`MP:USE1_InputTokenCount-Units`, `MP:USE1_OutputTokenCount-Units`), so whether a promotional credit covers it depends on the credit.
- **Severity:** Medium
- **Workaround used:** cancelled the two unneeded agreements the same day with `aws bedrock delete-foundation-model-agreement`, and stopped sweep-probing third-party models. Time not recorded.
- **Actionable suggestion:** never create an agreement on a failed call; require an explicit accept (in the console or with `create-foundation-model-agreement`) before the first paid call; and say in the response when a call subscribed the account.

## Hackathon process

### FL-27: The private-repo sharing instructions disagree between the Devpost form, the rules and the final checklist, and the reviewer list changed during the event (hackathon rules / Devpost form)
- **Date:** 2026-10-07 (the form against the rules) and 2026-10-20 (the rules re-fetched)
- **Task attempted:** keep the product repo private and share it with the judges, as the rules allow.
- **Steps taken:**
  1. The Devpost form's helper text says to share a private repo with "@AmazonAppDev".
  2. The rules (2026-09-16 update) listed six individual GitHub accounts instead.
  3. The rules re-fetched on 2026-10-20 list five; one account was removed.
  4. The official "Final stretch" update's checklist asks for "a link to your public code repository, with an open source license visible at the top", while the rules still allow a private repo shared with the reviewers.
- **Expected result:** one list of accounts in one place, with the date it changed, and one answer on whether a private repo is acceptable.
- **Actual result:** three sources, three answers.
- **Severity:** Low
- **Workaround used:** follow the current rules: invite the five listed accounts and Devpost's testing account (planned for 2026-10-22), then check acceptance two days later, because GitHub invites expire after 7 days. Time: minutes.
- **Actionable suggestion:** keep the reviewer list in one place (the rules), date every change, say whether an organization invite counts, and make the checklist match the rules on private repos.

### FL-28: Office Hours 2 said development may continue after the deadline; the official written update forbids any edit until the winners are announced (hackathon rules / office hours)
- **Date:** 2026-10-19 (Office Hours 2) and 2026-10-20 (the update read)
- **Task attempted:** plan the work after the submission deadline (2026-10-23 12:00 PDT, 15:00 EDT).
- **Steps taken:**
  1. At Office Hours 2, an entrant asked whether development can continue after the deadline. The hosts said yes: judges see the repo as of the deadline, and a release tag helps.
  2. Read the official update, https://amazonappdev2026.devpost.com/updates/46539-final-stretch: "Once the deadline passes, submissions are locked. Please do not edit your code repo, video, or any project materials from the deadline until after the winner announcement, even minor changes could affect your eligibility."
- **Expected result:** one answer.
- **Actual result:** the recorded session and the written update contradict each other.
- **Severity:** Low
- **Workaround used:** follow the written update: tag the submission commit, then make no pushes, tags or edits to the submitted repos, the video or the Devpost page from the deadline until the winners are announced on 2026-12-03. Time: minutes.
- **Actionable suggestion:** add a correction to the Office Hours 2 recording, and an FAQ entry that matches the update.
