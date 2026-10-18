// The Speaking Mirror phone page (/p/<code>?k=...): the phone is the microphone.
//   Drill     Web Speech -> transcript.final over the bridge (a provisional attempt); the page then
//             follows the attempt through Bee's verdict (sequenced hub events).
//   Practice  getUserMedia (AGC, noise suppression and echo cancellation off) -> the prosody engine
//             -> practice.meters at 10 Hz to the TV, then practice.summary. Interim Web Speech words
//             ride along as the caption. Nothing is recorded or stored.
//   Mic check can Web Speech and getUserMedia run at once on this phone? (src/miccheck.ts)
// Privacy: no localStorage or sessionStorage; the pair token stays in memory.
import { BridgeClient, normalizeCode, type IntentMsg } from "@rackboard/tv-voice-bridge";
import type { CardView, HubState, PracticeSummary } from "../../../src/hub/contract.js";
import { startCapture, captureSupported, type Capture } from "./audio.js";
import { WORDMARK } from "./brand.js";
import { envReport, reportText, runPhase } from "./miccheck.js";
import { ProsodyEngine, type MeterCore } from "./prosody.js";
import { listen, speechCtor, type Listener, type SpeechRec } from "./speech.js";
import { captionOf, countWords, meterFrame, newTakeId, parseJoin, takeSummary, wsUrl, type MicPhase, type MicVerdict } from "./take.js";

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

type Mode = "drill" | "practice" | "check";
function show(mode: Mode | "join") {
  for (const id of ["join", "drill", "practice", "check"]) $(id).hidden = id !== mode;
  $("tabs").hidden = mode === "join";
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
}

// Drill

function renderCard() {
  $("card-kicker").textContent = card ? `DRILL · ${card.habit?.label ?? card.type}` : "NO CARD OPEN";
  $("card-said").textContent = card?.said ?? "";
  $("card-fix").textContent = card ? `Say: ${card.resay || card.fix}` : "Start a drill: the TV and Alexa follow along.";
}

const stages: string[] = [];
function stage(cls: string, text: string, reset = false) {
  if (reset) stages.length = 0;
  stages.push(`<div class="${cls}">${esc(text)}</div>`);
  const el = $("pipeline");
  el.hidden = false;
  el.innerHTML = stages.join("");
}

function onEvent(topic: string, p: Record<string, any>) {
  if (topic === "hub.state") {
    const h = p as unknown as HubState;
    card = h.openCard;
    renderCard();
    $("foot").textContent = h.dataLabel && /synthetic/i.test(h.dataLabel) ? `${h.dataLabel}. Bee is the input of record.` : "Bee is the input of record: phone text is a provisional preview until Bee confirms it.";
    return;
  }
  if (topic === "card.open" || topic === "attempt.graded") {
    card = p.card ?? card;
    renderCard();
  }
  const id = p.attempt?.id ?? p.attemptId;
  if (!myAttempt || id !== myAttempt) return;
  if (topic === "attempt.status") stage("wait", "Checking with Bee (stream timed out, asking the Bee CLI)…");
  if (topic === "attempt.verified") stage(p.status === "verified" ? "bee" : "bad", p.status === "verified" ? `Verified by Bee (speaker ${p.speakerScore ?? "–"}, ${p.latencyMs ?? "–"} ms)` : `Not verified: ${p.reason}`);
  if (topic === "attempt.graded") {
    const a = p.attempt;
    stage(a.final?.pass ? "ok" : "bad", `Graded from Bee: ${a.final?.pass ? "PASS" : "FAIL"}${a.agreement === "bee-overrules" ? " (Bee overrules the preview)" : ""}`);
    const why = (a.final?.grade?.reasons ?? []).find((r: string) => r.startsWith("FAIL"));
    if (why) stage("dim", why);
  }
}

function onIntent(m: IntentMsg) {
  if (m.from !== client?.clientId) return;
  const p = (m.payload ?? {}) as Record<string, any>;
  if (m.name === "attempt.provisional") {
    myAttempt = p.attemptId ?? null;
    stage(p.provisionalPass ? "ok" : "bad", `Preview: ${p.provisionalPass ? "pass" : "fail"} (provisional)`, true);
    stage("wait", "Waiting for Bee to hear you…");
  } else if (m.name === "attempt.rejected") stage("bad", `Not sent: ${p.message ?? p.error ?? "open a card first"}`, true);
  else if (m.name === "practice.summary") $("take-state").textContent = m.ok ? `The TV has the summary (event ${p.seq}).` : `The hub refused the summary: ${p.message ?? p.error}`;
}

