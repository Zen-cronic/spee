// Cross-surface contract check (docs/CONTRACT.md). Starts the hub in demo mode as a child
// process, connects a TV screen and a phone mic over the bridge WebSocket plus an SSE client
// (the Alexa simulator's path), and drives the flows phases 2 and 3 build on:
//   A  Alexa drill session: card opens, Alexa's text is a provisional preview, Bee confirms, Bee's text is graded
//   B  phone mic over the bridge: Bee hears an "um" the phone dropped, and Bee overrules the preview
//   C  stream silent: the fallback poll confirms the attempt
//   D  never tagged: the attempt ends "unverified" and does not count
//   E  Bee alone: no preview; the wearer-tagged line on the open card is graded
//   F  a negative control: an attempt that keeps the habit fails
//   G  two-turn Alexa drill: turn 1 returns pending at once, Bee's merged line lands at +16.5 s,
//      turn 2 (GET /api/attempts/<id>) gets the verdict; the extra sentence is not graded
// then checks stats, transfer (incl. the pre-registration refusal), brief, deck and session summary.
// Contract v2 (docs/CONTRACT.md "Contract v2"): plugins registered, every v2 route owned, the
// public-access gate (LAN vs proxy/public Host, /alexa, /p/, /mcp bearer, /ws k), static traversal
// refused, practice.meters never on SSE or recent events, the topic table matching contract.ts,
// fixture mode on a second hub, then each plugin's module in scripts/checks/{live,mirror,alexa,mcp}.ts.
//
//   npm run contract:check                       # exits 1 on any failed assertion
//   npm run contract:check -- --write-examples   # also writes docs/contract-examples.json
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { CONTRACT_VERSION, FIRST_SIGNAL_MIN_WORDS, INSTRUMENT_CLAIMS, INSTRUMENT_HABITS, ROOM_TOPICS, TRANSFER_CLAIMS, V1_TOPICS, V2_TOPICS } from "../src/hub/contract.js";
import { loadFixtureV2 } from "../src/hub/fixtureV2.js";
import { PLUGIN_NAMES } from "../src/hub/plugins.js";
import type { BridgeClient, CheckCtx, CheckResult } from "./checks/types.js";

type Ev = { topic: string; payload: Record<string, any> };
const PACE = 0.02;
const failures: string[] = [];
let passes = 0;
const check = (ok: unknown, what: string) => {
  if (ok) passes++;
  else failures.push(what);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TOKENS = { pair: randomBytes(18).toString("base64url"), mcp: randomBytes(18).toString("base64url") };
const hubEnv = { ...process.env, PAIR_TOKEN: TOKENS.pair, MCP_TOKEN: TOKENS.mcp, PUBLIC_BASE_URL: "", ALEXA_VERIFY_SIGNATURE: "", HUB_TRUST_LAN: "", HUB_ALLOWED_ORIGINS: "" };
// Every spawned hub is killed when this script exits, whether the checks passed, failed or threw.
const spawned: ChildProcess[] = [];
process.on("exit", () => spawned.forEach((c) => c.exitCode === null && c.kill("SIGKILL")));
const startHub = (args: string[]): { child: ChildProcess; port: Promise<number> } => {
  const c = spawn(process.execPath, ["--import", "tsx", "src/hub/server.ts", "--demo", "--port", "0", ...args], { stdio: ["ignore", "pipe", "inherit"], env: hubEnv });
  spawned.push(c);
  return { child: c, port: listeningPort(c) };
};
const listeningPort = (c: ChildProcess): Promise<number> => new Promise((resolve, reject) => {
  const rl = createInterface({ input: c.stdout! });
  const t = setTimeout(() => reject(new Error("hub did not start in 20 s")), 20_000);
  rl.on("line", (l) => {
    try {
      const o = JSON.parse(l);
      if (o.event === "hub.listening") {
        clearTimeout(t);
        resolve(o.port);
      }
    } catch {
      /* not a log line */
    }
  });
});
const main = startHub(["--pace", String(PACE), "--state-dir", "out/contract-check"]);
const child = main.child;
const port = await main.port;
const base = `http://127.0.0.1:${port}`;
const examples: Record<string, unknown> = {};
const get = async (p: string, key?: string) => {
  const r = await fetch(base + p);
  const j = await r.json();
  if (key) examples[key] = { request: `GET ${p}`, status: r.status, response: j };
  return { status: r.status, body: j as any };
};
const post = async (p: string, b: unknown = {}, key?: string) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const j = await r.json();
  if (key) examples[key] = { request: `POST ${p}`, body: b, status: r.status, response: j };
  return { status: r.status, body: j as any };
};

