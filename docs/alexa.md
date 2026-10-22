# Alexa skill, MCP server and simulator

On Alexa, Spee answers to "speech coach", the skill tested on a real device. `npm run alexa:deploy` also sets up "spee coach" and "spee" as extra development skills, not yet tried on a device ([Skill names](#skill-names)). Three voice surfaces share one hub and one contract ([CONTRACT.md](CONTRACT.md), v2):

- **`POST /alexa`**: the custom skill endpoint for every Spee development skill, whatever name it answers to.
- **`/mcp`**: a stateless Streamable HTTP MCP server, with the tools an Alexa+ model would call.
- **`/sim/`**: a web simulator. It is a real MCP client with a mic and a voice; a keyword router stands in for Alexa+'s model.

All three reach the hub through one loopback client, [`src/mcp/hubClient.ts`](../src/mcp/hubClient.ts) (`ctx.selfUrl()`), so they obey the HTTP contract exactly. Nothing in an `/alexa` or `/mcp` request calls a model. Logs carry intent and tool names, routes, statuses and timings, never what was said.

**Bee is the grader of record.** What Alexa, the browser mic or a typed line hears is a provisional preview (`source: "alexa"` from the skill, `source: "mcp"` from an MCP client such as `/sim/`). The verdict spoken is always Bee's final grade.

## Files

| Path | What it is |
|---|---|
| `src/mcp/hubClient.ts` | Typed loopback HTTP client over the v1 + v2 routes. Never throws: a timeout or unreachable hub comes back as `{ok:false, status:0}` |
| `src/mcp/tools.ts` | The 12 MCP tools (`MCP_TOOLS`), one hub route each, with deterministic narration |
| `src/mcp/plugin.ts` | `createMcpPlugin`: `/mcp` (POST JSON-RPC; GET/DELETE 405; OPTIONS 204 CORS) |
| `src/alexa/verify.ts` | The accepted skill ids (`ALEXA_SKILL_ID`, else [`alexa/skill-id.json`](../alexa/skill-id.json); `ALEXA_SKILL_IDS`; `alexa/skill-ids.local.json`), the 150 s timestamp window, and the progressive-response host allow-list |
| `src/alexa/route.ts` | Intent routing and the catch-all rescue |
| `src/alexa/skill.ts` | `handleAlexa`: a pure handler (hub client, clock, sleep and progressive sender injected) |
| `src/alexa/speech.ts` | Short lines: at most 2 sentences, quoted card sentences kept whole, SSML escaping, spoken fail reasons |
| `src/alexa/apl.ts` | Screens for devices with a display: the APL support check, one builder per screen (its datasource), the RenderDocument directive, and the TV's fail-reason words |
| `alexa/apl/speaking-mirror.json` | The APL document: five screens, the palette as resources, the mark as a vector graphic |
| `scripts/apl-preview.ts` | `npm run alexa:apl:preview -- --png`: an approximate HTML/PNG preview of every screen (out/apl-preview/) |
| `src/alexa/signature.ts` | Request signature verification (on by default for public requests) |
| `src/alexa/device.ts` | The `alexa.device` log: each kind of device's interfaces, APL version and viewport, once |
| `src/alexa/plugin.ts` | `createAlexaPlugin`: `POST /alexa` |
| `alexa/skill-package/` | The one checked-in package: `skill.json` (listed as Spee, endpoint placeholder, `Wildcard` certificate) and the en-CA and en-US interaction models (generic sample values only, never deck sentences) |
| `src/alexa/skillPackage.ts` | The package for each invocation name, generated from `alexa/skill-package/` (only the invocation name, the example phrases and the testing instructions change), and Amazon's invocation name rules |
| `alexa/ask-resources.json`, `alexa/skill-id.json` | ASK CLI layout, and the "speech coach" dev skill's id, stage, profile and locales |
| `alexa/skill-ids.local.json` | Git-ignored. The dev skill for each invocation name, written by `npm run alexa:deploy` and read by the hub |
| `alexa/fixtures/*.json` | Synthetic request envelopes, one per intent (placeholder ids) |
| `scripts/alexa-deploy.ts` | `npm run alexa:deploy`: points one dev skill per invocation name at `PUBLIC_BASE_URL/alexa`, creating the ones that do not exist yet |
| `web/sim/` | The simulator (Vite, `base: "/sim/"`, built to `dist/web/sim`) |
| `scripts/checks/alexa.ts`, `scripts/checks/mcp.ts` | The Alexa and MCP modules of `npm run contract:check` |
| `test/alexa-*.test.ts`, `test/mcp-*.test.ts` | Unit and in-process HTTP tests |

## Skill names

An Alexa custom skill has one invocation name per locale, and a name-free skill launch phrase needs a published skill with usage history, which a development skill does not have. So each name Spee answers to is its own development skill. All of them use this hub's `POST /alexa` and the same interaction model; only the invocation name differs. Every one is listed as "Spee" in en-CA and en-US.

| Invocation name | Skill | Tried on a device |
|---|---|---|
| "speech coach" | the existing skill (`alexa/skill-id.json`, or `ALEXA_SKILL_ID`) | yes: the Alexa app in Canada and the Fire TV |
| "spee coach" | created by `npm run alexa:deploy` | not yet |
| "spee" | created by `npm run alexa:deploy`, best effort | not yet. Alexa allows a one-word name only for a registered brand, so the model build may refuse it, and a short made-up word is easy to mishear |

"speech coach" is the one tested on a real device. Until the others have been tried, the TV and the phone page keep saying "Alexa, ask Speech Coach to quiz me".

**How the deploy sets them up.** `npm run alexa:deploy` takes the names in priority order: "speech coach", "spee coach", "spee" by default, or `--names "speech coach,spee coach"` (or `ALEXA_INVOCATION_NAMES`). Each name's package is generated from the one in `alexa/skill-package/` (`src/alexa/skillPackage.ts`): the same manifest and model, with this invocation name, and the example phrases and testing instructions rewritten to use it. Edit only `alexa/skill-package/`, and the skills cannot drift apart. For each name:

1. "speech coach" (the checked-in model's name) updates the existing skill, and a name already in `alexa/skill-ids.local.json` updates its skill (`ask smapi update-skill-manifest`). Before any change, every real run checks that these skills are still on the account: one the account's list leaves out is read with `ask smapi get-skill-manifest`, and when that answers not found, it is gone. Any other failure of that read (a throttle, a server error, an expired login) is a failed lookup: the deploy cannot tell, so it sets nothing up again (see the end of step 2). A recorded name whose skill is gone is said so and set up again as in step 2, and the new id is saved in place of the old one. If the checked-in skill is gone, or every recorded skill is, the deploy stops before any change: the ASK CLI profile most likely belongs to another developer account, where setting the names up again would save new ids over the real ones. It names each skill it did not find, creates nothing and does not write the local file. Check `ASK_PROFILE`; if the profile is right, fix `alexa/skill-id.json` or set `ALEXA_SKILL_ID`.
2. Any other name: the account is the record of which skills exist, and the local file only a cache of it, so before any change the deploy looks there. `ask smapi get-vendor-list` checks once that the ASK CLI profile has a vendor, `ask smapi list-skills-for-vendor` lists the account's skills (each page), and `ask smapi get-skill-manifest -g development` reads every development skill on the account and each id in `ALEXA_SKILL_IDS`. Every generated manifest's testing instructions end with the deploy's marker, `Set up by npm run alexa:deploy for the invocation name "<name>".`, which names the skill's invocation name, whatever its listing is called now. A skill without it is named by its en-CA model (`ask smapi get-interaction-model`) when it is listed as Spee or is in `ALEXA_SKILL_IDS`; any other skill without it is left alone. A manifest that cannot be read fails the lookup only for a skill listed as Spee or in `ALEXA_SKILL_IDS`. For any other skill (most likely another project's) the deploy prints a warning and goes on; if it is one of Spee's, a run that can read it finds it. A skill already set up for the name is adopted: updated, and its id saved in the local file. Two skills on the account for one name stop the deploy before any change, also when one of them is the recorded one, and it lists them: Alexa could send that name to either, so delete the extra one in the developer console. Only a name with none gets a new development skill: `ask smapi create-skill-for-vendor` creates it under the profile's vendor, and its id goes into `alexa/skill-ids.local.json` (git-ignored) at once. A create that answers without an id stops the deploy (exit status 2, the names after it not run), since the skill may exist; the next run finds it by its marker. The deploy then waits for the manifest (`ask smapi get-skill-status --resource manifest`). A failed lookup skips the names that would be created, and the others go on.
3. Each locale's model (`ask smapi set-interaction-model`), then the builds (`ask smapi get-skill-status`, every 4 s, 180 s cap).
4. Testing on, in the development stage (`ask smapi set-skill-enablement`).

A name that fails any step (a refused name, a failed build, a timeout) is reported and skipped, and the next name goes on. The exit status is 0 when the first name is ready, and 2 when the deploy stopped (the summary says STOPPED): another account's profile (step 1) stops it before any name, and a create that answers without an id (step 2) stops it at that name. If the local file is changed during a run so that it no longer reads, the deploy stops at the next name it saves, with exit status 2: the names after it are not run, the file is not overwritten, and a skill it had just created is adopted by the next run through its marker. A local file that does not parse, has no `skills` object or holds an entry that is not an `amzn1.ask.skill.*` id stops the deploy before any `ask` call, in a dry run too, and the deploy never overwrites it: it is the record of which skill serves each name, so fix it by hand. `npm run alexa:deploy -- --dry-run` runs and writes nothing. It prints the plan, each name marked UPDATE (a recorded skill) or CREATE (none recorded, so a real run first looks on the account and updates the skill it finds there instead), then every command, the account lookups first. When a name would be created and this checkout has no `alexa/skill-ids.local.json`, it warns that the name may have been set up from another checkout. `npm run alexa:deploy -- --status` prints each recorded skill's build status.

**Which skills the hub answers.** `POST /alexa` accepts `ALEXA_SKILL_ID` (else `alexa/skill-id.json`), each id in `ALEXA_SKILL_IDS` (comma-separated), and every skill in `alexa/skill-ids.local.json`. The hub reads that file again when it changes, so a deploy needs no restart. The hub reads only its own checkout's file, so run the deploy in the checkout the hub runs from, or give the hub the ids in `ALEXA_SKILL_IDS`. A deploy run from another checkout still finds the skills it set up on the account, by their marker, and adopts them instead of making a second skill for a name, as long as it can read the account and the marker is still in their testing instructions; it records them in its own checkout's file. Any other id is refused as before (`400 alexa_rejected`, "wrong skill id"), and an entry that is not an `amzn1.ask.skill.*` id is skipped and named in the `alexa.skill-ids` log line. A local file that does not parse, or has no `skills` object, has every skill in it refused, and `/api/health` then shows the Alexa plugin as `degraded`, with a note that the file could not be read. The first request through each skill logs `alexa.skill {name}`, so the hub log shows which names were heard on a device. No log line carries a skill id.

## Alexa intents

The skill keeps two session attributes: `cardId` (the open card) and `attemptId` (turn 1's attempt, until its verdict is final). No transcript text goes into attributes.

| Intent | Hub route(s) | Says (examples) | Session |
|---|---|---|---|
| `LaunchRequest` | `POST /api/session/start {by:"alexa"}` | `Spee. Say this: "<card>"`, whatever name opened the skill (every one is listed as Spee); with nothing due: "No cards are due right now..." | open |
| `StartDrillIntent` ("quiz me") | `POST /api/session/start` | `Here's your first card. Say: "<card>"` | open |
| `AttemptIntent` (catch-all `{attempt}`) | `POST /api/attempt {source:"alexa", text}` (202 at once) | "Got it, checking with Bee. Ask me how you did in about 15 seconds." | open, `attemptId` kept |
| `HowDidIDoIntent` | `GET /api/attempts/<id>`. If not ready: a progressive response ("Checking with Bee.") and polling every 600 ms for at most 6.5 s. Pass: then `POST /api/session/next` | pass: `Bee heard it: a pass. Next, say: "<card>"`; fail: `Not yet: Bee heard a filler, "um". Say it again: "<card>"`; not confirmed: "Bee didn't confirm that one, so it doesn't count..."; still waiting: "Bee hasn't sent that line yet. Ask me again in a few seconds." | open (ends when the drill is done) |
| `HowAmIDoingIntent` | `GET /api/coach/now` | the `narration` (up to 4 sentences, the contract's `CoachNow` limit) | one-shot ends, else open |
| `LiveCoachOnIntent` (`{minutes}` optional), `LiveCoachOffIntent` | `POST /api/live/mode {enabled, minutes?, by:"alexa"}` | the `narration` | one-shot ends, else open |
| `DidItTransferIntent` | `GET /api/transfer` | the `headline` (2 sentences at most) | one-shot ends, else open |
| `AMAZON.NextIntent` | `POST /api/session/next` | `Next, say: "<card>"`, or the drill summary | open; ends when done |
| `AMAZON.StopIntent`, `AMAZON.CancelIntent`, `AMAZON.NavigateHomeIntent` | `GET /api/session`, then `POST /api/session/end` if one is running | `That's the round: 2 of 3 lines passed, checked by Bee (1 not yet). Bye.` Each line counts once, in the TV's Round over words, as `end_drill` says it: a line missed and then passed on a retry is one line passed. A round with no line Bee checked: `Bee didn't check any line this round (1 Bee didn't catch). Bye.`; one whose line is still with Bee: `Bee is still checking 1 line. Bye.` | ends |
| `AMAZON.HelpIntent` | none | how to use it | open |
| `AMAZON.FallbackIntent` | none | asks for the sentence again, or how to start | open |
| `SessionEndedRequest` | `GET /api/session`, then `POST /api/session/end` only for the drill this skill session started (its id rides in the session attributes) | (empty response) | |
| `Alexa.Presentation.APL.RuntimeError` (a screen failed on the device), `System.ExceptionEncountered` (Alexa could not use the last response) | none; logged as `alexa.no-answer {type, token, errors}` with the error kinds only, never a message | (empty response: Alexa allows no speech here) | as it was |

**Catch-all rescue** (`route.ts`). The model's catch-all slot also swallows commands; on a real device (2026-10-16) "how did I do" arrived as `AttemptIntent`. Whole-utterance rules move it back:

- "how did I do", "how am I doing", "next", "stop", "turn on/off live coaching [for N minutes]", "did it transfer", "quiz me" and "help";
- a drill sentence that merely contains such a word ("The next release ships Friday.") stays an attempt;
- a sentence with "how did I do" run on in one breath is graded without the tail, and the verdict comes on the next turn.

**Timing.** A drill line can take up to about 20 s, because Bee may merge it with your next words, and Alexa must answer within 8 s, so the verdict comes on the next turn. Bee tags a line about 5 s after you stop speaking (median 5.4 s, 4.3 to 14.7 s, measured on 2026-10-16), so a wrist nudge lands about 20 s after the line that triggered it. The attempt turn answers at once (contract check: 3 to 5 ms). An early "how did I do?" is answered within 6.5 s plus one hub call (tests: under 7 s on a fake clock; contract check: about 0.6 s with the demo replay).

**Progressive response.** Sent as `VoicePlayer.Speak` to `{apiEndpoint}/v1/directives`, and only to `https://api[.eu|.fe].amazonalexa.com`. A forged request cannot point the hub at another host.

**Request checks.** `400 alexa_rejected` when the application id is not one of Spee's skills ([Skill names](#skill-names)), or when the timestamp is more than 150 s off the hub's wall clock (the real clock, not the demo clock).

**Signature verification (on by default).** Every public request (through the tunnel) must carry Amazon's signature:

1. the `SignatureCertChainUrl` rules;
2. the chain to a trusted root, with the leaf for `echo-api.amazon.com`, valid now;
3. RSA-SHA256 of the raw body.

Loopback and LAN requests (tests, the contract check, the simulator on this machine) are never signature-checked. `ALEXA_VERIFY_SIGNATURE=0` turns the check off for public requests too; use that only for a local fixture run, never with a tunnel up. The hub logs `alexa.signature-off` at startup when it is off. The check is tested with a throwaway CA. It has not yet run against Amazon's live chain: if the first real request fails, the `alexa.rejected` log line gives the reason. A failed chain download is cached for 60 s, and at most 8 chains are kept.

## Screens (APL)

On a device with a screen (Fire TV, Echo Show), Alexa shows its own card with just the skill's name while the skill speaks and listens, unless the skill sends a document. So every turn that has something to show also sends an `Alexa.Presentation.APL.RenderDocument` directive with a Spee screen. The speech, the reprompts, the hub calls and the two-turn timing do not change. Amazon's guidance for screen devices is followed throughout ([APL for screen devices](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-for-screen-devices.html), [Configure your skill with the APL interface](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-support-for-your-skill.html), [Select the viewport profiles](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-select-the-viewport-profiles-your-skill-supports.html), [RenderDocument](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-interface.html)).

- **Only for screens.** The manifest declares `ALEXA_PRESENTATION_APL` in `apis.custom.interfaces`. The directive goes out only when the request's `context.System.device.supportedInterfaces` lists `Alexa.Presentation.APL`. A voice-only device, or one with only a character display (`Alexa.Presentation.APLT`, an Echo Dot with clock), gets exactly the response it got before.
- **One document, five screens.** `alexa/apl/speaking-mirror.json` (APL `2023.2`) is sent inline (`document.type: "APL"`). `payload.screen.kind` picks the screen, and the directive's token names it (`speakingMirror.<kind>`):

  | Screen | When | What it shows (datasource `payload.screen`) |
  |---|---|---|
  | `drill` | Launch, "quiz me", next; the open line again after an attempt the hub refused, or a "how did I do?" for an attempt it no longer has (with no line open, those show `empty`) | "Say this:" (or "Next, say:") and the line on the paper card (`kicker`, `sentence`); the tracker on step 1 (`steps`: You said it, Checked by Bee, Result, the same words as the TV's Live tracker); "Then ask: how did I do?" (`hint`) |
  | `checking` | after the attempt, and an early "how did I do?" | the same layout; the tracker on step 2; "Bee is checking…" (`status`). The open line comes from `GET /api/session` (one more loopback call, made only for a screen) |
  | `verdict` | Bee's verdict | "Passed." in lime, "Not yet." in coral, or "Not counted." (`headline`, `tone`); the reason in the TV's own words (`reason`: `plainReason(gradeFailure(grade))`, the same as the TV's practice screen); the "Checked by Bee" tag (`checked`, `tag`); the next line or the same line again (`kicker`, `sentence`), or what to do (`hint`) |
  | `progress` | "how am I doing" | one number (`hero`: the week's top habit per 100 words, else the lines due, else the week's words) with its caption (`heroCaption`), the first sentence of the coach narration (`line`), and "Open Spee on this TV for details" (`footerTv`; on a hub, `footerHub`: "...on your TV...") |
  | `empty` | caught up, no line, not practising, nothing to check, the round's end, live coaching on or off, the transfer headline, help with no line open, the hub away | `headline`, `line`, `hint` |

  Every field is present on every screen (empty when unused), so each binding resolves. Help and fallback with a line open send no document, so the line's screen stays up. Stop sends none. A turn that checked nothing never leaves "Bee is checking…" up.
- **Masked for the screen.** The builders put every string a person reads through `maskDeep(..., "screen")`, so a private term shows as `▒▒▒`. The Alexa plugin then masks only what Alexa speaks (`outputSpeech` and the reprompt) for speech, and the document goes out as it is: its expressions and resource names (`@lime`, `@coral`) are not words, and masking them would break the screen.
- **Colours and type.** The palette is the TV's (`tv/web/src/theme.ts`; a test keeps them equal), defined once as document resources. `@colorBee` is the only colour for "checked by Bee": the tag, the "Bee is checking…" line, the tracker's Bee step and the mark's reflection. Change it there to recolour Bee everywhere. The datasource carries words and states, never colours.
- **The mark.** "Two voices", as on the TV, the phone and the hub pages: your speech bubble and its reflection across a mirror bar, the reflection sitting lower. An AVG `VectorGraphic` of the approved large master (paths only; the fills are `@lime` and `@colorBee`), drawn at 48 dp or more; smaller sizes need the small master.
- **Viewports.** Declared: TV fullscreen (`tvLandscapeXLarge`, 960x540 dp, which is a 1920x1080 Fire TV) and the landscape hubs small (Echo Show 5, 960x480), medium (960x600) and large (Echo Show 8 and 10, 1280x800). Sizes come from dimension resources chosen by `viewport.height`. Round and portrait hubs and the extra-large hub are not declared, so Alexa scales and letterboxes the nearest declared layout there. The TV layout keeps a 5% inset for overscan, and its smallest type is 18 dp (36 px at 1080p).
- **Which devices can show it.** The first request from each kind of device that passes the request checks logs one line, `alexa.device {interfaces, apl, viewport}`: the names under `supportedInterfaces`, the APL `runtime.maxVersion` (null when the device has no APL) and the viewport (for example `TV 1920x1080 RECTANGLE`). It never carries the device id, the user id or what was said (`src/alexa/device.ts`, `test/alexa-device.test.ts`). It shows whether the Fire TV and the Alexa iPhone app really reported APL (Fire TV's latest APL version is 2024.2).
- **Leaving quickly.** A response that ends the session (a one-shot "how am I doing", the round's end) sets `settings.idleTimeout` to 6 s, so the TV goes back to what it was showing. In an open session the device keeps the screen while it listens, as it did with the plain card. This has not yet been checked on the real Fire TV.
- **Preview.** `npm run alexa:apl:preview -- --png` writes an approximate HTML render and a headless-Chrome PNG of each screen for Fire TV 1080p, Echo Show 8 and Echo Show 5 to `out/apl-preview/` (gitignored). It is a small interpreter for the parts of APL this document uses, labelled "APPROXIMATE PREVIEW" on every image; fonts and line breaks differ from a device. For a device-accurate look, paste the document and a datasource from the preview into the developer console's APL authoring tool.
- **Tests.** `test/alexa-apl.test.ts`: the manifest declares the interface; the directive appears only for an APL device (not voice-only, not APLT); each screen's datasource; masking; the document's shape (type, version, `mainTemplate` taking `payload`, every `payload.screen.*` and `data.*` binding present, every `@resource` and component defined, no colour literal outside the palette, the mark's shape and its size of 48 dp or more); the reason words equal the TV's for every rule; and a full drill against the demo hub, also over HTTP.
- **Deploying.** The manifest change reaches the dev skill with the usual `npm run alexa:deploy` (step 4 of the real-device run below). The document is sent in each response, so nothing else needs uploading.

## MCP tools

Each result is `content: [{type:"text", text: <narration>}]` plus `structuredContent` (the route's JSON). A route answering 400 or more, or an unreachable hub, gives `isError: true` with the route's `{error, message}` as `structuredContent`. Invalid arguments are refused by the zod input schema before any hub call.

| Tool | Args | Route | Narration |
|---|---|---|---|
| `start_drill` | `size?` 1-10 | `POST /api/session/start {by:"mcp"}` | route `narration` (`Say this: "..."`) |
| `submit_attempt` | `text`, `card_id?` | `POST /api/attempt {source:"mcp"}` | route `narration` ("Got it. I'm checking with Bee...") |
| `get_verdict` | `attempt_id` | `GET /api/attempts/<id>` | route `narration` |
| `drill_status` | | `GET /api/session` | route `narration` |
| `next_card` | | `POST /api/session/next` | route `narration`, or the summary when done |
| `end_drill` | | `POST /api/session/end` | "Practice done: 1 of 3 lines passed, checked by Bee (1 not yet, 1 not tried).", each line once (the summary's `lines`), in the TV's Round over words (`src/hub/roundWords.ts`): the lines not yet passed, Bee didn't catch, still with Bee or not tried. A round with no line Bee checked says so instead of "checked by Bee": "Practice done: Bee didn't check any line this round (1 not tried).", or, while a line is still with Bee, "Practice done: Bee is still checking 1 line (1 not tried)." An older hub sends no `lines`, so the counts in brackets are tries and say so, as the TV's tally does: "(3 tries: 1 passed, 2 not yet)". |
| `how_am_i_doing` | | `GET /api/coach/now` | route `narration` |
| `habit_stats` | `range?`, `source?` | `GET /api/stats` (`range` defaults to `week`) | rates per 100 words |
| `did_it_transfer` | `habit?` | `GET /api/transfer` | `headline`, or one habit's verdict |
| `pre_meeting_brief` | | `GET /api/brief` | `nudge` |
| `live_coach` | `enabled`, `minutes?` 1-180 | `POST /api/live/mode {by:"mcp"}` | route `narration` |
| `last_recap` | | `GET /api/recaps?limit=1` | the recap's `narration` |

The server's `instructions` tell the model the two-turn rule: never wait for Bee inside a turn, and never present the provisional grade as the result.

## Simulator (`/sim/`)

- **Build and serve.** Build it with `npm run web:sim:build` (or `npm run web:build`); the hub serves it at `/sim/`.
- **MCP client.** It uses the MCP SDK `Client` over `StreamableHTTPClientTransport` to `/mcp`, with the header `ngrok-skip-browser-warning: 1`.
- **Token.** It reads `#t=<MCP_TOKEN>` from the fragment, which is never sent to a server. It keeps the token in `sessionStorage` and removes it from the address bar. On this machine (or on the LAN with `npm run hub -- --lan`) it needs no token; elsewhere it prompts when the fragment is missing. The hub never prints the MCP token in full: a generated one shows only its last 4 characters and is saved in `tokens.json` in the hub's state directory, so export your own `MCP_TOKEN` (step 1 of the real-device run below) to know it.
- **Voice.** The mic uses Web Speech (Chrome, Edge, Safari) and the replies use `speechSynthesis`. A text box and quick buttons work everywhere.
- **Router.** `router.ts` is the keyword router, labelled on screen as the stand-in for Alexa+'s model. `dialog.ts` runs the same two-turn drill as the skill: an attempt, "checking with Bee", "how did I do?", the verdict, then the next card on a pass. A card someone else opened (the TV, the phone, `POST /api/card/open`) is picked up through `drill_status`: on connect and on the hub's card events it shows under "Say this", and a sentence said with no card known asks the hub first, so it becomes an attempt on that card (`submit_attempt`), never a new drill.
- **Panels.** The JSON-RPC log shows every request and response. The hub SSE feed (`/api/events`) works only when the page is opened on this machine (or on the LAN with `--lan`); through the tunnel the gate allows `/mcp` alone. The feed shows statuses and scores, never Bee's text.

## Real-device run (operator)

These steps were prepared and not run here: they need the operator's tunnel. The tunnel exposes only what the gate allows: `POST /alexa`, `/p/*`, `/sim/*`, `/mcp` with the bearer token, and `/ws` with the pair token.

1. **Tokens** (so they survive restarts), in the shell that will run the hub:
   ```bash
   export MCP_TOKEN=$(openssl rand -hex 24)
   export PAIR_TOKEN=$(openssl rand -hex 24)
   ```
2. **Tunnel** (terminal 1):
   ```bash
   ngrok http 8791
   ```
   Copy the `https://<id>.ngrok-free.app` origin.
3. **Hub** (terminal 2, in this repo):
   ```bash
   export PUBLIC_BASE_URL=https://<id>.ngrok-free.app
   npm run web:build
   npm run hub
   ```
   Use `npm run hub` for live Bee, or `npm run hub -- --demo` for a rehearsal. In demo mode the Bee replay answers, not your Watch.
4. **Deploy the skills** (terminal 3, in the same checkout as the hub):
   ```bash
   PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy
   ```
   It updates the existing "speech coach" dev skill (`amzn1.ask.skill.<your-skill-id>...`, ASK profile `default`), creates the "spee coach" and "spee" skills on the first run (their ids go to `alexa/skill-ids.local.json`), waits for both locales of each to report `SUCCEEDED`, and turns testing on. A name that fails is reported and skipped ([Skill names](#skill-names)). To preview the plan and the commands only, run `npm run alexa:deploy -- --dry-run`; to check the build status, `npm run alexa:deploy -- --status`. If a new skill is not found on the device, open it in the developer console and set the Test tab to Development.
5. **Reachability:**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<id>.ngrok-free.app/alexa -d '{}'
   ```
   Expect `400` (`alexa_rejected`): the gate let it through and the skill refused it.
6. **iPhone Alexa app** (signed in to the developer account, English (Canada) or (US)), wearing the Watch with Bee:
   1. "Alexa, open speech coach." It reads the first card.
   2. Say the card sentence. It answers "Got it, checking with Bee. Ask me how you did in about 15 seconds."
   3. Wait about 15 s, then say "how did I do?".
      - If Bee is still on its way, you hear "Checking with Bee." and then the verdict within about 6 s.
      - Otherwise you hear "Bee hasn't sent that line yet"; ask again.
   4. On a pass, it reads the next card. On a fail, it names the rule ("Not yet: you still said "I guess"") and asks again.
   5. "Stop." It reads the drill summary.
   6. "Alexa, ask speech coach how am I doing."
   7. "Alexa, ask speech coach to turn on live coaching for 30 minutes", then later "...to turn off live coaching".
   8. The other names, for each one the deploy reported ready: "Alexa, ask spee coach to quiz me", then "Alexa, ask spee to quiz me". The hub log shows `alexa.skill` with the name for each one Alexa sent; a name Alexa mishears goes elsewhere and logs nothing.
7. **Simulator.** Open `https://<id>.ngrok-free.app/sim/#t=<MCP_TOKEN>` on a phone or laptop. ngrok's free tier may show its browser warning page once; choose "Visit Site". Run the same drill with "quiz me", the sentence, then "how did I do?". On this machine, `http://127.0.0.1:8791/sim/` also shows the hub event feed; while `PUBLIC_BASE_URL` is set it needs `#t=<MCP_TOKEN>` too (a TCP tunnel would look local, so `/mcp` and `/alexa` authenticate every request while a tunnel is declared).
8. **Which surfaces rendered.** Copy each `alexa.device` line from the hub log (one per kind of device) into the dated device table. A device whose line shows `apl: null` got speech only.
9. **Signature check.** It is on for step 6. If Alexa answers "There was a problem with the requested skill's response", read the hub log line `alexa.rejected` for the reason. Do not turn the check off while the tunnel is up.

## Known limits

- **The extra names** ("spee coach", "spee") have not been tried on a device. "spee" is one word, which Alexa allows only for a registered brand, so its build may fail; if it builds, Alexa may still mishear it.
- **Signature verification** is on by default for public requests (see above), but it has not yet been run against Amazon's live certificate chain. With `ALEXA_VERIFY_SIGNATURE=0`, anyone who knows both the tunnel URL and the skill id could drive the skill and hear card sentences.
- **Progressive responses** depend on Alexa's `apiAccessToken` and have not been exercised on a device yet. The real-device spike proved the two-turn flow without them.
- **`end_drill` and Stop** report the last session's summary when no session is running. The MCP tool maps 1:1 to `POST /api/session/end`, which returns it; Alexa checks `GET /api/session` first and just says "Bye."
- **Speech recognition in the simulator** is the browser's own and is provisional, exactly like Alexa's transcript.

## Open notes on the contract docs

1. **`docs/CONTRACT.md`, the v1 "Phase 3: Alexa+ MCP server" tool table.** It still lists `how_did_i_do(range) -> GET /api/stats` and omits the v2 tools. `MCP_TOOLS` names it `habit_stats` and adds `how_am_i_doing`, `live_coach` and `last_recap`; the v2 MCP section is the current list.
2. **`docs/CONTRACT.md`, the Alexa intent table.** Two behaviours are not written down there yet:
   - Stop and Cancel read `GET /api/session` before `POST /api/session/end`.
   - HowDidIDo on a pass also calls `POST /api/session/next`.
3. **`scripts/contract-check.ts`, module order.** The alexa module drills the last due demo cards, and the mcp module then needs one. The alexa module leaves one card due on purpose by letting Bee fail it, and both modules fall back to a practice card when nothing is due. A `POST /api/demo/reset` (demo only), or a few more due cards in the demo deck, would remove that coupling.
