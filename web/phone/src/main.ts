// The Speaking Mirror phone page (/p/<code>?k=...): the phone is the microphone.
//   Drill     Web Speech -> transcript.final over the bridge (a provisional attempt); the page then
//             follows the attempt through Bee's verdict (sequenced hub events).
//   Practice  getUserMedia (AGC, noise suppression and echo cancellation off) -> the prosody engine
//             -> practice.meters at 10 Hz to the TV, then practice.summary. Interim Web Speech words
//             ride along as the caption. Nothing is recorded or stored.
//   Mic check can Web Speech and getUserMedia run at once on this phone? (src/miccheck.ts)
//   Progress  today's practice, this week, the before and after and the last recaps: the TV's own
//             reads, with the pair token in a header (src/progressView.ts)
// Privacy: no localStorage or sessionStorage; the pair token stays in memory.
import { BridgeClient, normalizeCode, type IntentMsg } from "tv-voice-bridge";
import type { CardView, HubState, PracticeSummary } from "../../../src/hub/contract.js";
import { startCapture, captureSupported, type Capture } from "./audio.js";
import { PRODUCT_NAME } from "./brand.js";
import { envReport, reportText, runPhase } from "./miccheck.js";
import { ProsodyEngine, type MeterCore } from "./prosody.js";
import { createProgress } from "./progressView.js";
import { dictation, listen, speechCtor, type Listener } from "./speech.js";
import { captionOf, countWords, meterFrame, newTakeId, parseJoin, sessionOverLine, speechLang, takeSummary, wsProtocols, wsUrl, type MicPhase, type MicVerdict } from "./take.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const now = () => performance.timeOrigin + performance.now();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const join = parseJoin(location.pathname, location.search, location.hash);
// Keep the pair token out of the address bar, history and screenshots once it is in memory.
if (join.k) {
  const q = new URLSearchParams(location.search);
  q.delete("k");
  history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
}
const TAKE_MAX_MS = 120_000;
const FLAG_WORD: Record<string, string> = { quiet: "too quiet", loud: "too loud", monotone: "a flat melody", fast: "fast", slow: "slow", "few-pauses": "few pauses" };

let client: BridgeClient | null = null;
let room: string | null = null;
let card: CardView | null = null;
let myAttempt: string | null = null;
let speechFirst = true; // practice starts speech, then the mic (the mic check may flip this for the session)

function setConn(text: string, cls = "") {
  const el = $("conn");
  el.textContent = text;
  el.className = `pill ${cls}`;
}

type Mode = "drill" | "practice" | "progress" | "check";
function show(mode: Mode | "join") {
  for (const id of ["join", "drill", "practice", "progress", "check"]) $(id).hidden = id !== mode;
  $("tabs").hidden = mode === "join";
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === mode);
    if (b.dataset.mode === mode) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (mode === "progress") progress.open();
  else progress.hide();
}

const progress = createProgress({
  root: $("progress"),
  token: () => join.k,
  hubNow: () => client?.now() ?? Date.now(),
  onPractise: () => {
    show("drill");
    window.scrollTo(0, 0);
  },
});

// Drill

function renderCard() {
  // the TV's words: "Instead of “that thing”, say" over the line itself (no strike-through copy of it)
  $("card-kicker").textContent = card ? (card.said ? `Instead of “${card.said}”, say` : "Say") : "No line open";
  $("card-said").textContent = "";
  $("card-fix").textContent = card ? card.resay || card.fix : "Tap Start, or say “Alexa, ask Speech Coach to quiz me”.";
}

const stages: string[] = [];
let overLine: { sessionId: string; at: number } | null = null; // the "Session over" line, replaced when the hub re-sends it
function stage(cls: string, text: string, reset = false) {
  if (reset) (stages.length = 0), (overLine = null);
  stages.push(`<div class="${cls}">${esc(text)}</div>`);
  renderStages();
}
function renderStages() {
  const el = $("pipeline");
  el.hidden = false;
  el.innerHTML = stages.join("");
}

