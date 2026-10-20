# The Speaking Mirror (Fire TV) and the phone page

Packet B of the coach hub (contract v2, [`docs/CONTRACT.md`](CONTRACT.md)). The mirror is a 10-foot app that shows:

- the week's habit rates from Bee;
- the pre-registered transfer result;
- the drill in progress, from the phone's preview to Bee's verdict;
- the live conversation, with its wrist nudges and their latency hops;
- the phone's practice meters, live.

The phone page at `/p/<code>#k=…` is its microphone, with three modes: drill, practice and a mic check.

Everything below runs on synthetic demo data unless the hub runs live. Every screen shows the hub's `dataLabel` whenever the data is synthetic.

## Screens

The screenshots were captured on 2026-10-16 against `npm run hub -- --demo --fixture-v2 --pace 0.05`.

| Screen | Vega Virtual Device | Web TV | What it shows |
|---|---|---|---|
| Week | [vega-week](screens/vega-week.png) | [web-week](screens/web-week.png) | `GET /api/stats?range=week`. Habit bars per 100 words with 95% interval whiskers, word and session counts, drills today, due cards, and the transfer headline. |
| Transfer | [vega-transfer](screens/vega-transfer.png) | [web-transfer](screens/web-transfer.png) | `GET /api/transfer`. Before and after bars with whiskers, DRILLED/CONTROL chips, verdict chips, the pre-registration date, "needs N words/period", and the unregistered habits. |
| Live, with the drill | [vega-drill-graded](screens/vega-drill-graded.png) ([card](screens/vega-drill-card.png), [checking](screens/vega-drill-checking.png)) | [web-drill-graded](screens/web-drill-graded.png) | The drill pipeline: preview (provisional), checking with Bee, verified by Bee (lavender, with speaker score and latency), graded from Bee, and the BEE OVERRULES beat. |
| Live, the conversation | [vega-live](screens/vega-live.png) | [web-live](screens/web-live.png) | `live.window`: wpm, talk share, current and longest turn, the 2-minute counters against their nudge thresholds, and the last `nudge.sent` with its hop timeline (spoken, Bee tagged, rule fired, to-do set, Watch buzz). `nudge.skipped` reasons are listed too. |
| Recap overlay | [vega-recap](screens/vega-recap.png) | [web-recap](screens/web-recap.png) | `recap.ready`: the headline, metrics against baseline, habit verdicts, the wearer's own moment with a rephrase, and nudges sent or held. |
| Practice | [vega-practice-live](screens/vega-practice-live.png), [vega-practice-summary](screens/vega-practice-summary.png) | [web-practice-from-phone](screens/web-practice-from-phone.png), [web-practice-summary-from-phone](screens/web-practice-summary-from-phone.png) | `practice.meters` (room frames) and `practice.summary`: the volume band, a 5 s pitch trace, the range in semitones with the monotone flag, wpm, pauses, the live caption, and the take summary with its flags. |
| Pair phone | [vega-pair](screens/vega-pair.png) | [web-pair](screens/web-pair.png) | A QR code of `welcome.joinUrl` (built from RN Views, no canvas) and the room code. |
| Phone | | [drill](screens/phone-drill-graded.png), [practice](screens/phone-practice.png), [summary](screens/phone-practice-summary.png), [mic check](screens/phone-miccheck-result.png) | The phone page at a 390×844 viewport. |

The `web-practice*-from-phone` shots are a real end-to-end run in Chrome with a fake microphone fed by a synthetic voice WAV. The audio went through the phone page, AudioWorklet, the prosody engine, the bridge, the hub relay and the TV. The `vega-practice*` shots are the fixture take from `POST /api/demo/mirror`.

## Run it

```bash
npm run hub -- --demo --fixture-v2 --pace 0.05   # the hub on 8791 (fixture mode: the v2 live routes answer from fixtures/contract-v2/)
npm run tv:web:build                             # the web TV, served by the hub at http://127.0.0.1:8791/tv/
npm run web:phone:build                          # the phone page at /p/<code>#k=<PAIR_TOKEN> (scan the TV's QR code)
npm run tv:web:dev                               # or a dev server on 5183 (proxies /ws and /api to 8791)

curl -X POST localhost:8791/api/demo/live -d '{"script":"story"}'   # the live story: window, nudge with hops, skip, recap
curl -X POST localhost:8791/api/demo/mirror -d '{}'                 # a practice take on every TV
```