// Surfaces
function bridgeClient(role: "screen" | "mic", clientId: string, code?: string, opts: { query?: string; headers?: Record<string, string>; port?: number } = {}): BridgeClient {
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port ?? port}/ws${opts.query ?? ""}`, { headers: opts.headers });
  const events: Ev[] = [];
  const intents: any[] = [];
  let offset = 0;
  const welcome = new Promise<any>((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "welcome") {
        offset = m.serverTime - Date.now(); // hub clock offset (the demo clock runs in 2026-10-20)
        resolve(m);
      } else if (m.type === "app") events.push({ topic: m.topic, payload: m.payload });
      else if (m.type === "intent") intents.push(m);
    });
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role, clientId, name: clientId, ...(code ? { code } : {}) })));
  return { ws, events, intents, welcome, hubNow: () => Date.now() + offset };
}
const tv = bridgeClient("screen", "tv-mirror");
const tvWelcome = await tv.welcome;
const phone = bridgeClient("mic", "phone-1", tvWelcome.code);
await phone.welcome;

function sseClient(b: string) {
const sseEvents: Ev[] = [];
const sseAbort = new AbortController();
void (async () => {
  const r = await fetch(`${b}/api/events`, { signal: sseAbort.signal });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of r.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const topic = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (topic && data && topic !== "hub.state") sseEvents.push({ topic, payload: JSON.parse(data) });
      }
    }
  } catch {
    /* aborted */
  }
})();
return { sseEvents, sseAbort };
}
const { sseEvents, sseAbort } = sseClient(base);
await sleep(200);

const waitFor = async (pred: (e: Ev) => boolean, what: string, ms = 5000): Promise<Ev | null> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = tv.events.find(pred);
    if (e) return e;
    await sleep(20);
  }
  check(false, `timed out waiting for ${what}`);
  return null;
};
const topicsFor = (attemptId: string) => tv.events.filter((e) => e.payload.attempt?.id === attemptId || e.payload.attemptId === attemptId).map((e) => e.topic);

console.log(`Hub (demo, Bee replay pace ${PACE}) at ${base}; TV code ${tvWelcome.code}`);

console.log("\nHealth and hub.state");
const health = await get("/api/health", "GET /api/health");
check(health.body.mode === "demo" && /SYNTHETIC/.test(health.body.dataLabel) && /REPLAY/.test(health.body.beeStream), "health: demo mode labels synthetic data and Bee replay");
check(tv.events.some((e) => e.topic === "hub.state"), "a joining screen receives hub.state");
examples["WS hub.state"] = tv.events.find((e) => e.topic === "hub.state");

console.log("\nA: Alexa drill session, Bee confirms (stream)");
const start = await post("/api/session/start", { by: "alexa", size: 4 }, "POST /api/session/start");
const cardA = start.body.card;
check(start.status === 200 && cardA?.id, "session.start opens the first due card");
check((await waitFor((e) => e.topic === "card.open" && e.payload.card.id === cardA.id, "card.open A")) != null, "TV receives card.open");
const stA = await get("/api/session");
check(stA.body.state === "card_open" && stA.body.narration.includes(cardA.resay), "session state card_open narrates the target sentence");
const attA = await post("/api/attempt", { text: cardA.resay, source: "alexa", beeScenario: "verified" }, "POST /api/attempt");
check(attA.status === 202 && attA.body.attempt.status === "pending_bee" && attA.body.attempt.counted === false, "attempt is provisional: pending_bee, not counted");
const stPending = await get("/api/session", "GET /api/session (pending_bee)");
check(stPending.body.state === "pending_bee" && /checking with Bee/.test(stPending.body.narration) && stPending.body.verdictReady === false && stPending.body.retryAfterMs > 0, "voice UI state pending_bee: narrated, verdictReady false, retryAfterMs set");
const gA = await waitFor((e) => e.topic === "attempt.graded" && e.payload.attempt.id === attA.body.attempt.id, "graded A");
const vA = tv.events.find((e) => e.topic === "attempt.verified" && e.payload.attemptId === attA.body.attempt.id);
check(vA?.payload.status === "verified" && vA.payload.via === "stream" && vA.payload.replay === true && vA.payload.speakerScore >= 0.5, "attempt.verified: via stream, labelled replay, speaker score >= 0.5");
check(gA?.payload.attempt.counted && gA.payload.attempt.final.source === "bee" && gA.payload.attempt.final.pass === true, "attempt.graded: Bee's text graded, pass, counted");
check(gA?.payload.attempt.box?.to === gA?.payload.attempt.box?.from + 1, "schedule: a due card passing moves up one box");
await sleep(50);
check(JSON.stringify(topicsFor(attA.body.attempt.id)) === JSON.stringify(["attempt.provisional", "attempt.verified", "attempt.graded"]), `A event order provisional -> verified -> graded (got ${topicsFor(attA.body.attempt.id).join(" -> ")})`);
const statsAfterA = tv.events.findIndex((e) => e.topic === "stats.updated" && e.payload.seq > gA!.payload.seq);
check(statsAfterA >= 0, "stats.updated follows the graded attempt");
examples["WS card.open"] = tv.events.find((e) => e.topic === "card.open");
examples["WS attempt.provisional"] = tv.events.find((e) => e.topic === "attempt.provisional");
examples["WS attempt.verified"] = vA;
examples["WS attempt.graded"] = gA;
examples["WS stats.updated"] = tv.events[statsAfterA];
const stGraded = await get("/api/session", "GET /api/session (graded)");
check(stGraded.body.state === "graded" && /pass/.test(stGraded.body.narration), "voice UI state graded narrates the result");

console.log("\nB: phone mic over the bridge; Bee hears an 'um' and overrules the preview");
const nextB = await post("/api/session/next", {}, "POST /api/session/next");
const cardB = nextB.body.card;
check(cardB && cardB.id !== cardA.id, "session.next opens a different card");
await post("/api/demo/scenario", { scenario: "bee-hears-filler" }, "POST /api/demo/scenario");
phone.ws.send(JSON.stringify({ type: "transcript.final", utteranceId: "u_phone_1", text: cardB.resay, hops: [{ hop: "speech.end", at: phone.hubNow() }, { hop: "mic.send", at: phone.hubNow() }] }));
const provB = await waitFor((e) => e.topic === "attempt.provisional" && e.payload.attempt.provisional.source === "phone", "provisional B");
check(provB?.payload.attempt.provisional.grade.pass === true, "phone preview passes (the phone recognizer dropped the 'um')");
await sleep(100);
check(phone.intents.some((i) => i.name === "attempt.provisional" && i.payload.status === "pending_bee"), "the phone gets the bridge intent attempt.provisional (pending_bee)");
const gB = await waitFor((e) => e.topic === "attempt.graded" && e.payload.attempt.id === provB?.payload.attempt.id, "graded B");
check(gB?.payload.attempt.final.pass === false && gB.payload.attempt.agreement === "bee-overrules" && gB.payload.attempt.final.grade.fillers.includes("um"), "Bee wins: Bee's text has 'um', the final grade fails, agreement bee-overrules");
check(gB?.payload.attempt.box?.to === 1, "schedule: a fail drops the card to box 1");
examples["WS attempt.graded (bee-overrules)"] = gB;
examples["WS bridge intent attempt.provisional"] = phone.intents.find((i) => i.name === "attempt.provisional");

console.log("\nC: stream silent, the fallback poll confirms");
const nextC = await post("/api/session/next");
const cardC = nextC.body.card;
await post("/api/demo/scenario", { scenario: "poll" });
const attC = await post("/api/attempt", { text: cardC.resay, source: "alexa" });
const pollC = await waitFor((e) => e.topic === "attempt.status" && e.payload.attemptId === attC.body.attempt.id, "attempt.status polling");
check(pollC?.payload.status === "polling", "attempt.status: polling after the stream timeout");
const vC = await waitFor((e) => e.topic === "attempt.verified" && e.payload.attemptId === attC.body.attempt.id, "verified C");
check(vC?.payload.status === "verified" && vC.payload.via === "poll", "attempt.verified via poll");
const gC = await waitFor((e) => e.topic === "attempt.graded" && e.payload.attempt.id === attC.body.attempt.id, "graded C");
check(gC?.payload.attempt.counted === true, "poll-confirmed attempt is graded and counted");
examples["WS attempt.status"] = pollC;
examples["WS attempt.verified (poll)"] = vC;

console.log("\nD: never tagged -> unverified, not counted");
await post("/api/demo/scenario", { scenario: "untagged" });
const attD = await post("/api/attempt", { text: cardC.resay, source: "alexa" });
const vD = await waitFor((e) => e.topic === "attempt.verified" && e.payload.attemptId === attD.body.attempt.id, "verified D");
check(vD?.payload.status === "unverified" && /never tagged/.test(vD.payload.reason), "attempt.verified: unverified, reason 'never tagged'");
await sleep(150);
check(!tv.events.some((e) => e.topic === "attempt.graded" && e.payload.attempt.id === attD.body.attempt.id), "no attempt.graded for an unverified attempt");
const stD = await get("/api/session", "GET /api/session (unverified)");
check(stD.body.state === "unverified" && /doesn't count/.test(stD.body.narration), "voice UI state unverified");
examples["WS attempt.verified (unverified)"] = vD;

console.log("\nE: Bee alone (no preview)");
const nextE = await post("/api/session/next");
const cardE = nextE.body.card;
await post("/api/demo/bee", {}, "POST /api/demo/bee");
const gE = await waitFor((e) => e.topic === "attempt.graded" && e.payload.card.id === cardE?.id && e.payload.attempt.agreement === "bee-only", "graded E");
check(gE?.payload.attempt.provisional === null && gE?.payload.attempt.final.pass === true, "Bee-only attempt graded from Bee's text");

console.log("\nF: negative control (keeps the habit)");
const deck = await get("/api/deck", "GET /api/deck");
const hedge = deck.body.cards.find((c: any) => c.habit.kind === "hedge" && c.habit.targets.includes("i guess"));
await post("/api/card/open", { cardId: hedge.id, by: "contract-check" }, "POST /api/card/open");
await post("/api/demo/scenario", { scenario: "verified" });
const attF = await post("/api/attempt", { text: `I guess ${hedge.resay[0].toLowerCase()}${hedge.resay.slice(1)}`, source: "typed" });
check(attF.body.attempt.provisional.grade.pass === false && attF.body.attempt.provisional.grade.habit.found.includes("i guess"), "preview fails: the hedge 'I guess' was kept");
const gF = await waitFor((e) => e.topic === "attempt.graded" && e.payload.attempt.id === attF.body.attempt.id, "graded F");
check(gF?.payload.attempt.final.pass === false && gF.payload.attempt.final.grade.checks.find((c: any) => c.rule === "habit")?.ok === false, "final grade fails on the habit rule");

console.log("\nG: two-turn Alexa drill; Bee merges the attempt with the next words and lands at +16.5 s");
const stack = deck.body.cards.find((c: any) => c.id === "demo:hedge-stack");
await post("/api/card/open", { cardId: stack.id, by: "alexa" });
await post("/api/demo/scenario", { scenario: "merged" });
const t0 = Date.now();
const attG = await post("/api/attempt", { text: stack.resay, source: "alexa" }, "POST /api/attempt (turn 1)");
check(Date.now() - t0 < 1000 && attG.status === 202 && attG.body.attempt.status === "pending_bee" && attG.body.verdictUrl === `/api/attempts/${attG.body.attempt.id}`, "turn 1 returns at once: 202 pending_bee with verdictUrl (Alexa's 8 s limit)");
const early = await get(attG.body.verdictUrl, "GET /api/attempts/<id> (pending)");
check(early.body.verdictReady === false && early.body.status === "pending_bee" && early.body.retryAfterMs > 0, "turn 2 too early: verdictReady false, retryAfterMs");
const gG = await waitFor((e) => e.topic === "attempt.graded" && e.payload.attempt.id === attG.body.attempt.id, "graded G");
const late = await get(attG.body.verdictUrl, "GET /api/attempts/<id> (graded)");
check(late.body.verdictReady === true && late.body.attempt.final.pass === true && /pass/.test(late.body.narration), "turn 2 after Bee: the verdict is ready and narrated");
check(gG?.payload.attempt.bee.extraText === "How did I do?" && !/How did I do/.test(gG.payload.attempt.bee.gradedText), "the merged extra sentence is cut before grading (gradedText vs extraText)");
check(tv.events.some((e) => e.topic === "attempt.verified" && e.payload.attemptId === attG.body.attempt.id), "the TV got attempt.verified");
examples["WS attempt.graded (merged line)"] = gG;

console.log("\nSession end");
const end = await post("/api/session/end", {}, "POST /api/session/end");
const lineSum = Object.values((end.body.summary?.lines ?? {}) as Record<string, number>).reduce((x, y) => x + y, 0);
check(end.body.summary?.counted >= 3 && end.body.summary.unverified >= 1 && end.body.summary.beeOverrules >= 1 && lineSum === end.body.summary.cards && end.body.summary.lines?.passed <= end.body.summary.passed, "session summary counts counted / unverified / bee-overrules, and each line once (lines add up to cards)");
await waitFor((e) => e.topic === "session.ended", "session.ended");
examples["WS session.started"] = tv.events.find((e) => e.topic === "session.started");
examples["WS session.ended"] = tv.events.find((e) => e.topic === "session.ended");

console.log("\nStats, transfer, brief, deck");
const week = await get("/api/stats?range=week", "GET /api/stats?range=week");
check(week.body.synthetic === true && week.body.source === "bee" && week.body.habits.hedges.per100 > 0 && week.body.habits.vague.per100 > 0 && week.body.sessions.every((s: any) => s.kind === "conversation"), "stats (week, source bee): synthetic label, hedges and vague rates, Bee sessions only");
const all = await get("/api/stats?range=all&source=all", "GET /api/stats?range=all&source=all");
check(all.body.sources.meeting?.label.includes("secondary") && all.body.talk?.meetings === all.body.sources.meeting?.sessions && all.body.talk?.meetings >= 2, "stats source=all adds meetings, labelled secondary, with talk metrics");
const trAll = await get("/api/transfer?source=all", "GET /api/transfer?source=all");
check(trAll.body.source === "all" && trAll.body.sources.meeting?.sessions > 0 && /^\d{4}-\d{2}-\d{2}$/.test(trAll.body.sources.meeting?.from ?? ""), "transfer source=all: caption sessions counted with their earliest date (the TV's secondary line)");
const inst = await get("/api/instrument", "GET /api/instrument");
check(inst.body.synthetic === true && inst.body.pairs >= 1 && INSTRUMENT_CLAIMS.includes(inst.body.claim) && JSON.stringify(inst.body.habits.map((h: any) => h.habit)) === JSON.stringify(INSTRUMENT_HABITS) && !/demo-(bee|meet)-/.test(JSON.stringify(inst.body)), "instrument: Bee vs captions on meetings both heard, aggregates only (no session id), claim from INSTRUMENT_CLAIMS");
const one = await get("/api/stats?range=session:demo-bee-1019");
check(one.body.sessions.length === 1, "stats range=session:<id>");
const tr = await get("/api/transfer", "GET /api/transfer");
const v = (k: string) => tr.body.habits.find((h: any) => h.habit === k)?.verdict;
check(tr.body.synthetic === true && v("hedges") === "dropped" && v("filler:like") === "dropped" && v("restart") === "no change", "transfer: drilled hedges and like dropped, control restarts no change (synthetic)");
check(tr.body.claim === "all-dropped-control-flat" && /the one you didn't practise stayed the same/.test(tr.body.headline), "transfer: claim all-dropped-control-flat, as the headline says (synthetic)");
check(tr.body.unregistered.some((u: any) => u.habit === "vague"), "transfer refuses unregistered drilled habits (vague listed, not reported as drilled)");
const fsig = (tr.body.firstSignal ?? []) as any[];
check(JSON.stringify(fsig.map((f) => [f.habit, f.status])) === JSON.stringify([["hedges", "measured"], ["filler:like", "measured"]]) && fsig.every((f) => f.minWords === FIRST_SIGNAL_MIN_WORDS && f.before.words >= f.minWords && f.after.words >= f.minWords && f.after.startMs >= f.firstDrillAt && f.before.startMs < f.firstDrillAt && /not proof/.test(f.note)), "transfer: firstSignal per drilled habit, the conversation before vs the next after its first drill, labelled not proof (synthetic)");
check(!tr.body.unregistered.some((u: any) => ["hedge:i guess", "hedges", "filler:like", "fillers"].includes(u.habit)), "transfer: an 'I guess' drill counts under the registered umbrella 'hedges' (not listed as unregistered)");
const refuse = await get("/api/transfer?habit=vague", "GET /api/transfer?habit=vague");
check(refuse.status === 422 && refuse.body.error === "not_preregistered", "transfer?habit=vague -> 422 not_preregistered");
const one2 = await get("/api/transfer?habit=hedges", "GET /api/transfer?habit=hedges");
check(one2.status === 200 && one2.body.habits.length === 1 && one2.body.habits[0].habit === "hedges", "transfer?habit=hedges -> the one registered habit");
const brief = await get("/api/brief", "GET /api/brief");
check(brief.body.event?.title && brief.body.topHabit && brief.body.warmup && brief.body.nudge, "brief: next event, top habit, warm-up card, nudge");
check(brief.body.topHabit?.key === "hedges" && brief.body.warmup?.habit.kind === "hedge", "brief: the top habit is a hero habit (hedges) with a hedge warm-up card");
check(week.body.drilledVsNextSession.find((d: any) => d.habit === "vague")?.preregistered === false, "stats: drilled-vs-next-session flags habits that are not pre-registered");
check(week.body.drilledVsNextSession.find((d: any) => d.habit === "hedge:i guess")?.preregistered === true, "stats: a specific hedge counts as pre-registered under 'hedges'");
const next = await get("/api/deck/next", "GET /api/deck/next");
check("card" in next.body && next.body.summary.total === deck.body.summary.total, "deck/next");
await get("/api/attempts?limit=3", "GET /api/attempts?limit=3");

console.log("\nCross-surface sync");
await sleep(200);
const seqs = (es: Ev[]) => es.filter((e) => e.topic !== "hub.state").map((e) => `${e.payload.seq}:${e.topic}`);
check(JSON.stringify(seqs(tv.events)) === JSON.stringify(seqs(phone.events)), `TV and phone saw the same ${seqs(tv.events).length} events`);
check(JSON.stringify(seqs(tv.events)) === JSON.stringify(seqs(sseEvents)), "SSE (Alexa simulator path) saw the same events");
const s = seqs(tv.events).map((x) => Number(x.split(":")[0]));
check(s.every((x, i) => i === 0 || x > s[i - 1]!), "event seq strictly increasing");

// Contract v2

const raw = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}): Promise<{ status: number; text: string; headers: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: opts.port ?? port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t, headers: res.headers as Record<string, unknown> }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
const json = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const noTokens = (text: string) => !text.includes(TOKENS.pair) && !text.includes(TOKENS.mcp);
// A WebSocket attempt: "welcome" when the hub answers hello, "rejected" when the upgrade fails.
const wsOutcome = (query: string, headers: Record<string, string>, p = port): Promise<"welcome" | "rejected" | "timeout"> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws${query}`, { headers });
    const t = setTimeout(() => (ws.terminate(), resolve("timeout")), 3000);
    const done = (r: "welcome" | "rejected") => (clearTimeout(t), ws.terminate(), resolve(r));
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: `gate-${Math.random()}` })));
    ws.on("message", (d) => JSON.parse(String(d)).type === "welcome" && done("welcome"));
    ws.on("unexpected-response", () => done("rejected"));
    ws.on("error", () => done("rejected"));
  });