function onEvent(topic: string, p: Record<string, any>) {
  progress.onEvent(topic, p);
  if (topic === "hub.state") {
    const h = p as unknown as HubState;
    card = h.openCard;
    renderCard();
    const synthetic = !!h.dataLabel && /synthetic/i.test(h.dataLabel);
    $("foot").textContent = synthetic ? `${h.dataLabel}. Bee checks every line you say; your phone’s text is only a preview.` : "Bee checks every line you say; your phone’s text is only a preview.";
    $("foot").classList.toggle("synthetic", synthetic);
    return;
  }
  if (topic === "card.open") {
    card = p.card ?? card;
    renderCard();
  }
  // A verdict refreshes the open card (its box); a late one after the session ended must not
  // bring the closed card back (review L49).
  if (topic === "attempt.graded" && card && p.card?.id === card.id) {
    card = p.card;
    renderCard();
  }
  // The session's card is closed (by the phone, the TV, Alexa or idle expiry): drop it, so the next
  // attempt is not refused with "open a card first" under a card that is still on screen. An attempt
  // still with Bee keeps its pipeline, and its verdict still shows when it lands. When Bee settles
  // that attempt, the hub sends session.ended again with the updated tally: replace the line.
  if (topic === "session.ended") {
    card = null;
    renderCard();
    const sid = typeof p.summary?.sessionId === "string" ? (p.summary.sessionId as string) : null;
    if (sid && overLine?.sessionId === sid && overLine.at < stages.length) {
      stages[overLine.at] = `<div class="dim">${esc(sessionOverLine(p.summary))}</div>`;
      renderStages();
    } else {
      stage("dim", sessionOverLine(p.summary));
      overLine = sid ? { sessionId: sid, at: stages.length - 1 } : null;
    }
    return;
  }
  const id = p.attempt?.id ?? p.attemptId;
  if (!id || !ATTEMPT_TOPICS.has(topic)) return;
  if (id !== myAttempt) {
    // Bee can grade a line it already heard before this phone's intent names the attempt (the wearer
    // typed what they had just said): keep it for onIntent (review L38).
    early.push([topic, p]);
    if (early.length > 20) early.shift();
    return;
  }
  if (topic === "attempt.status") stage("wait", "Still checking with Bee…");
  if (topic === "attempt.verified") stage(p.status === "verified" ? "bee" : "bad", p.status === "verified" ? "Bee heard you" : "Bee didn’t catch that one. Say it again.");
  if (topic === "attempt.graded") {
    const a = p.attempt;
    stage(a.final?.pass ? "ok" : "bad", `${a.final?.pass ? "Passed" : "Not yet"}${a.agreement === "bee-overrules" ? ": Bee’s call, not the preview’s" : ""}`);
    const why = (a.final?.grade?.reasons ?? []).find((r: string) => r.startsWith("FAIL"));
    if (why) stage("dim", plainWhy(why));
  }
}

// The grader's first failed rule in plain words ("FAIL fillers: 1 filler (\"um\"); allowed 0" -> "Bee heard a filler word: “um”").
function plainWhy(reason: string): string {
  const m = /^FAIL (\w+):\s*(.*)$/.exec(reason);
  if (!m) return reason;
  const quoted = [...m[2]!.matchAll(/"([^"]+)"/g)].map((q) => `“${q[1]}”`).slice(0, 2).join(" and ");
  const lead: Record<string, string> = { fillers: "Bee heard a filler word", habit: "The old habit was still there", content: "A few words were missing", required: "A key word was missing", nonempty: "Bee heard nothing" };
  return lead[m[1]!] ? `${lead[m[1]!]}${quoted ? `: ${quoted}` : ""}` : m[2]!;
}

const ATTEMPT_TOPICS = new Set(["attempt.status", "attempt.verified", "attempt.graded"]);
const early: [string, Record<string, any>][] = [];

function onIntent(m: IntentMsg) {
  if (m.from !== client?.clientId) return;
  const p = (m.payload ?? {}) as Record<string, any>;
  if (m.name === "attempt.provisional") {
    myAttempt = p.attemptId ?? null;
    stage("dim", `Your phone heard ${p.provisionalPass ? "a pass" : "a miss"} (only a preview)`, true);
    stage("wait", "Checking with Bee…");
    const mine = early.filter(([, p]) => (p.attempt?.id ?? p.attemptId) === myAttempt);
    early.length = 0;
    for (const [topic, p] of mine) onEvent(topic, p);
  } else if (m.name === "attempt.rejected") stage("bad", p.error === "no_open_card" || !(p.message ?? p.error) ? "No line is open yet. Tap Start first." : `Not sent: ${p.message ?? p.error}`, true);
  else if (m.name === "practice.summary") $("take-state").textContent = m.ok ? "Your take is on the TV." : `The TV didn’t get your take: ${p.message ?? p.error}`;
}

