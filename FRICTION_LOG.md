# Friction log: Bee speech coach

This log is part of the Amazon "Build, Ship, Shape" hackathon submission, for the friction-log bonus. Each entry is written when the friction happens: exact symptoms, steps and the workaround, with times in EDT.

**Severity:** Blocker (no workaround) · High (workaround cost more than 1 h) · Medium (workaround under 1 h) · Low (cosmetic or a docs nit).

**Setup:** operator in Toronto, Canada; Canadian Apple ID and App Store; Apple Watch SE 3 (GPS, 40 mm) + iPhone; Bee app 1.2.157; `@beeai/cli` 0.8.0; no Bee hardware (it ships to the US only).

---

### FL-1: The Bee Watch app freezes on a static screen and "tap to start" stops responding after the Watch disconnects from the iPhone (Bee Apple Watch app)
- **Date:** 2026-10-15 ~14:00–14:20 EDT
- **Task attempted:** record a scripted French voice note on the Apple Watch for a transcription test.
- **Steps taken:**
  1. Opened Bee on the Apple Watch.
  2. Tapped "tap to start". Nothing happened, and the Bee screen stayed static (frozen).
  3. The Watch showed it was disconnected from the iPhone.
- **Expected result:** recording starts. If the iPhone link is down, the app should say so, or record locally and sync later.
- **Actual result:** a frozen Bee screen with no error, no "phone disconnected" message, and no way to start recording.
- **Severity:** Medium
- **Workaround used (~20 min):**
  1. Force-quit the Bee app on the Watch (double-click the Digital Crown, swipe left on Bee, tap ✕).
  2. Opened the Bee app on the iPhone and kept it in the foreground for a moment.
  3. Reopened Bee on the Watch, which recovered.
  - Restarting the devices was not needed.
- **Actionable suggestion:**
  - (a) When the iPhone link is unavailable, show an explicit "Reconnect to iPhone / open Bee on iPhone" state instead of a frozen screen.
  - (b) Let the Watch buffer a voice note locally and sync it when the link returns.
  - (c) Document in the Developer Mode / Apple Watch docs that the iPhone app must be running for the Watch app to start.

### FL-2: Developer Mode silently needs a paired device, and the official FAQ said otherwise (Bee docs / hackathon FAQ)
- **Date:** 2026-10-12 to 2026-10-15 (research and first-hand setup)
- **Task attempted:** enable Developer Mode so the Bee CLI can connect, from Canada, without Bee hardware.
- **Steps taken:**
  1. Installed the Bee iOS app (Canadian App Store).
  2. With no Watch paired, the app showed only "Set up a Bee device" / "Try with Apple Watch". There was no Settings → Version row to tap ×5.
  3. The hackathon FAQ and Discord had said no device was needed. The organizer later corrected this on the forum: "enabling developer mode DOES require pairing either an Apple Watch or Bee device."
  4. Bought an Apple Watch, paired it in Bee, then Settings → Version ×5, `bee login`, `bee status`. Verified 2026-10-15 ~11:20 EDT.
- **Expected result:** the docs (docs.bee.computer/docs/developer-mode) state that a paired device is a prerequisite.
- **Actual result:** the docs list only "update app → Settings → tap Version 5 times". The prerequisite is undocumented, and the FAQ contradicted it.
- **Severity:** High (it required buying hardware, after about 3 days of uncertainty)
- **Workaround used:** an Apple Watch SE 3. The full path works from Canada; this is the first first-hand non-US Watch-only report we know of.
- **Actionable suggestion:** add "Requires a paired Bee device or Apple Watch" to the Developer Mode doc. Confirm explicitly that the Watch path works outside the US.

