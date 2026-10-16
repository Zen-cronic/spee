// Alexa+ simulator (/sim/): a real MCP client (SDK Client over Streamable HTTP) driving the same
// two-turn Bee-graded drill as the Alexa skill. Mic via Web Speech, voice via speechSynthesis; the
// keyword router (router.ts) stands in for Alexa+'s model. The MCP token comes from the URL
// fragment (#t=<MCP_TOKEN>, never sent to a server) or a prompt; on the LAN no token is needed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolName } from "../../../src/hub/contract.js";
import { Dialog, type ToolReply, type Turn } from "./dialog.js";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TOKEN_KEY = "speech-coach-sim-token";
const LOG_MAX = 60;

const isLanHost = (h: string) =>
  h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h === "[::1]" || h.endsWith(".local") || h.endsWith(".home.arpa");
const onLan = isLanHost(location.hostname);

function token(): string | null {
  const m = /(?:^|[#&])t=([^&]+)/.exec(location.hash);
  if (m) {
    const t = decodeURIComponent(m[1]!);
    sessionStorage.setItem(TOKEN_KEY, t);
    history.replaceState(null, "", location.pathname + location.search); // keep it out of screenshots
    return t;
  }
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) return saved;
  if (onLan) return null;
  const asked = prompt("MCP token (the hub prints MCP_TOKEN at startup)")?.trim();
  if (asked) sessionStorage.setItem(TOKEN_KEY, asked);
  return asked || null;
}

// JSON-RPC log
function logLine(list: HTMLOListElement, cls: string, head: string, body: unknown) {
  const li = document.createElement("li");
  li.className = cls;
  const h = document.createElement("div");
  h.className = "h";
  h.textContent = `${new Date().toLocaleTimeString()}  ${head}`;
  const pre = document.createElement("pre");
  pre.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  li.append(h, pre);
  list.prepend(li);
  while (list.children.length > LOG_MAX) list.lastElementChild?.remove();
}
const rpcList = $<HTMLOListElement>("rpc");
const loggingFetch: typeof fetch = async (input, init) => {
  let sent: any = null;
  try {
    sent = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  } catch {
    sent = init?.body ?? null;
  }
  if (sent) logLine(rpcList, "out", `-> ${sent.method ?? "?"}${sent.params?.name ? ` ${sent.params.name}` : ""}`, sent);
  const res = await fetch(input, init);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    res
      .clone()
      .json()
      .then((j) => logLine(rpcList, j?.error || j?.result?.isError ? "in err" : "in", `<- ${res.status}${j?.result?.isError ? " isError" : ""}`, j))
      .catch(() => undefined);
  } else if (res.status !== 202) logLine(rpcList, res.ok ? "in" : "in err", `<- ${res.status} ${type || "(no body)"}`, "");
  return res;
};

// MCP client
const conn = $("conn");
const connText = $("conn-text");
let client: Client | null = null;
async function connect(): Promise<Client> {
  if (client) return client;
  const t = token();
  const headers: Record<string, string> = { "ngrok-skip-browser-warning": "1" };
  if (t) headers.authorization = `Bearer ${t}`;
  const c = new Client({ name: "speech-coach-sim", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.origin), { requestInit: { headers }, fetch: loggingFetch });
  try {
    await c.connect(transport);
  } catch (err) {
    conn.className = "dot err";
    connText.textContent = /403/.test(String(err)) ? "MCP refused the token (reload with #t=<MCP_TOKEN>)" : `MCP connect failed: ${(err as Error).message}`;
    if (/403/.test(String(err))) sessionStorage.removeItem(TOKEN_KEY);
    throw err;
  }
  const tools = await c.listTools();
  conn.className = "dot on";
  connText.textContent = `MCP connected: ${tools.tools.length} tools${t ? "" : " (LAN, no token)"}`;
  client = c;
  return c;
}

const callTool = async (name: McpToolName, args: Record<string, unknown>): Promise<ToolReply> => {
  const c = await connect();
  const r = await c.callTool({ name, arguments: args });
  const content = (r.content as { type: string; text?: string }[] | undefined) ?? [];
  return { text: content.filter((x) => x.type === "text").map((x) => x.text).join(" "), structured: (r.structuredContent as Record<string, any>) ?? null, isError: !!r.isError };
};
const dialog = new Dialog(callTool);