function sendUtterance(text: string, speechEndAt: number) {
  if (!client || !text.trim()) return;
  // null: the link is down (reconnecting), so nothing reached the hub; say so rather than "Sent"
  if (client.sendFinal(text.trim(), { speechEndAt }) === null) return void stage("bad", "Not sent: reconnecting to the TV. Say it again in a moment.", true);
  stage("dim", `Sent: "${text.trim()}"`, true);
}

function setupDrillVoice() {
  const SR = speechCtor();
  const mic = $("mic");
  if (!SR) {
    mic.setAttribute("disabled", "true");
    $("mic-state").textContent = "Voice needs Chrome or Safari over https. Type below instead.";
    return;
  }
  let speechEnd = 0;
  let utteranceId = "";
  const d = dictation(SR, {
    lang: () => speechLang(card), // the card's language: a French card is dictated in French
    onListening: () => {
      utteranceId = `utt_${Date.now().toString(36)}`;
      mic.classList.add("live");
      $("mic-state").textContent = "Listening…";
    },
    onSpeechEnd: () => (speechEnd = now()),
    onError: (error) => {
      mic.classList.remove("live");
      $("mic-state").textContent = `Mic error: ${error}. Type below instead.`;
    },
    onIdle: () => {
      mic.classList.remove("live");
      $("mic-state").textContent = "Tap to try again.";
      speechEnd = 0;
    },
    onResult: (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) {
          const t = r[0]!.transcript;
          $("interim").textContent = t;
          sendUtterance(t, speechEnd || now());
        } else interim += r[0]!.transcript;
      }
      if (interim) {
        $("interim").textContent = interim;
        client?.sendPartial(interim, utteranceId);
      }
    },
  });
  mic.onclick = () => d.toggle();
}

// Practice

interface Take {
  id: string;
  eng: ProsodyEngine | null;
  cap: Capture | null;
  lis: Listener | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  speechError: string | null;
}
let take: Take | null = null;

function renderMeters(f: MeterCore, caption: string | null) {
  $("meters").hidden = false;
  $("m-vol").textContent = f.band === "quiet" ? "A bit quiet" : f.band === "loud" ? "A bit loud" : "Good";
  $("m-pitch").textContent = f.monotone ? "Flat" : `${f.pitchRangeSt.toFixed(1)} semitones`;
  $("m-rate").textContent = f.wpm === null ? "–" : `${f.wpm} a minute`;
  $("m-pause").textContent = `${f.pause.count}${f.pause.active ? " · now" : ""}`;
  $("m-caption").textContent = caption ?? "";
}

async function startTake() {
  if (!client || take) return;
  const sup = captureSupported();
  if (!sup.ok) {
    $("take-state").textContent = `Practice needs the mic: ${sup.why}.`;
    return;
  }
  const t: Take = { id: newTakeId(Date.now()), eng: null, cap: null, lis: null, startedAt: client.now(), timer: null, speechError: null };
  take = t;
  $("take").textContent = "Stop take";
  $("take-result").hidden = true;
  client.sendApp("mirror.focus", { view: "practice", reason: "practice take started", takeId: t.id });
  const startSpeech = () => {
    t.lis = listen({ onText: () => undefined, onError: (e) => (t.speechError = t.speechError ?? e) });
    if (!t.lis) t.speechError = "no Web Speech on this browser";
  };
  if (speechFirst) startSpeech();
  try {
    t.cap = await startCapture((block) => {
      if (!t.eng || take !== t) return;
      for (const f of t.eng.push(block)) {
        const caption = captionOf(t.lis?.text());
        client?.sendApp("practice.meters", meterFrame(f, t.id, t.startedAt + f.t, caption));
        renderMeters(f, caption);
      }
    });
    t.eng = new ProsodyEngine({ sampleRate: t.cap.sampleRate });
    if (take !== t) {
      // Stop was tapped while the mic permission prompt was open: release the mic now.
      t.cap.stop();
      t.lis?.stop();
      return;
    }
  } catch (err) {
    $("take-state").textContent = `The mic did not start: ${(err as Error).name || (err as Error).message}.`;
    t.lis?.stop();
    if (take === t) {
      take = null;
      $("take").textContent = "Start take";
    }
    return;
  }
  if (!speechFirst) startSpeech();
  $("take-state").textContent = `Listening. Nothing is recorded.${t.speechError ? " Captions are off on this phone." : ""}`;
  t.timer = setTimeout(() => {
    if (take === t) void stopTake(); // never a newer take
  }, TAKE_MAX_MS);
}