const NGROK = { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" };
const PUBLIC_HOST = "bee-coach-demo.ngrok-free.app";

console.log("\nv2: plugins and routes");
const h2 = await raw("/api/health");
const h2b = json(h2.text);
check(h2b?.contractVersion === CONTRACT_VERSION && CONTRACT_VERSION === 2, "health: contractVersion 2");
check(JSON.stringify(h2b?.plugins?.map((p: any) => p.name)) === JSON.stringify(PLUGIN_NAMES), `health lists the plugins in registry order (${PLUGIN_NAMES.join(", ")})`);
check(h2b?.plugins?.every((p: any) => Array.isArray(p.routes) && p.routes.length > 0 && ["stub", "ready", "degraded", "off"].includes(p.status)), "every plugin describes its routes and status");
check(h2b?.gate?.pairToken === "env" && h2b?.gate?.mcpToken === "env" && noTokens(h2.text), "health reports token sources, never the tokens");
check(typeof h2b?.masking === "string" && /^(off|on \(\d+ terms?\))$/.test(h2b.masking), `health reports display masking as on/off and a count only (${h2b?.masking})`);
const v2Routes: [string, string, unknown?][] = [
  ["GET", "/api/live"],
  ["POST", "/api/live/mode", {}],
  ["GET", "/api/recaps"],
  ["GET", "/api/recaps/rcp_not_a_recap"],
  ["GET", "/api/coach/now"],
  ["POST", "/api/demo/live", { script: "not-a-script" }],
  ["POST", "/api/demo/mirror", { script: "not-a-script" }],
  ["POST", "/alexa", {}],
  ["POST", "/mcp", {}],
];
const owned: string[] = [];
let tokenFree = true;
for (const [m, p, b] of v2Routes) {
  const r = await raw(p, { method: m, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: b === undefined ? undefined : JSON.stringify(b) });
  if (json(r.text)?.error !== "not_found") owned.push(`${m} ${p}`);
  tokenFree &&= noTokens(r.text);
}
check(owned.length === v2Routes.length, `every v2 route is owned by a plugin, never not_found (${owned.length}/${v2Routes.length})`);
check(tokenFree, "no v2 route response contains a token");

console.log("\nv2: public-access gate");
check((await raw("/api/health", { headers: { host: `127.0.0.1:${port}` } })).status === 200, "LAN (loopback Host, no proxy header) reaches /api/health");
const viaNgrok = await raw("/api/health", { headers: { ...NGROK, host: `127.0.0.1:${port}` } });
check(viaNgrok.status === 403 && json(viaNgrok.text)?.error === "forbidden", "x-forwarded-for (an ngrok request, even with a loopback Host) is public: /api/health -> 403 forbidden");
check((await raw("/api/stats", { headers: { host: PUBLIC_HOST } })).status === 403, "a public Host is public: /api/stats -> 403");
check((await raw("/api/events", { headers: { ...NGROK, host: PUBLIC_HOST } })).status === 403, "public SSE -> 403");
check((await raw("/tv/", { headers: { ...NGROK, host: PUBLIC_HOST } })).status === 403, "public /tv/ -> 403 (the TV is LAN only)");
check((await raw("/api/attempt", { method: "POST", headers: { ...NGROK, host: PUBLIC_HOST, "content-type": "application/json" }, body: "{}" })).status === 403, "public POST /api/attempt -> 403");
check((await raw("/alexa", { method: "POST", headers: { ...NGROK, host: PUBLIC_HOST, "content-type": "application/json" }, body: "{}" })).status !== 403, "public POST /alexa passes the gate");
check((await raw("/alexa", { headers: { ...NGROK, host: PUBLIC_HOST } })).status === 403, "public GET /alexa -> 403 (POST only)");
check((await raw("/p/HJ3H?k=x", { headers: { ...NGROK, host: PUBLIC_HOST } })).status !== 403, "public GET /p/<code> passes the gate");
check((await raw("/sim/", { headers: { ...NGROK, host: PUBLIC_HOST } })).status !== 403, "public GET /sim/ passes the gate");
const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const mcpHeaders = { ...NGROK, host: PUBLIC_HOST, "content-type": "application/json", accept: "application/json, text/event-stream" };
check((await raw("/mcp", { method: "POST", headers: mcpHeaders, body: mcpBody })).status === 403, "public /mcp without a bearer token -> 403");
check((await raw("/mcp", { method: "POST", headers: { ...mcpHeaders, authorization: "Bearer not-the-token" }, body: mcpBody })).status === 403, "public /mcp with a wrong bearer token -> 403");
check((await raw("/mcp", { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${TOKENS.mcp}` }, body: mcpBody })).status !== 403, "public /mcp with Bearer $MCP_TOKEN passes the gate");
check((await wsOutcome("", { ...NGROK })) === "rejected", "public /ws without k: upgrade refused");
check((await wsOutcome("?k=wrong", { ...NGROK })) === "rejected", "public /ws with a wrong k: upgrade refused");
check((await wsOutcome(`?k=${encodeURIComponent(TOKENS.pair)}`, { ...NGROK })) === "welcome", "public /ws with k=$PAIR_TOKEN: welcome");
check((await wsOutcome("", {})) === "welcome", "LAN /ws without k: welcome");
check(typeof tvWelcome.joinUrl === "string" && tvWelcome.joinUrl.endsWith(`/p/${tvWelcome.code}#k=${encodeURIComponent(TOKENS.pair)}`), "welcome.joinUrl is /p/<code>#k=<PAIR_TOKEN> (a fragment: never sent to a server)");

console.log("\nv2: Origin check (a web page the wearer visits cannot read or drive the hub)");
const EVIL = { origin: "https://evil.example" };
for (const [method, p] of [["GET", "/api/attempts?limit=200"], ["GET", "/api/events"], ["POST", "/api/session/start"], ["POST", "/mcp"], ["OPTIONS", "/api/attempt"]] as const) {
  const r = await raw(p, { method, headers: { ...EVIL, "content-type": "text/plain" }, body: method === "POST" ? "{}" : undefined });
  check(r.status === 403 && json(r.text)?.error === "forbidden_origin" && r.headers["access-control-allow-origin"] === undefined, `a foreign Origin from loopback: ${method} ${p} -> 403 forbidden_origin, no CORS header`);
}
const own = await raw("/api/health", { headers: { origin: base } });
check(own.status === 200 && own.headers["access-control-allow-origin"] === base, "the hub's own Origin is echoed (never *)");
check((await raw("/api/health")).headers["access-control-allow-origin"] === undefined, "no Origin (Alexa, MCP SDK, curl, Vega): served, no CORS header");
check((await wsOutcome("", { ...EVIL })) === "rejected", "/ws from a foreign Origin without k: upgrade refused (no events, no pair token)");
check((await wsOutcome(`?k=${encodeURIComponent(TOKENS.pair)}`, { ...EVIL })) === "welcome", "/ws from a foreign Origin with k=$PAIR_TOKEN: welcome");
const st = tv.events.find((e) => e.topic === "hub.state")?.payload;
check(typeof st?.bootId === "string" && st.bootId.startsWith("boot_") && typeof st?.lastSeq === "number", "hub.state on join carries bootId and lastSeq (restart detection)");

console.log("\nv2: static mounts refuse traversal");
const traversal = ["/p/..%2f..%2fpackage.json", "/p/%2e%2e/%2e%2e/package.json", "/p/..%252f..%252fpackage.json", "/tv/..%5c..%5cpackage.json", "/sim/%2e%2e%2fpackage.json", "/p/.env", "/p/../../package.json", "/sim/x/..%2f..%2f..%2fpackage.json"];
const leaked: string[] = [];
for (const t of traversal) {
  const r = await raw(t);
  if (r.status === 200 || r.text.includes('"name": "speaking-mirror"') || !(r.status === 400 || r.status === 404)) leaked.push(`${t} -> ${r.status}`);
}
check(!leaked.length, `static traversal refused (400 bad_path or 404) for ${traversal.length} paths${leaked.length ? `: ${leaked.join(", ")}` : ""}`);
const enc = await raw("/p/..%2f..%2fpackage.json");
check(enc.status === 400 && json(enc.text)?.error === "bad_path", "an encoded dot-segment under /p/ -> 400 bad_path");

console.log("\nv2: room-scoped practice.meters");
const meterFrame = { ...(loadFixtureV2()["practice-meters.json"].frames[0] as Record<string, unknown>), takeId: "take_contract_check" };
const sseBefore = sseEvents.length;
const phoneBefore = phone.events.length;
for (let i = 0; i < 3; i++) {
  phone.ws.send(JSON.stringify({ type: "app", topic: "practice.meters", payload: { ...meterFrame, frame: i } }));
  await sleep(60);
}
await sleep(300);
const recent2 = await get("/api/events/recent");
check(!sseEvents.slice(sseBefore).some((e) => e.topic === "practice.meters") && !JSON.stringify(recent2.body).includes("take_contract_check"), "practice.meters from the phone never reaches SSE or /api/events/recent");
check(!phone.events.slice(phoneBefore).some((e) => e.topic === "practice.meters"), "practice.meters never reaches a mic peer");

console.log("\nv2: topics match the doc");
const doc = readFileSync("docs/CONTRACT.md", "utf8");
const table = /<!-- topics:v2 -->([\s\S]*?)<!-- \/topics:v2 -->/.exec(doc)?.[1] ?? "";
const rows = [...table.matchAll(/^\| `([\w.]+)` \| (sequenced|room) \|/gm)].map((m) => ({ topic: m[1]!, kind: m[2]! }));
check(JSON.stringify(rows.filter((r) => r.kind === "sequenced").map((r) => r.topic)) === JSON.stringify(V2_TOPICS), "doc topic table: the sequenced v2 topics equal V2_TOPICS (same order)");
check(JSON.stringify(rows.filter((r) => r.kind === "room").map((r) => r.topic)) === JSON.stringify(ROOM_TOPICS), "doc topic table: the room topics equal ROOM_TOPICS");
check(V1_TOPICS.every((t) => doc.includes(`| \`${t}\` |`)), "every v1 topic is in the v1 event table");
const claimList = /\*\*Claim:\*\*([\s\S]*?)\*\*Verdicts:\*\*/.exec(doc)?.[1] ?? "";
check(JSON.stringify([...claimList.matchAll(/^- `([\w-]+)`:/gm)].map((m) => m[1])) === JSON.stringify(TRANSFER_CLAIMS), "doc claim list: every transfer claim equals TRANSFER_CLAIMS (same order)");
check(tv.events.every((e) => e.topic === "hub.state" || e.topic === "practice.meters" || (V1_TOPICS as readonly string[]).includes(e.topic) || (V2_TOPICS as readonly string[]).includes(e.topic)), "every event the TV received is a contract topic");

console.log("\nv2: fixture mode (a second hub: --demo --fixture-v2)");
const FX_PACE = 0.002;
const fxHub = startHub(["--fixture-v2", "--pace", String(FX_PACE), "--state-dir", "out/contract-check-fixture"]);
const fxPort = await fxHub.port;
const fxBase = `http://127.0.0.1:${fxPort}`;
const fx = loadFixtureV2();
const fxGet = async (p: string) => {
  const r = await fetch(fxBase + p);
  return { status: r.status, body: (await r.json()) as any };
};
const fxPost = async (p: string, b: unknown) => {
  const r = await fetch(fxBase + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: (await r.json()) as any };
};
const fxTv = bridgeClient("screen", "fx-tv", undefined, { port: fxPort });
const fxTvWelcome = await fxTv.welcome;
const fxPhone = bridgeClient("mic", "fx-phone", fxTvWelcome.code, { port: fxPort });
await fxPhone.welcome;
const fxSse = sseClient(fxBase);
await sleep(200);
check((await fxGet("/api/health")).body.fixtureV2 === true, "fixture hub: health fixtureV2 true");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check(same((await fxGet("/api/live")).body, fx["live.json"]), "fixture: GET /api/live = live.json");
check(same((await fxGet("/api/coach/now")).body, fx["coach-now.json"]), "fixture: GET /api/coach/now = coach-now.json");
check(same((await fxGet("/api/recaps")).body, fx["recaps.json"]), "fixture: GET /api/recaps = recaps.json");
check(same((await fxGet(`/api/recaps/${fx["recap.json"].id}`)).body, fx["recap.json"]), "fixture: GET /api/recaps/<id> = recap.json");
const fxMissing = await fxGet("/api/recaps/rcp_nope");
check(fxMissing.status === 404 && fxMissing.body.error === "unknown_recap", "fixture: an unknown recap id -> 404 unknown_recap");
const fxMode = await fxPost("/api/live/mode", { enabled: true, minutes: 60, by: "alexa" });
check(fxMode.status === 200 && same(fxMode.body, fx["live-mode-on.json"]), "fixture: POST /api/live/mode {enabled:true} = live-mode-on.json");
const fxDemo = await fxPost("/api/demo/live", { script: "story" });
check(fxDemo.status === 202 && fxDemo.body.conversationId === fx["demo-live.json"].conversationId && fxDemo.body.pace === FX_PACE, "fixture: POST /api/demo/live -> 202 demo-live.json (steps scaled by pace)");
const wantTopics = ["live.mode", ...fx["events-live.json"].events.map((e: any) => e.topic)];
const t0fx = Date.now();
while (fxSse.sseEvents.length < wantTopics.length && Date.now() - t0fx < 8000) await sleep(50);
check(same(fxSse.sseEvents.map((e) => e.topic), wantTopics), `fixture: SSE carries live.mode then the ${wantTopics.length - 1} story events in order`);
const fxSeq = (es: Ev[]) => es.filter((e) => e.topic !== "hub.state" && e.topic !== "practice.meters").map((e) => `${e.payload.seq}:${e.topic}`);
check(same(fxSeq(fxTv.events), fxSeq(fxSse.sseEvents)) && same(fxSeq(fxPhone.events), fxSeq(fxSse.sseEvents)), "fixture: TV, phone and SSE saw the same sequenced events");
const nudgeEv = fxSse.sseEvents.find((e) => e.topic === "nudge.sent");
check(nudgeEv && same(nudgeEv.payload.nudge, fx["events-live.json"].events.find((e: any) => e.topic === "nudge.sent").payload.nudge), "fixture: nudge.sent payload (with hops) = the fixture");
const fxSseBefore = fxSse.sseEvents.length;
const fxMirror = await fxPost("/api/demo/mirror", { room: fxTvWelcome.code });
check(fxMirror.status === 202 && fxMirror.body.frames === fx["practice-meters.json"].frames.length && fxMirror.body.rooms === 1, "fixture: POST /api/demo/mirror -> 202");
const t1fx = Date.now();
while (!fxSse.sseEvents.slice(fxSseBefore).some((e) => e.topic === "practice.summary") && Date.now() - t1fx < 5000) await sleep(50);
const meters = fxTv.events.filter((e) => e.topic === "practice.meters");
check(meters.length === fx["practice-meters.json"].frames.length && meters.every((m) => m.payload.seq === undefined && m.payload.from === "demo-phone"), `fixture: the TV got ${meters.length} practice.meters frames, unsequenced`);
check(!fxPhone.events.some((e) => e.topic === "practice.meters"), "fixture: the phone (mic) got no practice.meters");
const fxRecent = await fxGet("/api/events/recent");
check(!fxSse.sseEvents.some((e) => e.topic === "practice.meters") && !fxRecent.body.events.some((e: any) => e.topic === "practice.meters"), "fixture: practice.meters never on SSE or /api/events/recent");
check(same(fxSse.sseEvents.slice(fxSseBefore).map((e) => e.topic), ["mirror.focus", "practice.summary"]), "fixture: then mirror.focus and practice.summary, sequenced");
fxSse.sseAbort.abort();
fxTv.ws.close();
fxPhone.ws.close();
fxHub.child.kill("SIGTERM");

console.log("\nv2: plugin check modules");
const modules: CheckResult[] = [];
for (const name of ["live", "mirror", "alexa", "mcp"]) {
  let mp = 0;
  let mf = 0;
  const ctx: CheckCtx = {
    base,
    port,
    pace: PACE,
    tokens: TOKENS,
    get,
    post,
    raw: (p, o) => raw(p, o),
    check: (ok, what) => (ok ? mp++ : mf++, check(ok, `${name}: ${what}`), !!ok),
    counts: () => ({ passed: mp, failed: mf }),
    sleep,
    tv,
    phone,
    tvCode: tvWelcome.code,
    sse: sseEvents,
    waitFor,
    bridgeClient: (role, clientId, code, o) => bridgeClient(role, clientId, code, o),
    fixtures: fx,
    examples,
  };
  try {
    const mod = (await import(`./checks/${name}.ts`)) as { run(c: CheckCtx): Promise<CheckResult> };
    const r = await mod.run(ctx);
    modules.push(r);
    console.log(`  ${r.pending ? "pending" : "ran"}  ${r.name}: ${r.passed} passed, ${r.failed} failed${r.note ? ` (${r.note})` : ""}`);
  } catch (err) {
    check(false, `${name}: check module threw: ${(err as Error).message}`);
  }
}

if (process.argv.includes("--write-examples")) {
  writeFileSync("docs/contract-examples.json", JSON.stringify({ note: "Generated by npm run contract:check -- --write-examples against the demo hub. SYNTHETIC demo data.", examples }, null, 1) + "\n");
  console.log("\nWrote docs/contract-examples.json");
}
sseAbort.abort();
tv.ws.close();
phone.ws.close();
child.kill("SIGTERM");
const pendingMods = modules.filter((m) => m.pending).map((m) => m.name);
console.log(`\nCONTRACT CHECK: ${failures.length ? "FAIL" : "PASS"} (${passes} passed, ${failures.length} failed)${pendingMods.length ? `; plugin checks pending: ${pendingMods.join(", ")}` : ""}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
