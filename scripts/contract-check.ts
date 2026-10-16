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
//
//   npm run contract:check                       # exits 1 on any failed assertion
//   npm run contract:check -- --write-examples   # also writes docs/contract-examples.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";

type Ev = { topic: string; payload: Record<string, any> };
const PACE = 0.02;
const failures: string[] = [];
let passes = 0;
const check = (ok: unknown, what: string) => {
  if (ok) passes++;
  else failures.push(what);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ["--import", "tsx", "src/hub/server.ts", "--demo", "--port", "0", "--pace", String(PACE), "--state-dir", "out/contract-check"], { stdio: ["ignore", "pipe", "inherit"] });
const port: number = await new Promise((resolve, reject) => {
  const rl = createInterface({ input: child.stdout! });
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
function bridgeClient(role: "screen" | "mic", clientId: string, code?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

const sseEvents: Ev[] = [];
const sseAbort = new AbortController();
void (async () => {
  const r = await fetch(`${base}/api/events`, { signal: sseAbort.signal });
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
check(end.body.summary?.counted >= 3 && end.body.summary.unverified >= 1 && end.body.summary.beeOverrules >= 1, "session summary counts counted / unverified / bee-overrules");
await waitFor((e) => e.topic === "session.ended", "session.ended");
examples["WS session.started"] = tv.events.find((e) => e.topic === "session.started");
examples["WS session.ended"] = tv.events.find((e) => e.topic === "session.ended");

console.log("\nStats, transfer, brief, deck");
const week = await get("/api/stats?range=week", "GET /api/stats?range=week");
check(week.body.synthetic === true && week.body.source === "bee" && week.body.habits.hedges.per100 > 0 && week.body.habits.vague.per100 > 0 && week.body.sessions.every((s: any) => s.kind === "conversation"), "stats (week, source bee): synthetic label, hedges and vague rates, Bee sessions only");
const all = await get("/api/stats?range=all&source=all", "GET /api/stats?range=all&source=all");
check(all.body.sources.meeting?.label.includes("secondary") && all.body.talk?.meetings === 2, "stats source=all adds meetings, labelled secondary, with talk metrics");
const one = await get("/api/stats?range=session:demo-bee-1019");
check(one.body.sessions.length === 1, "stats range=session:<id>");
const tr = await get("/api/transfer", "GET /api/transfer");
const v = (k: string) => tr.body.habits.find((h: any) => h.habit === k)?.verdict;
check(tr.body.synthetic === true && v("hedges") === "dropped" && v("filler:like") === "dropped" && v("restart") === "no change", "transfer: drilled hedges and like dropped, control restarts no change (synthetic)");
check(tr.body.unregistered.some((u: any) => u.habit === "vague"), "transfer refuses unregistered drilled habits (vague listed, not reported as drilled)");
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

if (process.argv.includes("--write-examples")) {
  writeFileSync("docs/contract-examples.json", JSON.stringify({ note: "Generated by npm run contract:check -- --write-examples against the demo hub. SYNTHETIC demo data.", examples }, null, 1) + "\n");
  console.log("\nWrote docs/contract-examples.json");
}
sseAbort.abort();
tv.ws.close();
phone.ws.close();
child.kill("SIGTERM");
console.log(`\nCONTRACT CHECK: ${failures.length ? "FAIL" : "PASS"} (${passes} passed, ${failures.length} failed)`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
