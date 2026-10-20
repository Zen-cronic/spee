// Contract-check module for the live plugin (packet A), run by scripts/contract-check.ts against
// the demo hub (pace 0.02, state in out/contract-check). It asserts the plan's verification flow:
// live coaching on -> demo hedge streak -> nudge.sent (hops) -> a second streak inside the
// cooldown -> nudge.skipped (cooldown) -> 90 s idle -> conversation.ended -> recap.ready; then
// GET /api/recaps, /api/coach/now and /api/live reflect it; live.window is at most 1 per 3 s and
// carries no text; the TV, the phone and SSE saw the same sequence; the planted other-speaker line
// appears nowhere (events, responses, files); a short conversation skips its recap. It leaves live
// coaching on, as in the fixture story, for the modules that run after it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NUDGE_HOP_ORDER, RECAP_MOMENT_MAX_WORDS, WRIST_TEXT_MAX } from "../../src/hub/contract.js";
import { PLANTED_OTHER_MARKER } from "../../src/hub/live/demoScripts.js";
import type { CheckCtx, CheckResult, Ev } from "./types.js";

const STATE_DIR = "out/contract-check";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  const c = ctx.check;
  const seqOf = (e: Ev) => Number(e.payload.seq ?? 0);
  const until = async (pred: (e: Ev) => boolean, what: string, ms = 30_000): Promise<Ev | null> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const e = ctx.tv.events.find(pred);
      if (e) return e;
      await ctx.sleep(20);
    }
    c(false, `timed out waiting for ${what}`);
    return null;
  };

  console.log("\nv2: live coaching (packet A)");
  await ctx.post("/api/session/end", {}); // no drill in progress: nudges are suppressed while drilling
  const live0 = await ctx.get("/api/live", "GET /api/live (before)");
  c(live0.status === 200 && typeof live0.body.mode?.enabled === "boolean" && live0.body.wrist?.channel === "replay" && live0.body.synthetic === true, "GET /api/live: LiveState, replay wrist, synthetic");
  c(live0.body.baseline?.wpm === 140 && live0.body.baseline?.hedgesPer100 > 0 && /synthetic/.test(live0.body.baseline?.source), "baseline from the synthetic Bee week (140 wpm)");
  c((await ctx.post("/api/live/mode", {})).status === 400 && (await ctx.post("/api/live/mode", { enabled: true, minutes: 500 })).status === 400, "POST /api/live/mode: enabled required, minutes 1-180 (400 bad_request)");

  const seq0 = Math.max(0, ...ctx.tv.events.map(seqOf));
  const after = (e: Ev) => seqOf(e) > seq0;
  const on = await ctx.post("/api/live/mode", { enabled: true, minutes: 60, by: "check" }, "POST /api/live/mode (on)");
  c(on.status === 200 && on.body.mode?.enabled === true && on.body.mode.expiresAt - on.body.mode.since === 3_600_000 && /^Live coaching is on for 60 minutes\./.test(on.body.narration), "live mode on for 60 min, with narration");
  c(!!(await until((e) => after(e) && e.topic === "live.mode" && e.payload.mode?.enabled === true, "live.mode on")), "live.mode reaches the TV");

  c((await ctx.post("/api/demo/live", { script: "nope" })).status === 400, "POST /api/demo/live with an unknown script -> 400 bad_request");
  const demo = await ctx.post("/api/demo/live", { script: "story" }, "POST /api/demo/live (story)");
  const id: string = demo.body.conversationId;
  c(demo.status === 202 && demo.body.replay === true && /^demo-/.test(id) && demo.body.pace === ctx.pace && Array.isArray(demo.body.steps), "POST /api/demo/live -> 202 DemoLiveResponse (scaled steps)");
  const mine = (e: Ev) => after(e) && (e.payload.conversationId === id || e.payload.window?.conversationId === id || e.payload.nudge?.conversationId === id || e.payload.skip?.conversationId === id || e.payload.recap?.conversationId === id);

  const started = await until((e) => mine(e) && e.topic === "conversation.started", "conversation.started");
  const sent = await until((e) => mine(e) && e.topic === "nudge.sent", "nudge.sent");
  const skipped = await until((e) => mine(e) && e.topic === "nudge.skipped", "nudge.skipped");
  const ended = await until((e) => mine(e) && e.topic === "conversation.ended", "conversation.ended");
  const ready = await until((e) => mine(e) && e.topic === "recap.ready", "recap.ready");
  c(!!started && started.payload.replay === true, "conversation.started (replay)");
  const n = sent?.payload.nudge;
  c(n?.rule === "hedge-streak" && n.evidence?.over === true && n.evidence.value >= n.evidence.threshold, "hedge streak -> nudge.sent (rule hedge-streak, evidence over threshold)");
  c(typeof n?.text === "string" && n.text.startsWith("[coach] ") && n.text.length <= WRIST_TEXT_MAX && /^\[coach\] \d+ unsure words in 2 minutes\. Say it plainly\.$/.test(n.text), "nudge text is generated, <= 60 chars, never transcript text");
  const hops = n ? NUDGE_HOP_ORDER.map((k) => n.hops[k] as number) : [];
  c(n && hops.every((x) => typeof x === "number") && hops.every((x, i) => i === 0 || x >= hops[i - 1]!), "nudge hops spokenAt <= beeAt <= detectedAt <= todoAt <= alarmAt");
  c(n && n.latencyMs.bee === n.hops.beeAt - n.hops.spokenAt && n.latencyMs.detect === n.hops.detectedAt - n.hops.beeAt && n.latencyMs.todo === n.hops.todoAt - n.hops.detectedAt && n.latencyMs.total === n.hops.alarmAt - n.hops.spokenAt, "latencyMs are the hop differences");
  c(n?.wrist?.channel === "replay" && n.wrist.status === "replay" && n.wrist.leadMs === 10_000 && n.replay === true, "wrist: replay channel, 10 s alarm lead");
  const sk = skipped?.payload.skip;
  c(sk?.reason === "cooldown" && sk.rule === "hedge-streak" && sk.retryAfterMs > 0 && /nudges are at least 3 min apart/.test(sk.detail), "second streak inside 3 min -> nudge.skipped (cooldown, retryAfterMs)");
  c(ended?.payload.reason === "idle" && ended.payload.recap === "pending" && ended.payload.wearerWords >= 60 && typeof ended.payload.otherLines === "number", "90 s idle -> conversation.ended (idle, recap pending)");
  const recap = ready?.payload.recap;
  c(!!sent && !!skipped && !!ended && !!ready && seqOf(sent) < seqOf(skipped) && seqOf(skipped) < seqOf(ended) && seqOf(ended) < seqOf(ready), "order: nudge.sent < nudge.skipped < conversation.ended < recap.ready");
  c(recap?.phrasing === "template" && recap.nudges?.sent === 1 && recap.nudges.skipped >= 1 && recap.delivery?.wrist === "replay" && recap.synthetic === true, "recap.ready: template phrasing, nudges counted, replay delivery");
  c(recap?.moment && recap.moment.text.split(/\s+/).length <= RECAP_MOMENT_MAX_WORDS && recap.moment.rephrase && recap.wristText.startsWith("[coach] ") && recap.wristText.length <= WRIST_TEXT_MAX, "recap moment <= 12 wearer words with a rephrase; wrist text <= 60");
  c(recap?.metrics?.habits?.find((h: any) => h.key === "hedges")?.verdict === "worse" && /^Unsure words ran high/.test(recap.headline), "recap: hedges ran high against the baseline");

  // live.window throttle and privacy
  const wins = ctx.tv.events.filter((e) => e.topic === "live.window" && e.payload.window?.conversationId === id);
  const gaps = wins.slice(1).map((w, i) => w.payload.at - wins[i]!.payload.at);
  c(wins.length >= 2 && gaps.every((g) => g >= 3000), `live.window at most 1 per 3 s (${wins.length} windows, min gap ${gaps.length ? Math.min(...gaps) : "n/a"} ms)`);
  const strings: string[] = [];
  for (const w of wins) JSON.stringify(w.payload.window, (_k, v) => (typeof v === "string" && strings.push(v), v));
  c(strings.every((s) => /^(demo-[\w-]+|en|fr|mixed|hedge-streak|like-streak|monologue|fast-rate|count|ms|wpm)$/.test(s)), "live.window carries no transcript text (other speakers are counts)");

  // Reads
  const list = await ctx.get("/api/recaps?limit=5", "GET /api/recaps");
  c(list.status === 200 && list.body.recaps?.[0]?.id === recap?.id && list.body.synthetic === true, "GET /api/recaps: newest first");
  const one = await ctx.get(`/api/recaps/${recap?.id}`, "GET /api/recaps/<id>");
  c(one.status === 200 && JSON.stringify(one.body) === JSON.stringify(recap), "GET /api/recaps/<id> = the recap.ready payload");
  c((await ctx.get("/api/recaps/rcp_nope")).body?.error === "unknown_recap", "GET /api/recaps/<unknown> -> 404 unknown_recap");
  const now = await ctx.get("/api/coach/now", "GET /api/coach/now (after the story)");
  const sentences = String(now.body.narration ?? "").split(/(?<=\.)\s+/).filter(Boolean);
  c(now.body.basis === "recap" && now.body.lastRecap?.id === recap?.id && now.body.mode?.enabled === true && sentences.length <= 4 && /^Your last conversation ran high on unsure words/.test(now.body.narration) && / First signal, from one conversation and not proof: /.test(now.body.narration), "GET /api/coach/now reflects the recap, with the first signal (<= 4 sentences)");
  c(JSON.stringify((await ctx.get("/api/coach/now")).body.narration) === JSON.stringify(now.body.narration), "coachNow is deterministic");
  const live1 = await ctx.get("/api/live", "GET /api/live (after the story)");
  c(live1.body.lastRecapId === recap?.id && live1.body.lastNudge?.id === n?.id && live1.body.recentSkips?.[0]?.reason === "cooldown" && live1.body.mode?.sent?.lastHour >= 1, "GET /api/live: last nudge, skips and recap");

  // Same sequence on every surface
  const seqs = (evs: Ev[]) => evs.filter(mine).map((e) => `${seqOf(e)}:${e.topic}`).join(",");
  const tvSeq = seqs(ctx.tv.events);
  c(tvSeq.length > 0 && tvSeq === seqs(ctx.phone.events) && tvSeq === seqs(ctx.sse), "the TV, the phone and SSE saw the same live sequence");

  // Short conversation: no recap
  const short = await ctx.post("/api/demo/live", { script: "short" });
  const sid: string = short.body.conversationId;
  const sEnd = await until((e) => after(e) && e.topic === "conversation.ended" && e.payload.conversationId === sid, "short conversation.ended");
  c(sEnd?.payload.recap === "skipped-short", "a short conversation ends with recap skipped-short");
  await ctx.sleep(500);
  c(!ctx.tv.events.some((e) => e.topic === "recap.ready" && e.payload.recap?.conversationId === sid), "no recap.ready for the short conversation");

  // Mode off -> live.mode; then on again (the fixture story leaves it on)
  const off = await ctx.post("/api/live/mode", { enabled: false, by: "check" }, "POST /api/live/mode (off)");
  c(off.body.mode?.enabled === false && off.body.mode.reason === "off" && !!(await until((e) => after(e) && e.topic === "live.mode" && e.payload.mode?.enabled === false, "live.mode off")), "live mode off -> live.mode (reason off)");
  await ctx.post("/api/live/mode", { enabled: true, minutes: 60, by: "check" });

  // Conversation settings: the recap's setting, the wearer's correction, the per-setting line; the
  // pre-registered transfer does not move (src/hub/settings.ts)
  const tr0 = await ctx.get("/api/transfer");
  const sets = await ctx.get("/api/settings", "GET /api/settings");
  c(sets.status === 200 && sets.body.synthetic === true && ["work", "casual"].every((k) => sets.body.rates?.some((r: any) => r.setting === k)) && /^By setting · /.test(sets.body.line ?? ""), "GET /api/settings: work talk and casual rates, and one plain line for the TV");
  c(recap?.setting?.setting === "work" && recap.setting.source === "auto" && recap.metrics?.baselineSetting === "work" && / at work\./.test(recap.headline), "recap.ready: tagged work talk and compared with the usual at work");
  const seqS = Math.max(0, ...ctx.tv.events.map(seqOf));
  const setR = await ctx.post(`/api/sessions/${encodeURIComponent(recap?.conversationId ?? "none")}/setting`, { setting: "meeting" }, "POST /api/sessions/<id>/setting");
  c(setR.status === 200 && setR.body.tag?.setting === "meeting" && setR.body.tag.source === "you" && setR.body.recapIds?.includes(recap?.id), "POST /api/sessions/<id>/setting: the wearer's choice, on that recap");
  c(!!(await until((e) => seqOf(e) > seqS && e.topic === "stats.updated", "stats.updated after a setting change")), "a setting change publishes stats.updated (the screens refetch)");
  c((await ctx.get(`/api/recaps/${recap?.id}`)).body.setting?.setting === "meeting", "GET /api/recaps/<id> shows the wearer's setting");
  const tr1 = await ctx.get("/api/transfer");
  c(tr1.body.headline === tr0.body.headline && tr1.body.claim === tr0.body.claim && JSON.stringify(tr1.body.habits) === JSON.stringify(tr0.body.habits), "the pre-registered transfer (headline, claim, habits) is unchanged by settings");
  c((await ctx.post(`/api/sessions/${encodeURIComponent(recap?.conversationId ?? "none")}/setting`, { setting: null })).body.tag?.source === "auto" && (await ctx.post("/api/sessions/nope/setting", { setting: "work" })).status === 404 && (await ctx.post(`/api/sessions/${encodeURIComponent(recap?.conversationId ?? "none")}/setting`, { setting: "party" })).status === 400, "setting null goes back to automatic; unknown id 404; bad setting 400");

  // The planted other-speaker line appears nowhere
  const recent = await ctx.get("/api/events/recent");
  const seen = JSON.stringify([ctx.tv.events, ctx.phone.events, ctx.sse, recent.body, live1.body, now.body, list.body, sets.body, setR.body]);
  const dir = join(STATE_DIR, "live");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const onDisk = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  c(files.includes("recaps.json") && files.includes("nudges.json") && files.includes("settings.json"), `live state persisted under ${dir}/ (${files.join(", ")})`);
  c(!seen.includes(PLANTED_OTHER_MARKER) && !onDisk.includes(PLANTED_OTHER_MARKER) && !/4417/.test(onDisk), "the planted other-speaker line never reaches an event, a response or a file");

  return { name: "live", ...ctx.counts() };
}
