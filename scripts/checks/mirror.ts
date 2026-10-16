// Contract-check module for the mirror plugin (packet B), run against the shared demo hub:
//   1. practice.meters from the phone reach the TV (its room's screen) only: never another room's
//      screen, the phone, SSE or /api/events/recent; frames are rebuilt from the contract fields.
//   2. practice.summary from the phone is sequenced, with the hub's room and from, and answered.
//   3. mirror.focus from the TV is sequenced with by = the TV's name.
//   4. POST /api/demo/mirror plays a metered synthetic take (60 frames at 10 Hz) to the room, then
//      practice.summary; {script:"focus"} publishes mirror.focus; bad requests get 400.
//   5. The TV, the phone and SSE saw the same sequenced mirror events (seq and topic).
import type { CheckCtx, CheckResult, Ev } from "./types.js";

const MIRROR_TOPICS = new Set(["practice.summary", "mirror.focus"]);

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  const { check, sleep } = ctx;
  const send = (ws: CheckCtx["tv"]["ws"], topic: string, payload: unknown, utteranceId?: string) => ws.send(JSON.stringify({ type: "app", topic, payload, ...(utteranceId ? { utteranceId, hops: [] } : {}) }));
  const until = async (pred: () => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await sleep(25);
    return pred();
  };
  const meters = (es: Ev[], takeId: string) => es.filter((e) => e.topic === "practice.meters" && e.payload.takeId === takeId);
  const recentText = async () => JSON.stringify((await ctx.get("/api/events/recent")).body);
  const sseFrom = ctx.sse.length;
  const tvFrom = ctx.tv.events.length;
  const phoneFrom = ctx.phone.events.length;

  const health = await ctx.get("/api/health");
  check(health.body.plugins?.find((p: any) => p.name === "mirror")?.status === "ready", "health: the mirror plugin is ready");

  // 1. meters, room-scoped
  const other = ctx.bridgeClient("screen", "tv-other-room");
  await other.welcome;
  const frame = ctx.fixtures["practice-meters.json"].frames[3];
  const take1 = "take_check_mirror_1";
  for (let i = 0; i < 8; i++) {
    send(ctx.phone.ws, "practice.meters", { ...frame, takeId: take1, frame: i, injected: "not a contract field" });
    await sleep(100);
  }
  await until(() => meters(ctx.tv.events, take1).length === 8, 3000);
  const got = meters(ctx.tv.events, take1);
  check(got.length === 8 && got.every((e, i) => e.payload.frame === i), `the TV got all 8 phone meter frames in order (${got.length})`);
  check(got.every((e) => e.payload.from === "phone-1" && e.payload.seq === undefined && !("injected" in e.payload)), "meter frames are stamped from=phone-1, unsequenced, rebuilt from the contract fields");
  check(meters(other.events, take1).length === 0, "another room's screen got none of the phone's meters");
  check(meters(ctx.phone.events, take1).length === 0, "the phone (mic) got none of its own meters back");
  check(!ctx.sse.slice(sseFrom).some((e) => e.topic === "practice.meters") && !(await recentText()).includes(take1), "meters never on SSE or /api/events/recent");
  send(ctx.phone.ws, "practice.meters", { ...frame, takeId: "take_check_bad", rmsDbfs: "loud" });
  send(ctx.tv.ws, "practice.meters", { ...frame, takeId: "take_check_from_tv" });
  await sleep(200);
  check(meters(ctx.tv.events, "take_check_bad").length === 0 && meters(ctx.tv.events, "take_check_from_tv").length === 0, "malformed frames and frames from a screen are not relayed");

  // 2. practice.summary
  const summary = { ...(ctx.fixtures["events-practice.json"].events[1].payload.summary as Record<string, unknown>), takeId: take1, room: "ZZZZ", from: "spoofed" };
  send(ctx.phone.ws, "practice.summary", summary, "u_check_summary");
  await until(() => ctx.sse.slice(sseFrom).some((e) => e.topic === "practice.summary" && e.payload.summary?.takeId === take1));
  const sumEv = ctx.sse.slice(sseFrom).find((e) => e.topic === "practice.summary" && e.payload.summary?.takeId === take1);
  check(!!sumEv && sumEv.payload.seq > 0 && sumEv.payload.summary.room === ctx.tvCode && sumEv.payload.summary.from === "phone-1" && sumEv.payload.summary.provisional === true, "practice.summary is sequenced with the hub's room and from (provisional)");
  await until(() => ctx.phone.intents.some((i) => i.utteranceId === "u_check_summary"));
  check(ctx.phone.intents.find((i) => i.utteranceId === "u_check_summary")?.ok === true, "the phone gets the practice.summary intent");
  ctx.examples["practice.summary (from the phone)"] = sumEv?.payload;
  ctx.examples["practice.meters (relayed to the TV)"] = got[3]?.payload;

  // 3. mirror.focus
  send(ctx.tv.ws, "mirror.focus", { view: "transfer", reason: "contract check" });
  await until(() => ctx.sse.slice(sseFrom).some((e) => e.topic === "mirror.focus" && e.payload.reason === "contract check"));
  const focusEv = ctx.sse.slice(sseFrom).find((e) => e.topic === "mirror.focus" && e.payload.reason === "contract check");
  check(focusEv?.payload.view === "transfer" && focusEv.payload.by === "tv-mirror", "mirror.focus from the TV is sequenced with by = its name");

  // 4. the demo take
  const demo = await ctx.post("/api/demo/mirror", { script: "practice-take", room: ctx.tvCode }, "POST /api/demo/mirror");
  check(demo.status === 202 && demo.body.frames === 60 && demo.body.hz === 10 && demo.body.rooms === 1 && demo.body.replay === true, `POST /api/demo/mirror -> 202 (${demo.body.frames} frames at ${demo.body.hz} Hz, ${demo.body.rooms} room)`);
  const takeId = demo.body.takeId as string;
  await until(() => ctx.sse.slice(sseFrom).some((e) => e.topic === "practice.summary" && e.payload.summary?.takeId === takeId), 10_000);
  const demoMeters = meters(ctx.tv.events, takeId);
  check(demoMeters.length === 60 && demoMeters.every((e) => e.payload.from === "demo-phone"), `the TV got the demo take's 60 meter frames (${demoMeters.length})`);
  const voiced = demoMeters.filter((e) => e.payload.voiced);
  check(voiced.length > 20 && voiced.every((e) => e.payload.pitchHz >= 70 && e.payload.pitchHz <= 400), `demo frames carry YIN pitch in 70-400 Hz (${voiced.length} voiced)`);
  check(demoMeters.at(-1)?.payload.pause.count === 2 && demoMeters.at(-1)?.payload.wpm > 0, "demo frames count the take's 2 pauses and estimate wpm");
  const demoSeq = ctx.sse.slice(sseFrom).filter((e) => (e.topic === "mirror.focus" && e.payload.takeId === takeId) || (e.topic === "practice.summary" && e.payload.summary?.takeId === takeId));
  check(demoSeq.map((e) => e.topic).join(",") === "mirror.focus,practice.summary" && demoSeq[1]?.payload.summary.frames === 60, "the demo publishes mirror.focus (practice) then practice.summary (60 frames)");
  check(meters(ctx.phone.events, takeId).length === 0 && meters(other.events, takeId).length === 0 && !ctx.sse.some((e) => e.topic === "practice.meters") && !(await recentText()).includes("practice.meters"), "demo meters reach the room's screen only (not the phone, another room, SSE or recent)");
  const f2 = await ctx.post("/api/demo/mirror", { script: "focus", view: "week" });
  await until(() => ctx.sse.slice(sseFrom).some((e) => e.topic === "mirror.focus" && e.payload.by === "demo" && e.payload.view === "week"));
  check(f2.status === 202 && ctx.sse.slice(sseFrom).some((e) => e.topic === "mirror.focus" && e.payload.by === "demo" && e.payload.view === "week"), "POST /api/demo/mirror {script:focus} -> 202 and mirror.focus");
  const bad = await ctx.post("/api/demo/mirror", { script: "nope" });
  const badView = await ctx.post("/api/demo/mirror", { script: "focus", view: "nope" });
  check(bad.status === 400 && bad.body.error === "bad_request" && badView.status === 400, "bad demo scripts and views -> 400 bad_request");

  // 5. identical sequenced streams
  await sleep(300);
  const seqs = (es: Ev[]) => es.filter((e) => MIRROR_TOPICS.has(e.topic)).map((e) => `${e.payload.seq}:${e.topic}`).join(" ");
  const sseSeq = seqs(ctx.sse.slice(sseFrom));
  check(sseSeq.length > 0 && seqs(ctx.tv.events.slice(tvFrom)) === sseSeq && seqs(ctx.phone.events.slice(phoneFrom)) === sseSeq, "the TV, the phone and SSE saw the same sequenced mirror events");
  other.ws.close();
  return { name: "mirror", ...ctx.counts() };
}