- **Fixture mode** (`--fixture-v2`): the frozen fixture router answers `/api/demo/mirror` with the fixture's ten frames.
- **Demo mode without the fixture** (`--demo`): the mirror plugin answers it with a synthetic voice metered by the phone's own prosody engine: 60 frames at 10 Hz, then `practice.summary`. `{"script":"focus","view":"transfer"}` switches every mirror to a screen.

On the web TV, the arrow keys and Enter move along the tabs. Left or Right at either end of the row switches screens. Back or Escape closes the recap, then returns to the week; on the week screen, Back is left to the platform (on Vega it exits the app). `?debug=1` or `D` shows the seq counters.

## Vega (Fire TV)

```bash
npm install --prefix tv/vega         # Vega deps stay in tv/vega (RN 0.83, @amazon-devices/*)
npm run tv:sync                      # copy the shared code from tv/web into tv/vega
npm run tv:vega:build                # build/{x86_64,armv7,aarch64}-release/speakingmirror_*.vpkg, about 12 s
npm --prefix tv/vega test            # jest
npm --prefix tv/vega run typecheck

vega virtual-device start --timeout 300
vega device start-port-forwarding -d VirtualDevice --port 8791 --forward false   # reverse tunnel: the app dials 127.0.0.1:8791
vega device terminate-app -d VirtualDevice --appName com.beecoach.mirror.main    # before every re-run: run-app does not restart a running app
vega run-app tv/vega/build/x86_64-release/speakingmirror_x86_64.vpkg com.beecoach.mirror.main -d VirtualDevice
```

- **Package.** `com.beecoach.mirror` ("Speaking Mirror"), component `com.beecoach.mirror.main`. The mirror is silent, so it has no media player and no media services in `manifest.toml`.
- **Hub address.** `tv/vega/src/hub.json` (`npm --prefix tv/vega run hub -- <host:port>`, then rebuild).
  - On the VVD, use `127.0.0.1:8791` with the reverse port forward. Never use the NAT address `10.0.2.2`: frames over about 1.4 kB get dropped there.
  - On a stick on Wi-Fi, use the dev machine's LAN IP, and start the hub with `npm run hub -- --lan` (or `HUB_TRUST_LAN=1`). Without it, the gate treats other LAN devices as public, and the stick gets 403s. Use `--lan` on your own Wi-Fi only.
- **Meters on Vega.** They render at 5 Hz. The phone sends 10 Hz; the app batches frames, so the pitch trace keeps every frame.
- **Screenshots.** The VVD screenshots come from the emulator console, `screenrecord screenshot <dir>` on `localhost:5554`. The remote keys were sent with `vega exec vda -s emulator-5554 shell "inputd-cli button_press KEY_RIGHT|KEY_ENTER|KEY_BACK"`.
- **Bundle check.** The release sourcemap has 15 `@amazon-devices/react-native-kepler` modules and 0 core `react-native` modules, so the default Metro config keeps the Vega platform mapping (no custom resolver).
- **Rendering.** Views avoid nested `Text` with letter spacing and attach animated styles from the first render, because both render differently on Vega. Big numerals carry side padding so their first glyph is not clipped.

### Real Fire TV stick

First run on hardware 2026-10-20 (Fire TV Stick, `armv7l`, Vega OS 2.0 "TV Ship/63"), connected over Wi-Fi. The steps:

1. **Developer mode (once; a browser sign-in, so the operator does it).**
   - On the stick: Settings → My Fire TV → About, highlight the device name and press the centre button 7 times.
   - Settings → My Fire TV → Developer Options → Developer Mode → Continue. A 6-digit code appears; it expires in 5 minutes.
   - On the dev machine: `vega devmode login` (signs in with the Amazon developer account), then `vega devmode enable-device --code <code>`. The stick reboots.
2. **Connect the stick to the dev machine.** The stick has one USB-C port, and it is the power port, so there are two ways:
   - **Wi-Fi (used here; the stick stays on wall power and HDMI).**
     1. Settings → My Fire TV → About → Network: note the stick's IP address. The stick and the dev machine must be on the same Wi-Fi, and `ping <stick IP>` must answer.
     2. Settings → My Fire TV → Developer Options → **Connection Mode → TCP/IP**. The stick reboots.
     3. `vega exec vda connect <stick IP>:5555`, then `vega exec vda devices` lists `<stick IP>:5555  device`. Use `<stick IP>:5555` wherever a step below says `-d <device>`.
   - **USB.** Move the stick's USB-C power cable from the wall adapter to the dev machine (a data-capable cable, no hub, not through a monitor). The cable then carries power and data; a weak laptop port can make the stick reboot in a loop. `vega device list` gives the serial.
   - Either way, `vega device info -d <device>` gives the architecture (`aarch64` or `armv7l`) and `vega exec vda -s <device> shell cat /etc/os-release` the OS version (the manifest needs 1.2 or later).
