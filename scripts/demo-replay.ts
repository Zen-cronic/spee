// The whole live-coaching story with no Bee, no Watch and no AWS, printing a hop timeline: the
// filming beats. It starts the demo hub in-process (synthetic wearer "Ada", Bee-shaped replay
// events, the replay wrist), turns live coaching on, replays the scripted conversation(s), and
// prints each event in story time with the nudge's latency hops, the recap and "how am I doing?".
//
//   npm run demo:replay                              # the story at pace 0.05 (about 15 s)
//   npm run demo:replay -- --pace 1                  # real time (about 5 minutes)
//   npm run demo:replay -- --script all              # story, monologue, short
//
// Times are story times (hub ms / pace). Exit code 1 when an expected beat is missing.
import { randomBytes } from "node:crypto";
import type { HubEvent } from "../src/hub/core.js";
import { PLANTED_OTHER_MARKER } from "../src/hub/live/demoScripts.js";
import { startHubServer } from "../src/hub/server.js";

const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const pace = Number(opt("--pace") ?? 0.05);
const which = opt("--script") ?? "story";
const scripts = which === "all" ? ["story", "monologue", "short"] : [which];
if (!(pace > 0 && pace <= 1) || scripts.some((s) => !["story", "monologue", "short"].includes(s))) {
  console.error("usage: npm run demo:replay -- [--pace 0.05] [--script story|monologue|short|all]");
  process.exit(2);
}

const hub = await startHubServer({ demo: true, pace, port: 0, host: "127.0.0.1", quiet: true, stateDir: opt("--state-dir") ?? "out/demo-replay", pairToken: randomBytes(18).toString("base64url"), mcpToken: randomBytes(18).toString("base64url"), publicBaseUrl: null });
const events: HubEvent[] = [];
let t0 = Date.now();
const story = (realMs: number) => `${(realMs / pace / 1000).toFixed(1).padStart(6)} s`;
const dur = (hubMs: number | null) => (hubMs == null ? "  n/a" : `${(hubMs / pace / 1000).toFixed(2)} s`);
const sentences = (s: string) => s.split(/(?<=\.)\s+/);

hub.setup.hub.on("event", (e: HubEvent) => {
  events.push(e);
  const p = e.payload as any;
  const at = story(Date.now() - t0);
  switch (e.topic) {
    case "live.mode":
      return console.log(`${at}  live.mode           ${p.mode.enabled ? "ON" : "off"} (${p.mode.reason}, by ${p.mode.by})`);
    case "conversation.started":
      return console.log(`${at}  conversation.started ${p.conversationId}`);
    case "live.window": {
      const w = p.window;
      const hedge = w.rules.find((r: any) => r.rule === "hedge-streak");
      return console.log(`${at}  live.window         ${w.wearer.words} words, ${w.wearer.wpm ?? "-"} wpm, talk share ${w.talkShare ?? "-"}, hedges in 2 min ${hedge.value}/${hedge.threshold}, others ${w.others.lines} lines (counts only)`);
    }
    case "nudge.sent": {
      const n = p.nudge;
      console.log(`${at}  nudge.sent          ${n.rule}: "${n.text}"  (wrist: ${n.wrist.channel}, ${n.wrist.status})`);
      console.log(`           hops: spoken -> Bee tag ${dur(n.latencyMs.bee)} -> detected ${dur(n.latencyMs.detect)} -> to-do ${dur(n.latencyMs.todo)} -> alarm ${dur(n.hops.alarmAt - n.hops.todoAt)}`);
      return console.log(`           the Watch buzzes ${dur(n.latencyMs.total)} after the wearer stopped speaking`);
    }
    case "nudge.skipped":
      return console.log(`${at}  nudge.skipped       ${p.skip.rule}: ${p.skip.reason} (${p.skip.detail})`);
    case "conversation.ended":
      return console.log(`${at}  conversation.ended  ${p.reason}; ${p.wearerWords} wearer words, ${p.otherLines} other lines; recap ${p.recap}`);
    case "recap.ready": {
      const r = p.recap;
      console.log(`${at}  recap.ready         ${r.headline}`);
      for (const s of sentences(r.narration)) console.log(`           | ${s}`);
      return console.log(`           wrist: "${r.wristText}" (${r.delivery.wrist}); moment: ${r.moment ? `"${r.moment.text}" -> "${r.moment.rephrase}"` : "none"}`);
    }
  }
});

const post = (p: string, b: unknown) => fetch(hub.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
const get = (p: string) => fetch(hub.url + p).then((r) => r.json() as Promise<any>);
const waitFor = async (pred: (e: HubEvent) => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const e = events.find(pred);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};

console.log(`Live coaching demo replay (SYNTHETIC wearer "Ada"; no Bee, no Watch, no AWS). Pace ${pace}: times below are story times.\n`);
const missing: string[] = [];
t0 = Date.now();
console.log(`${story(0)}  "Alexa, turn on live coaching."`);
await post("/api/live/mode", { enabled: true, minutes: 60, by: "demo-replay" });
for (const script of scripts) {
  t0 = Date.now();
  const r = await post("/api/demo/live", { script });
  console.log(`\n--- ${script}: ${r.conversationId}\n    ${r.description}\n`);
  const id = r.conversationId as string;
  const want = script === "short" ? ["conversation.ended"] : ["conversation.started", "nudge.sent", "conversation.ended", "recap.ready"];
  if (script === "story") want.splice(2, 0, "nudge.skipped");
  const last = await waitFor((e) => e.topic === want.at(-1) && ((e.payload as any).conversationId ?? (e.payload as any).recap?.conversationId) === id, (420_000 * pace) + 15_000);
  if (!last) missing.push(`${script}: ${want.at(-1)}`);
  for (const t of want) if (!events.some((e) => e.topic === t && JSON.stringify(e.payload).includes(id))) missing.push(`${script}: ${t}`);
}

const now = await get("/api/coach/now");
console.log(`\n"Alexa, how am I doing?" (GET /api/coach/now, basis ${now.basis}):`);
for (const s of sentences(now.narration)) console.log(`  | ${s}`);
const live = await get("/api/live");
console.log(`\nGET /api/live: ${live.recentNudges.length} nudge(s), ${live.recentSkips.length} skip(s), last recap ${live.lastRecapId}, wrist ${live.wrist.channel}`);
const leaked = JSON.stringify(events).includes(PLANTED_OTHER_MARKER) || JSON.stringify([now, live]).includes(PLANTED_OTHER_MARKER);
console.log(`Planted other-speaker line seen anywhere: ${leaked ? "YES (privacy failure)" : "no"}`);
await hub.close();
if (missing.length || leaked) {
  console.log(`\nDEMO REPLAY: FAIL (${[...missing, ...(leaked ? ["planted line leaked"] : [])].join("; ")})`);
  process.exit(1);
}
console.log("\nDEMO REPLAY: PASS");