### FL-3: The wearer's speaker label is present on Watch conversations, contradicting the community report that every speaker is "Unknown" (Bee API / docs)
- **Date:** 2026-10-15 ~12:00 EDT
- **Task attempted:** separate the wearer's own speech from others' in conversations.
- **Observed:** utterances carry `speaker: "Kaung Zin"` / `"Kaung"` for the wearer and `"Unknown"` for others. This contradicts bee-cli issue 19 (15,578 of 15,578 utterances "Unknown").
  - The label can be absent while a conversation is still `CAPTURING` (11292222 at first). But conversation 11300596 had wearer labels during `CAPTURING`, so timing is inconsistent.
  - The name form varies within one account ("Kaung" vs "Kaung Zin").
  - Some audio from a French voice assistant was labelled as the wearer.
- **Severity:** Low (positive surprise, but undocumented)
- **Actionable suggestion:** document `speaker` semantics: when the wearer label appears, its format (consider a stable `is_wearer: true` flag instead of a display name), that it's absent during CAPTURING, and its known false positives from media and assistant audio.

### FL-4: The "Action Button → Hold and Speak → Voice Notes" setting does nothing on Apple Watch models without an Action Button; there's no documented way to record a voice note from a Watch (Bee Apple Watch app / docs)
- **Date:** 2026-10-15 ~14:30 EDT
- **Task attempted:** record a Bee *voice note* (an API "journal", the wearer-only channel) from an Apple Watch SE 3.
- **Steps taken:**
  1. In the Bee iPhone app: Settings → Action Button → Hold and Speak → **Voice Notes**.
  2. On the Watch, pressed and held the Bee screen and spoke.
  3. `bee journals list --json` returned `{"journals": []}`. The recording appeared instead as a **conversation** (`bee conversations list`, id 11300596).
- **Expected result:** a voice note (journal) is created, or the setting says it applies only to Bee hardware or an Apple Watch Ultra's Action Button.
- **Actual result:** the setting silently has no effect. The SE 3 has only the Digital Crown and the side button, with no Action Button. No voice-note entry point was found in the Watch app.
- **Severity:** Medium
- **Workaround used:** use conversation recordings. The wearer's speaker label (FL-3) makes them usable for wearer-only analysis.
- **Actionable suggestion:** state which hardware the Action Button setting applies to. Add a voice-note entry point to the Watch app (e.g. a tap target or a complication). Document how journals are created per device.

### FL-5: French speech recorded from a Watch is partly transcribed or translated into English on an account whose primary language is English (Bee transcription)
- **Date:** 2026-10-15 14:23 EDT (conversation 11300596)
- **Task attempted:** a transcription test. A 109-word scripted French text with 10 planted learner errors and 4 fillers was read aloud and recorded on the Watch.
- **Expected result:** a French transcript, with the learner errors kept verbatim.
- **Actual result:** several French phrases came back as **English**:
  - "la problème…" → "The problem is…"
  - "c'est un difficile exercice" → "and it's a difficult exercise"
  - "j'habite en Toronto" → "and I be in Toronto"
  - Others were garbled ("Hier soir, j'ai allé à mon cours de français" → "Yers monde de France").
  - Of the planted errors: 3/10 kept verbatim, 1 auto-corrected, 6 garbled or translated. Fillers ("euh" ×3, "ben" ×1): 0/4 kept.
  - By contrast, a natural French conversation earlier the same day kept learner errors ("cette groupe").
- **Severity:** High (for any language-learning use case)
- **Retests (same conversation 11300596):**

  | Reading | Setting | Planted errors kept verbatim | Fillers kept |
  |---|---|---|---|
  | 1 (14:23) | English primary | 3/10 | 0/4 |
  | 2 (~14:31) | French primary, set mid-conversation | 4/10 | 0/4 |
  | 3 (14:40) | French primary | 2/10 | 0/4 ("ben" → "Bon") |

  Reading 3 still produced English: "and I'm in Toronto", "Yes soir she allowed my courses", "and exit for my project examens".
  - **Confound:** all three readings were appended to a conversation that *started* under the English setting (see FL-6).