async function stopTake() {
  const t = take;
  if (!t || !client) return;
  take = null;
  if (t.timer) clearTimeout(t.timer);
  const words = t.lis ? countWords(t.lis.text()) : null;
  t.lis?.stop();
  t.cap?.stop();
  $("take").textContent = "Start take";
  if (!t.eng || !t.eng.frames.length) {
    $("take-state").textContent = "No audio arrived from the mic.";
    return;
  }
  const s: PracticeSummary = takeSummary(t.eng.summary(), { takeId: t.id, room: room ?? "", from: client.clientId, startedAt: t.startedAt, endedAt: client.now(), words: t.lis ? words : null });
  client.sendApp("practice.summary", s, { track: true, startedAt: now() });
  const r = $("take-result");
  r.hidden = false;
  r.innerHTML = `<div class="kicker">Take finished · ${(s.durationMs / 1000).toFixed(0)} s</div>
    <div class="lead">${s.rate.wpm ?? "–"} words a minute · ${s.pitch.monotone ? "a flat melody" : "a lively melody"} · ${s.pauses.count} pause${s.pauses.count === 1 ? "" : "s"}</div>
    <div class="${s.flags.length ? "warn" : "ok"}">${s.flags.length ? `To work on: ${esc(s.flags.map((f) => FLAG_WORD[f] ?? f).join(", "))}` : "Nice take."}</div>
    <div class="dim small">Measured on this phone.${words ? ` ${words} words heard.` : ""}</div>`;
}

// Mic check

const parts: (MicPhase & MicVerdict)[] = [];
function renderCheck() {
  const env = envReport();
  const el = $("check-result");
  if (!parts.length) return;
  const p1 = parts.find((p) => p.order === "speech-then-mic");
  const p2 = parts.find((p) => p.order === "mic-then-speech");
  const pass = !!(p1?.pass || p2?.pass);
  const pending = !pass && !(p1 && p2);
  el.hidden = false;
  el.className = `card verdict ${pass ? "pass" : pending ? "wait" : "fail"}`;
  const howto = p1?.pass ? "Practice mode will show live captions with the meters." : p2?.pass ? "Works when the mic starts first: practice mode will use that order on this phone for this session." : p1 && p2 ? "Practice mode will still show the meters, without captions." : "Run part 2 as well.";
  const list = (p: MicPhase & MicVerdict | undefined, name: string) => (p ? `<li><b>${name}: ${p.pass ? "PASS" : "FAIL"}</b>${p.reasons.length ? ` (${esc(p.reasons.join("; "))})` : ` (${p.speechResults} speech results, mic span ${p.levelSpanDb.toFixed(0)} dB)`}</li>` : "");
  el.innerHTML = `<div class="big-verdict">${pass ? "Works" : pending ? "Part 2 next" : "Doesn’t work"}</div><div>${esc(howto)}</div><ul>${list(p1, "Part 1, speech then mic")}${list(p2, "Part 2, mic then speech")}</ul>`;
  if (p1 && !p1.pass && p2?.pass) speechFirst = false;
  $("check-copy").hidden = false;
  $("check-copy").onclick = () => void navigator.clipboard?.writeText(reportText(env, parts)).then(() => ($("check-state").textContent = "Copied."));
}