function sendUtterance(text: string, speechEndAt: number) {
  if (!client || !text.trim()) return;
  client.sendFinal(text.trim(), { speechEndAt });
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
  let rec: SpeechRec | null = null;
  let speechEnd = 0;
  let utteranceId = "";
  mic.onclick = () => {
    if (rec) return rec.stop();
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    utteranceId = `utt_${Date.now().toString(36)}`;
    mic.classList.add("live");
    $("mic-state").textContent = "Listening…";
    rec.onspeechend = () => (speechEnd = now());
    rec.onresult = (e) => {
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
    };
    rec.onerror = (e) => ($("mic-state").textContent = `Mic error: ${e.error}. Type below instead.`);
    rec.onend = () => {
      mic.classList.remove("live");
      $("mic-state").textContent = "Tap to try again.";
      rec = null;
      speechEnd = 0;
    };
    rec.start();
  };
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
  $("m-vol").textContent = `${f.rmsDbfs.toFixed(0)} dBFS · ${f.band}`;
  $("m-pitch").textContent = f.pitchHz ? `${Math.round(f.pitchHz)} Hz · ${f.pitchRangeSt.toFixed(1)} st${f.monotone ? " · flat" : ""}` : `– · ${f.pitchRangeSt.toFixed(1)} st`;
  $("m-rate").textContent = f.wpm === null ? "–" : `${f.wpm} wpm`;
  $("m-pause").textContent = `${f.pause.count}${f.pause.active ? " · pausing" : ""}`;
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
  $("take-state").textContent = `Recording nothing, metering everything. Mic at ${t.cap.sampleRate} Hz.${t.speechError ? ` Captions off (${t.speechError}).` : ""}`;
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
  r.innerHTML = `<div class="kicker">TAKE · ${(s.durationMs / 1000).toFixed(0)} s</div>
    <div>${s.volume.meanDbfs} dBFS mean · pitch ${s.pitch.medianHz ?? "–"} Hz, range ${s.pitch.rangeSt} st · ${s.rate.wpm ?? "–"} wpm · ${s.pauses.count} pause${s.pauses.count === 1 ? "" : "s"}</div>
    <div class="${s.flags.length ? "warn" : "dim"}">${s.flags.length ? `Flags: ${s.flags.join(", ")}` : "Nothing flagged."}</div>
    <div class="dim small">Phone-measured and provisional.${words ? ` ${words} words recognized.` : " No words recognized (captions off or silent)."}</div>`;
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
  el.innerHTML = `<div class="big-verdict">${pass ? "PASS" : pending ? "NOT YET" : "FAIL"}</div><div>${esc(howto)}</div><ul>${list(p1, "Part 1, speech then mic")}${list(p2, "Part 2, mic then speech")}</ul>`;
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
    $("check-state").textContent = `${order === "speech-then-mic" ? "Part 1" : "Part 2"} done: ${r.pass ? "PASS" : "FAIL"}.`;
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
  client = new BridgeClient({ url: wsUrl(location.protocol, location.host, join.k), role: "mic", code, name: "phone" });
  // The bridge client keeps retrying after a failed first connect, so a later `open` leaves the join view.
  client.on("open", () => {
    room = client?.code ?? code;
    setConn(`paired · ${room}`, "ok");
    if (!$("join").hidden) show("drill");
  });
  client.on("close", () => setConn("reconnecting…", "bad"));
  client.on("repair", () => {
    setConn("TV gone · scan the new QR", "bad");
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
    setConn("not paired", "bad");
    show("join");
    $("join").insertAdjacentHTML("beforeend", `<p class="warn">${esc((err as Error).message)}. Check the code on the TV${location.protocol === "https:" ? " and use the TV's QR link (it carries the pair token)" : ""}.</p>`);
  }
}

function setup() {
  document.title = "Speaking Mirror";
  document.querySelectorAll(".brand").forEach((el) => (el.textContent = WORDMARK));
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
    setConn("not paired");
    show("join");
  }
}

setup();