- **Workaround used:** none found for scripted reading. The decisive test is the 18:00 class, as a fresh conversation under French. Fallback: English coaching plus French "comment on dit…?" vocabulary moments.
- **Actionable suggestion:** support per-recording language selection or automatic language ID with code-switching, rather than one account-level primary language. Never translate. Expose a `language` field per utterance in the API.

### FL-6: "Stopping" a Watch recording doesn't end the conversation; later recordings are appended to it and their `start`/`end` offsets restart at 0 (Bee API)
- **Date:** 2026-10-15 14:23–14:41 EDT (conversation 11300596)
- **Task attempted:** record three separate test readings as separate conversations.
- **Steps taken:** start a recording on the Watch, then stop. Repeat twice more, minutes apart, including after changing the primary language.
- **Expected result:** one conversation per recording, or at least monotonic offsets.
- **Actual result:**
  - All three readings were appended to the same `CAPTURING` conversation.
  - Inside it, the third reading's utterances restart at `start: 36` (after earlier lines at `start: 380`), so sorting by `start` interleaves recordings. Only `spoken_at` (epoch ms) is monotonic.
  - Recordings also appeared in the iPhone app before the API returned them (a few minutes' lag).
  - We first mis-read the transcript because of this.
- **Severity:** Medium (it silently scrambles transcripts for any client that orders by offset)
- **Workaround used:** order utterances by `spoken_at` and rebuild a single timeline relative to the conversation start (`src/real/corpus.ts`). A regression test is in `test/real.test.ts`.
- **Actionable suggestion:**
  - Document that conversations are server-segmented and can absorb later recordings.
  - Make offsets monotonic within a conversation, or expose a recording/segment id per utterance.
  - Let the client force-close a conversation.

### FL-7: The only voice-note path found on an Apple Watch SE 3 goes through Siri (Digital Crown hold), and it captures the Siri request as a Bee journal (Bee Watch app)
- **Date:** 2026-10-15 ~14:32 EDT
- **Steps taken:** held the Digital Crown on the SE 3 and spoke ("Hello, how can I get help with this Bee app?").
- **Actual result:** Siri opened, and a Bee journal (voice note) was created with that text (state READY). No in-app voice-note control was found on the Watch (see FL-4).
- **Expected result:** a Bee-native voice-note button on the Watch, independent of Siri.
- **Severity:** Medium
- **Workaround used:** none needed. Conversation recordings with wearer labels serve the same purpose.
- **Actionable suggestion:** add a voice-note control to the Bee Watch app. Document the Siri/App Intents path if it's intended.

### FL-8: The live stream (`bee stream`) carries timestamps and a speaker-identification event that the realtime docs don't describe (Bee docs / API)
- **Date:** 2026-10-16 14:35–14:40 EDT
- **Task attempted:** measure whether Bee's live feed is fast enough to grade a spoken drill card on a TV.
- **Steps taken:** ran `bee stream --types all --json` with local receive timestamps; recorded about a minute of speech on the Watch.
- **Expected result (per docs.bee.computer/docs/realtime):** `new-utterance` = `{utterance:{text,speaker}, conversation_uuid}`, with no timestamps.
- **Actual result:**
  - `new-utterance` also includes `id`, `sample_id`, `start`, `end` and `spoken_at`.
  - An undocumented `tagged-utterance` event (`utterance_id`, `person_id`, `person_first_name`, `speaker_score`) arrives about 0.5 s later and identifies the wearer live (8/9 utterances; scores 0.64–0.86). The first utterance of the recording was never tagged.
  - Delay from end of speech to `new-utterance`: 4.3–14.7 s (median 5.4 s).
- **Severity:** Low (positive surprise, but undocumented)
- **Workaround used:** none needed. We read the extra fields defensively and poll the conversation as a fallback, because the stream is at-most-once.
- **Actionable suggestion:** document the `tagged-utterance` event and the timestamp fields, with the meaning of `speaker_score` and when a tag may never arrive. Publish typical latency.
