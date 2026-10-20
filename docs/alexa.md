# Alexa skill, MCP server and simulator (packet C)

Three voice surfaces share one hub and one contract ([CONTRACT.md](CONTRACT.md), v2):

- **`POST /alexa`**: the custom skill endpoint for the development skill "speech coach".
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
| `src/alexa/verify.ts` | Skill id (`ALEXA_SKILL_ID`, else [`alexa/skill-id.json`](../alexa/skill-id.json)), the 150 s timestamp window, and the progressive-response host allow-list |
| `src/alexa/route.ts` | Intent routing and the catch-all rescue |
| `src/alexa/skill.ts` | `handleAlexa`: a pure handler (hub client, clock, sleep and progressive sender injected) |
| `src/alexa/speech.ts` | Short lines: at most 2 sentences, quoted card sentences kept whole, SSML escaping, spoken fail reasons |
| `src/alexa/signature.ts` | Request signature verification (stretch; opt-in) |
| `src/alexa/plugin.ts` | `createAlexaPlugin`: `POST /alexa` |
| `alexa/skill-package/` | `skill.json` (endpoint placeholder, `Wildcard` certificate) and the en-CA and en-US interaction models (generic sample values only, never deck sentences) |
| `alexa/ask-resources.json`, `alexa/skill-id.json` | ASK CLI layout, and the existing dev skill's id, stage, profile and locales |
| `alexa/fixtures/*.json` | Synthetic request envelopes, one per intent (placeholder ids) |
| `scripts/alexa-deploy.ts` | `npm run alexa:deploy`: points the existing dev skill at `PUBLIC_BASE_URL/alexa` |
| `web/sim/` | The simulator (Vite, `base: "/sim/"`, built to `dist/web/sim`) |
| `scripts/checks/alexa.ts`, `scripts/checks/mcp.ts` | The packet's `npm run contract:check` modules |
| `test/alexa-*.test.ts`, `test/mcp-*.test.ts` | Unit and in-process HTTP tests |

## Alexa intents