// Voice out
const voiceOn = $<HTMLInputElement>("voice");
function speak(text: string) {
  if (!voiceOn.checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

// Turns
const turns = $<HTMLOListElement>("turns");
function addTurn(who: "you" | "coach", text: string, meta?: string) {
  const li = document.createElement("li");
  li.className = who;
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = text;
  li.append(t);
  if (meta) {
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = meta;
    li.append(m);
  }
  turns.append(li);
  li.scrollIntoView({ block: "end", behavior: "smooth" });
}
function showCard(text: string | null) {
  $("card").hidden = !text;
  $("card-text").textContent = text ?? "";
}
function showLabel(label: string | null) {
  if (!label) return;
  const el = $("data-label");
  el.hidden = false;
  el.textContent = label;
}

let busy = false;
async function say(text: string, via: "typed" | "mic") {
  const heard = text.trim();
  if (!heard || busy) return;
  busy = true;
  addTurn("you", heard, via === "mic" ? "heard by the browser mic (provisional)" : "typed (provisional)");
  try {
    const turn: Turn = await dialog.handle(heard);
    const meta = turn.routed.kind === "tool" ? `router: "${turn.routed.rule}" -> ${turn.calls.join(" -> ")}` : `router: ${turn.routed.rule}`;
    addTurn("coach", turn.speech, meta);
    showCard(turn.card);
    showLabel(turn.dataLabel);
    speak(turn.speech);
  } catch (err) {
    addTurn("coach", "I couldn't reach the coach hub.", (err as Error).message);
  } finally {
    busy = false;
  }
}

$<HTMLFormElement>("say").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("text");
  void say(input.value, "typed");
  input.value = "";
});
for (const b of document.querySelectorAll<HTMLButtonElement>("#quick button")) b.addEventListener("click", () => void say(b.dataset.say ?? "", "typed"));

// Mic in (Web Speech)
type Recognition = { lang: string; interimResults: boolean; maxAlternatives: number; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; start(): void; stop(): void };
const Rec = ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;
const micBtn = $<HTMLButtonElement>("mic");
if (!Rec) {
  micBtn.disabled = true;
  micBtn.title = "This browser has no Web Speech recognition; type instead";
} else {
  let rec: Recognition | null = null;
  micBtn.addEventListener("click", () => {
    if (rec) return rec.stop();
    speechSynthesis?.cancel();
    rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    micBtn.classList.add("live");
    micBtn.textContent = "Listening";
    rec.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript ?? "";
      void say(text, "mic");
    };
    rec.onerror = (e) => addTurn("coach", "The mic didn't catch that.", String(e?.error ?? "error"));
    rec.onend = () => {
      rec = null;
      micBtn.classList.remove("live");
      micBtn.textContent = "Mic";
    };
    rec.start();
  });
}

// Hub events (SSE): LAN only; through a tunnel the gate exposes /mcp alone.
const sseList = $<HTMLOListElement>("sse");
const sseState = $("sse-state");
if (onLan && "EventSource" in window) {
  const es = new EventSource("/api/events");
  const topics = ["session.started", "card.open", "attempt.provisional", "attempt.status", "attempt.verified", "attempt.graded", "stats.updated", "session.ended", "conversation.started", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready", "live.mode", "mirror.focus", "practice.summary"];
  es.onopen = () => (sseState.textContent = "SSE /api/events (live)");
  es.onerror = () => (sseState.textContent = "SSE /api/events (reconnecting)");
  for (const t of topics)
    es.addEventListener(t, (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      const brief =
        t === "attempt.verified"
          ? { seq: d.seq, status: d.status, via: d.via, speakerScore: d.speakerScore, latencyMs: d.latencyMs, replay: d.replay }
          : t === "attempt.graded"
            ? { seq: d.seq, final: d.attempt?.final?.pass ? "pass" : "fail", agreement: d.attempt?.agreement, box: d.attempt?.box }
            : t === "card.open"
              ? { seq: d.seq, card: d.card?.id, by: d.by }
              : { seq: d.seq };
      logLine(sseList, "ev", t, brief);
    });
} else sseState.textContent = "SSE feed is LAN-only (through the tunnel the simulator uses /mcp alone)";

addTurn("coach", 'Say "quiz me" to start a drill.', "simulator ready");
void connect().catch(() => undefined);