function setupCheck() {
  const env = envReport();
  $("env").innerHTML = `Secure page: <b>${env.secure ? "yes" : "no"}</b> · mic stream: <b>${env.getUserMedia ? "yes" : "no"}</b> · speech recognition: <b>${env.speech ? "yes" : "no"}</b>${env.why ? `<div class="warn">${esc(env.why)}</div>` : ""}`;
  const run = async (order: MicPhase["order"], btn: HTMLButtonElement) => {
    if (take) return;
    for (const b of [$<HTMLButtonElement>("check-1"), $<HTMLButtonElement>("check-2")]) b.disabled = true;
    $("check-state").textContent = "Starting… allow the microphone if asked.";
    const r = await runPhase(order, (msg) => ($("check-state").textContent = msg));
    const i = parts.findIndex((p) => p.order === order);
    if (i >= 0) parts.splice(i, 1);
    parts.push(r);
    $("check-state").textContent = `${order === "speech-then-mic" ? "Part 1" : "Part 2"} done: ${r.pass ? "it works" : "it didn’t work"}.`;
    $<HTMLButtonElement>("check-1").disabled = false;
    $<HTMLButtonElement>("check-2").disabled = false;
    btn.classList.remove("primary");
    if (order === "speech-then-mic") $("check-2").classList.add("primary");
    renderCheck();
  };
  $<HTMLButtonElement>("check-1").onclick = () => void run("speech-then-mic", $("check-1"));
  $<HTMLButtonElement>("check-2").onclick = () => void run("mic-then-speech", $("check-2"));
}

// Connection

async function connect(code: string) {
  const protocols = wsProtocols(join.k);
  // the pair token travels in the subprotocols, never in the URL (take.ts wsProtocols)
  // the browser WebSocket, typed as the bridge client's minimal socket shape
  const WebSocketImpl = (protocols
    ? class extends WebSocket {
        constructor(url: string) {
          super(url, protocols);
        }
      }
    : undefined) as unknown as ConstructorParameters<typeof BridgeClient>[0]["WebSocketImpl"];
  client = new BridgeClient({ url: wsUrl(location.protocol, location.host), role: "mic", code, name: "phone", WebSocketImpl });
  // The bridge client keeps retrying after a failed first connect, so a later `open` leaves the join view.
  let dropped = false;
  client.on("open", () => {
    if (dropped) progress.onReconnect();
    dropped = false;
    room = client?.code ?? code;
    setConn(`Paired · ${room}`, "ok");
    if (!$("join").hidden) show("drill");
  });
  client.on("close", () => {
    dropped = true;
    setConn("Reconnecting…", "bad");
  });
  client.on("repair", () => {
    setConn("TV gone · scan its new code", "bad");
    client?.close();
    show("join");
  });
  client.on("app", (m) => onEvent(m.topic, (m.payload ?? {}) as Record<string, any>));
  client.on("intent", onIntent);
  try {
    const w = await client.connect();
    room = w.code;
    show("drill");
  } catch (err) {
    setConn("Not paired", "bad");
    show("join");
    $("join").insertAdjacentHTML("beforeend", `<p class="warn">${esc((err as Error).message)}. Check the code on the TV${location.protocol === "https:" ? " and use the TV's QR link (it carries the pair token)" : ""}.</p>`);
  }
}

function setup() {
  document.title = "Speaking Mirror";
  document.querySelectorAll(".brand").forEach((el) => (el.textContent = PRODUCT_NAME));
  setupDrillVoice();
  setupCheck();
  renderCard();
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.onclick = () => show(b.dataset.mode as Mode)));
  $("drill-start").onclick = () => client?.sendApp("session.start", { size: 5 });
  $("drill-next").onclick = () => client?.sendApp("session.next", {});
  $("drill-end").onclick = () => client?.sendApp("session.end", {});
  $("take").onclick = () => void (take ? stopTake() : startTake());
  $<HTMLFormElement>("text-form").onsubmit = (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("utterance");
    sendUtterance(input.value, now());
    input.value = "";
  };
  $("join-btn").onclick = () => {
    const code = normalizeCode($<HTMLInputElement>("code-input").value);
    if (code.length === 4) location.href = `/p/${code}${join.k ? `#k=${encodeURIComponent(join.k)}` : ""}`;
  };
  $("check-only").onclick = () => {
    show("check");
    $("tabs").hidden = true;
  };
  if (join.code) void connect(normalizeCode(join.code));
  else {
    setConn("Not paired");
    show("join");
  }
}

setup();