3. **Run the app with the reverse forward.** The app dials `127.0.0.1:8791`; the reverse forward also works over Wi-Fi, so the hub sees the stick as local and no `--lan` is needed:

   ```bash
   npm run tv:vega:build
   npm run hub -- --demo                # or `npm run hub` for live Bee
   vega device start-port-forwarding -d <device> --port 8791 --forward false
   vega device terminate-app -d <device> --appName com.beecoach.mirror.main
   vega run-app tv/vega/build/<arch>-release/speakingmirror_<arch>.vpkg com.beecoach.mirror.main -d <device>
   ```

   On this stick `<arch>` is `armv7` (`speakingmirror_armv7.vpkg`).
4. **Pair the phone and check.** Scan the TV's QR with the phone on the same Wi-Fi (the QR carries `#k=`, so a LAN phone gets in without `--lan`). Run one drill (provisional → checking with Bee → graded) and one practice take (meters move), then Right/OK across the tabs and Back to exit. If the phone cannot connect, restart the hub with `--lan` (home Wi-Fi only).

**Troubleshooting (seen on the first run).**

| Symptom | Cause | Fix |
|---|---|---|
| `vega device list` → "No devices found" with a USB-C cable plugged in | The cable linked the monitor to the laptop, not the stick; `lsusb` showed no Lab126 device | Use Wi-Fi (step 2), or the stick's own USB-C port straight to the laptop |
| `vda connect <IP>:5555` → "Connection refused" while `ping` answers | The stick was in USB connection mode, so nothing listened on 5555 | Developer Options → Connection Mode → TCP/IP; it reboots; connect again (it answered on the second try, about 10 s after the reboot) |
| `vda connect` times out | Different networks, or the Wi-Fi blocks device-to-device traffic | Same Wi-Fi for both; a phone hotspot works as a fallback |
| `lsusb` shows Lab126 but `vda devices` is empty (USB) | Linux USB permissions | Add the udev rule for vendor `1949` (Amazon's VDA troubleshooting page), be in `plugdev`, restart VDA |
| The stick stops responding in TCP/IP mode | Known Vega issue | Developer Options → Connection Mode → USB, then `vega exec vda usb` |
| The address changes after a router restart | DHCP | Reserve the stick's IP for its Wi-Fi MAC in the router |

**Status.** 2026-10-16: built (three vpkgs of about 276 kB, `manifest validation found 0 errors`) and verified on the VVD: it joined the hub over the reverse forward, fetched stats and transfer, rendered every screen, and remote navigation worked. 2026-10-20: installed and launched on a real stick over Wi-Fi against the live hub.

## How it is built

- **Shells.** `tv/web` is copied from the Rack Board web TV and `tv/vega` from its Vega app. Copied, not shared: no shared package and no WebView. The engine dependency, the board views, the audio and media players and the demo steps are gone.
- **Kept from the shells.**
  - the focus layer: a web grid and Vega platform focus;
  - motion, debug and the remote;
  - the QR code built from Views;
  - the stage scaling.
- **Shared code** (`npm run tv:sync`, checked by `test/tv-sync.test.ts`) is byte-identical in both apps:
  - `contract.ts`, a verbatim copy of `src/hub/contract.ts`;
  - `theme.ts`, `brand.ts` and `motion.ts`;
  - `mirror/`: `reducer.ts`, `useMirror.ts` and `format.ts`;
  - `components/`: Chrome, Chip, RateBar, Sparkline, HopTimeline and Qr;
  - `views/`: MirrorScreens, WeekView, TransferView, LiveView, PracticeView, RecapOverlay and PairingView.
- **Per-app code.** `App.tsx`, `focus.tsx`, `debug.tsx` and `platform/` (`fonts.ts`, `config.ts`, and `remote.ts` on the web).
- **`mirror/reducer.ts`** is pure. Sequenced events are applied in `seq` order, and duplicates (`seq` at or below the last one applied) are dropped.
  - An event ahead of a gap waits for up to 1.5 s, then is applied with the gap counted.
  - A new `hub.state` rebases the sequence.
  - Room frames (`practice.meters`) never touch the sequence. Only the last 50 are kept, in memory.
  - Screens switch on events. Drill events show the drill. Conversation events show the live screen, unless a drill or a take is in progress. Meters show practice. `recap.ready` raises the overlay for 30 s. `mirror.focus` shows the requested view.
- **`src/hub/mirror.ts`:**
  - Relays a mic's `practice.meters` to its room's screens only, through `ctx.broadcastToScreens` (at most 20 Hz). Each frame is rebuilt from the contract fields and stamped `from`. Malformed frames and frames from a screen are dropped.
  - Publishes `practice.summary` (mic only) with the hub's `room`, `from` and `provisional: true`.
  - Publishes `mirror.focus` from any peer, with `by` set to the peer's name.
  - Serves `POST /api/demo/mirror` (demo only; `400 demo_only` otherwise).
- **Privacy.**
  - The TV shows only text the hub served: card sentences, Bee's drill text, the recap moment, and the caption the phone sent in a meter frame.
  - Nothing is written to storage on the TV or the phone. The room code and the pair token live in memory.
  - The phone sends numbers plus its own interim words as the caption. It records nothing.

## The phone page (`web/phone`, built to `dist/web/phone`, served at `/p/`)

- **Drill.** Reuses the patterns of the shell's phone page (`connect`, `setupVoice`, `sendUtterance`). Web Speech produces a `transcript.final` over the bridge, which becomes a provisional attempt, and interim words go out as `transcript.partial` so the TV shows "hearing: …". The page then follows its own attempt: preview, checking with Bee, verified by Bee, graded from Bee, and "Bee overrules". It has a typed fallback and Start/Next/End drill buttons (`session.*` app frames).
- **Practice.** `getUserMedia` runs with automatic gain control, noise suppression and echo cancellation off. Audio reaches JS through an AudioWorklet (ScriptProcessor as a fallback) and goes into `prosody.ts`, which sends `practice.meters` at 10 Hz and a tracked `practice.summary` at the end. Speech recognition runs alongside for the caption and a word count; if it fails, the meters still run without captions. A take stops after 2 minutes at most.
- **Mic check.** Covered in the next section.

### DSP (`web/phone/src/dsp.ts`, `prosody.ts`; pure, also used by the hub's demo take)

| Measure | Method | Accuracy (`test/phone-dsp.test.ts`) |
|---|---|---|
| Volume | RMS in dBFS per 100 ms frame. Band quiet below −35, loud above −12 (the coach template's thresholds) | A 0.5-amplitude sine reads −9.031 dBFS (−9.03 expected); full scale −3.01 |
| Pitch | YIN, 70–400 Hz, threshold 0.15, parabolic interpolation, unvoiced above an aperiodicity of 0.35 or below the silence gate | 110 / 220 / 330 Hz sines read 110.001 / 220.016 / 330.022 Hz at 16 kHz (at most 0.007% error) and 110.000 / 220.002 / 330.003 Hz at 48 kHz. A harmonic tone reads its fundamental. White noise is unvoiced |
| Pitch range | 10th–90th percentile of the voiced pitch over the last 5 s, in semitones. Monotone below 3 st (needs 10 or more voiced frames) | A flat 200 Hz voice is flagged monotone; a 170–240 Hz contour is not |
| Rate | Syllable nuclei are peaks of the 10 ms level envelope (smoothed over 50 ms, at least 3 dB prominence, 100 ms apart) over the last 5 s; wpm = syllables/s × 60 / 1.5 | 4 Hz amplitude-modulated noise reads 4.00 syllables/s; 6 Hz reads 5.4–6.6; steady noise reads below 0.5 |
| Pauses | Silent runs of 250 ms or more between stretches of speech. Silence is 25 dB under the 90th-percentile level, never below −60 dBFS. Leading and trailing silence do not count | Gaps of 300, 100 and 600 ms give pauses of exactly [300, 600] ms |

## Mic check (for the operator, iPhone Safari)

The question: can Web Speech recognition and `getUserMedia` run at the same time? Practice mode wants both: the mic stream for the meters, and recognition for the captions.

1. Start the hub (`npm run hub -- --demo`) and build the pages (`npm run tv:web:build && npm run web:phone:build`).
2. Run `ngrok http 8791` yourself (the agent may not start tunnels). iPhone Safari only allows the mic on https: a LAN `http://192.168…` page will report "Secure page: no".
3. Set `PUBLIC_BASE_URL=https://<your-ngrok-host>` before starting the hub, so the TV's QR code carries the https link and the pair token. Open `http://127.0.0.1:8791/tv/`, go to Pair phone, and scan the QR code with the iPhone.
   - Without pairing, `https://<ngrok-host>/p/` shows a join screen with an "open the mic check" link.
4. On the phone, tap **Mic check**.
   - Check the line "Secure page · mic stream · speech recognition": all three should say yes.
   - Tap **Part 1: speech, then mic** and count out loud for about 8 seconds; allow the microphone and speech recognition when asked.
   - Then tap **Part 2: mic, then speech** and count again.
5. Read the result:
   - **PASS** (mint). If part 1 passed, practice mode shows live captions with the meters. If only part 2 passed, the page switches practice to the mic-first order for the rest of that session.
   - **FAIL** (coral). The reasons are listed: recognition heard nothing (with Safari's error code), the mic stream went flat or delivered no audio, or the mic track was muted or ended. Practice mode still runs the meters, without captions.
   - **NOT YET** (amber) means part 1 failed and part 2 has not run.
   - **Copy the result** puts a one-line-per-part report (with the browser's user agent) on the clipboard. Paste it into the build notes.

Each part counts recognition results, mic blocks, the level span and whether the track is still live, all while both run for 6 s. Nothing is sent to the hub.

Desktop headless Chrome has no speech service, so in the automated run part 1 failed with "speech recognition heard nothing while the mic stream ran" ([screenshot](screens/phone-miccheck-result.png)). That is the expected failure path. The pass path depends on the browser.

## Checks

| Check | Command | Result (2026-10-16) |
|---|---|---|
| DSP, reducer, plugin, phone helpers, sync, brand | `npx vitest run test/phone-*.test.ts test/mirror-*.test.ts test/tv-*.test.ts` | 47 tests in 6 files pass |
| Mirror contract flows | `npm run contract:check` | mirror module 19/19; the whole check passes |
| Web TV | `npm run tv:web:build`, `npm --prefix tv/web run typecheck` | builds; no type errors |
| Phone page | `npm run web:phone:build`, `npx tsc --noEmit -p web/phone/tsconfig.json` | builds; no type errors |
| Vega | `npm --prefix tv/vega test`, `npm --prefix tv/vega run typecheck`, `npm run tv:vega:build` | jest 5/5; no type errors; 3 vpkgs |

## Known limits

- The real-stick run and the iPhone mic check are operator steps (devmode login; a tunnel).
- The syllable-rate wpm is an estimate from the level envelope. It assumes 1.5 syllables per word, so it reads slow speakers of long words low. Bee's wpm, from real timing, stays the reference for real speech.
- Pitch exists only in practice: Bee stores no audio.
- On Vega, Left and Right move platform focus inside the tab row but do not wrap to switch screens at the ends; OK on a tab does.
- The web TV reads `?debug=1`; the Vega app toggles debug with the remote's Menu or Play/Pause key.

## Contract change requests

1. **`test/hub-plugins.test.ts` (lead-owned) still expects stubs.**
   - "every planned v2 route answers 501 not_implemented from its owner's stub" lists `POST /api/demo/mirror` as a 501. It now answers 202, or 400 `bad_request`/`demo_only`. Packet A's `/api/live` routes and packet C's routes break the same test.
   - "health: … every plugin's status" expects `live` with status `stub`.
   - Suggested: drop the landed routes from the 501 list, or assert "never 404 and never 501" per route, and read `status` from `describe()`.
   - These are the only failures in `npx vitest run` from this tree; both come from that file.
2. **(Optional) `DemoMirrorRequest` could document the non-fixture demo take.** Without fixture mode it is 60 frames at 10 Hz (6 s), and `mirror.focus` is published *before* the frames: the take starts, then the summary. Fixture mode publishes it after the frames. Both orders are valid for the TV, which switches on meters anyway.
3. **(Optional) `PracticeSummary.room` for a demo take sent to every room is `"*"`.** The type says "bridge room code". Either document `"*"` or allow `null`.