The skill keeps two session attributes: `cardId` (the open card) and `attemptId` (turn 1's attempt, until its verdict is final). No transcript text goes into attributes.

| Intent | Hub route(s) | Says (examples) | Session |
|---|---|---|---|
| `LaunchRequest` | `POST /api/session/start {by:"alexa"}` | `Speech coach. Say this: "<card>"`; with nothing due: "No cards are due right now..." | open |
| `StartDrillIntent` ("quiz me") | `POST /api/session/start` | `Here's your first card. Say: "<card>"` | open |
| `AttemptIntent` (catch-all `{attempt}`) | `POST /api/attempt {source:"alexa", text}` (202 at once) | "Got it, checking with Bee. Ask me how you did in about 15 seconds." | open, `attemptId` kept |
| `HowDidIDoIntent` | `GET /api/attempts/<id>`. If not ready: a progressive response ("Checking with Bee.") and polling every 600 ms for at most 6.5 s. Pass: then `POST /api/session/next` | pass: `Bee heard it: a pass. Next, say: "<card>"`; fail: `Not yet: Bee heard a filler, "um". Say it again: "<card>"`; not confirmed: "Bee didn't confirm that one, so it doesn't count..."; still waiting: "Bee hasn't sent that line yet. Ask me again in a few seconds." | open (ends when the drill is done) |
| `HowAmIDoingIntent` | `GET /api/coach/now` | the `narration` (up to 4 sentences, the contract's `CoachNow` limit) | one-shot ends, else open |
| `LiveCoachOnIntent` (`{minutes}` optional), `LiveCoachOffIntent` | `POST /api/live/mode {enabled, minutes?, by:"alexa"}` | the `narration` | one-shot ends, else open |
| `DidItTransferIntent` | `GET /api/transfer` | the `headline` (2 sentences at most) | one-shot ends, else open |
| `AMAZON.NextIntent` | `POST /api/session/next` | `Next, say: "<card>"`, or the drill summary | open; ends when done |
| `AMAZON.StopIntent`, `AMAZON.CancelIntent`, `AMAZON.NavigateHomeIntent` | `GET /api/session`, then `POST /api/session/end` if one is running | `That's the drill: 2 of 3 Bee-graded attempts passed. Bye.` | ends |
| `AMAZON.HelpIntent` | none | how to use it | open |
| `AMAZON.FallbackIntent` | none | asks for the sentence again, or how to start | open |
| `SessionEndedRequest` | `GET /api/session`, then `POST /api/session/end` only for the drill this skill session started (its id rides in the session attributes) | (empty response) | |

**Catch-all rescue** (`route.ts`). The model's catch-all slot also swallows commands; on a real device (2026-10-16) "how did I do" arrived as `AttemptIntent`. Whole-utterance rules move it back:

- "how did I do", "how am I doing", "next", "stop", "turn on/off live coaching [for N minutes]", "did it transfer", "quiz me" and "help";
- a drill sentence that merely contains such a word ("The next release ships Friday.") stays an attempt;
- a sentence with "how did I do" run on in one breath is graded without the tail, and the verdict comes on the next turn.

**Timing.** The real-device spike measured Bee's wearer-tagged line at 15 to 19 s after speech, and Alexa must answer within 8 s. So the drill takes two turns. The attempt turn answers at once (contract check: 3 to 5 ms). An early "how did I do?" is answered within 6.5 s plus one hub call (tests: under 7 s on a fake clock; contract check: about 0.6 s with the demo replay).

**Progressive response.** Sent as `VoicePlayer.Speak` to `{apiEndpoint}/v1/directives`, and only to `https://api[.eu|.fe].amazonalexa.com`. A forged request cannot point the hub at another host.

**Request checks.** `400 alexa_rejected` when the application id is not the skill's, or when the timestamp is more than 150 s off the hub's wall clock (the real clock, not the demo clock).

**Signature verification (on by default).** Every public request (through the tunnel) must carry Amazon's signature:

1. the `SignatureCertChainUrl` rules;
2. the chain to a trusted root, with the leaf for `echo-api.amazon.com`, valid now;
3. RSA-SHA256 of the raw body.

Loopback and LAN requests (tests, the contract check, the simulator on this machine) are never signature-checked. `ALEXA_VERIFY_SIGNATURE=0` turns the check off for public requests too; use that only for a local fixture run, never with a tunnel up. The hub logs `alexa.signature-off` at startup when it is off. The check is tested with a throwaway CA. It has not yet run against Amazon's live chain: if the first real request fails, the `alexa.rejected` log line gives the reason. A failed chain download is cached for 60 s, and at most 8 chains are kept.

## MCP tools

Each result is `content: [{type:"text", text: <narration>}]` plus `structuredContent` (the route's JSON). A route answering 400 or more, or an unreachable hub, gives `isError: true` with the route's `{error, message}` as `structuredContent`. Invalid arguments are refused by the zod input schema before any hub call.

| Tool | Args | Route | Narration |
|---|---|---|---|
| `start_drill` | `size?` 1-10 | `POST /api/session/start {by:"mcp"}` | route `narration` (`Say this: "..."`) |
| `submit_attempt` | `text`, `card_id?` | `POST /api/attempt {source:"mcp"}` | route `narration` ("Got it. I'm checking with Bee...") |
| `get_verdict` | `attempt_id` | `GET /api/attempts/<id>` | route `narration` |
| `drill_status` | | `GET /api/session` | route `narration` |
| `next_card` | | `POST /api/session/next` | route `narration`, or the summary when done |
| `end_drill` | | `POST /api/session/end` | "Drill ended: N of M Bee-graded attempts passed." |
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
- **Token.** It reads `#t=<MCP_TOKEN>` from the fragment, which is never sent to a server. It keeps the token in `sessionStorage` and removes it from the address bar. On this machine (or on the LAN with `npm run hub -- --lan`) it needs no token; elsewhere it prompts when the fragment is missing.
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
4. **Deploy the skill** (terminal 3):
   ```bash
   PUBLIC_BASE_URL=https://<id>.ngrok-free.app npm run alexa:deploy
   ```
   It updates the existing dev skill (`amzn1.ask.skill.<your-skill-id>...`, ASK profile `default`), waits for both locales to report `SUCCEEDED`, and turns testing on. To preview the commands only, run `npm run alexa:deploy -- --dry-run`; to check the build status, `npm run alexa:deploy -- --status`.
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
7. **Simulator.** Open `https://<id>.ngrok-free.app/sim/#t=<MCP_TOKEN>` on a phone or laptop. ngrok's free tier may show its browser warning page once; choose "Visit Site". Run the same drill with "quiz me", the sentence, then "how did I do?". On this machine, `http://127.0.0.1:8791/sim/` also shows the hub event feed; while `PUBLIC_BASE_URL` is set it needs `#t=<MCP_TOKEN>` too (a TCP tunnel would look local, so `/mcp` and `/alexa` authenticate every request while a tunnel is declared).
8. **Signature check.** It is on for step 6. If Alexa answers "There was a problem with the requested skill's response", read the hub log line `alexa.rejected` for the reason. Do not turn the check off while the tunnel is up.

## Known limits

- **Signature verification** is on by default for public requests (see above), but it has not yet been run against Amazon's live certificate chain. With `ALEXA_VERIFY_SIGNATURE=0`, anyone who knows both the tunnel URL and the skill id could drive the skill and hear card sentences.
- **Progressive responses** depend on Alexa's `apiAccessToken` and were not exercised on a device in this packet. The spike proved the two-turn flow without them.
- **`end_drill` and Stop** report the last session's summary when no session is running. The MCP tool maps 1:1 to `POST /api/session/end`, which returns it; Alexa checks `GET /api/session` first and just says "Bye."
- **Speech recognition in the simulator** is the browser's own and is provisional, exactly like Alexa's transcript.

## Contract change requests

These are for the lead; packet C did not edit the frozen files.

1. **`test/hub-plugins.test.ts`, "every planned v2 route answers 501 not_implemented from its owner's stub".**
   - The test now fails: `/api/demo/mirror` answers 202, from packet B. Once B's row is fixed, it will fail on `POST /alexa` (now 400 `alexa_rejected` for `{}`) and `/mcp` (POST 406 without the MCP `Accept` header, GET and DELETE 405).
   - The "health" test in the same file expects the `live` plugin to report `stub`, which packet A changed.
   - Suggested change: replace the rows with "every v2 route is owned (never `not_found`)" and accept `ready` statuses.
2. **`docs/CONTRACT.md`, the v1 "Phase 3: Alexa+ MCP server" tool table.** It still lists `how_did_i_do(range) -> GET /api/stats` and omits the v2 tools. `MCP_TOOLS` names it `habit_stats` and adds `how_am_i_doing`, `live_coach` and `last_recap`. Suggest pointing that table at the v2 MCP section.
3. **`docs/CONTRACT.md`, the Alexa intent table.** Two behaviours could be written down there:
   - Stop and Cancel read `GET /api/session` before `POST /api/session/end`.
   - HowDidIDo on a pass also calls `POST /api/session/next`.
4. **`scripts/contract-check.ts`, packet module order.** The alexa module drills the last due demo cards, and the mcp module then needs one. The alexa module leaves one card due on purpose by letting Bee fail it, and both modules fall back to a practice card when nothing is due. A `POST /api/demo/reset` (demo only), or a few more due cards in the demo deck, would remove that coupling.
