// The live engine end to end on the demo hub, in fake time: Bee-shaped replay events go through
// the same parser and verifier as live ones, then window -> rules -> policy -> wrist -> events,
// and the recap at the end. Covers end detection (idle, Bee leaving CAPTURING, a new uuid), the
// short and French skips, suppressions, the wrist circuit, coachNow and the planted
// other-speaker line that must never reach an event or a file.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NUDGE_HOP_ORDER, WRIST_TEXT_MAX } from "../src/hub/contract.js";
import type { HubEvent } from "../src/hub/core.js";
import { DEMO_SCRIPTS, PLANTED_OTHER_MARKER, scheduleScript, type DemoScript } from "../src/hub/live/demoScripts.js";
import { BEE_DELETE_GRACE_MS, type LiveEngine } from "../src/hub/live/engine.js";
import { createLivePlugin } from "../src/hub/live/plugin.js";
import { BeeTodoWrist, type Wrist } from "../src/hub/live/wrist.js";
import type { PluginCtx } from "../src/hub/plugin.js";
import { demoSetup, type Setup } from "../src/hub/setup.js";

let setup: Setup;
let engine: LiveEngine;
let events: HubEvent[];
let dir: string;
let tick: NodeJS.Timeout;
let plugin: ReturnType<typeof createLivePlugin>;

function boot(opts: { wrist?: (ctx: PluginCtx) => Wrist } = {}) {
  dir = mkdtempSync(join(tmpdir(), "live-engine-"));
  setup = demoSetup({ pace: 1, stateDir: dir });
  events = [];
  setup.hub.on("event", (e: HubEvent) => events.push(e));
  const ctx = { hub: setup.hub, setup, stateDir: dir, pace: 1, demo: true, fixtureV2: false, log: () => {}, publish: (t: any, d: any) => setup.hub.publish(t, d) } as unknown as PluginCtx;
  plugin = createLivePlugin({ ...opts, onEngine: (e) => (engine = e) });
  plugin.attach!(ctx);
  tick = setInterval(() => void setup.hub.verifier.tick(), 100);
}
const topics = () => events.map((e) => e.topic).filter((t) => t !== "live.window");
const of = (t: string) => events.filter((e) => e.topic === t).map((e) => e.payload as any);
const play = async (script: DemoScript | keyof typeof DEMO_SCRIPTS, ms = 400_000) => {
  const s = typeof script === "string" ? DEMO_SCRIPTS[script] : script;
  const r = setup.demo!.replayConversation(scheduleScript(s));
  await vi.advanceTimersByTimeAsync(ms);
  await engine.settle();
  return r.conversationId;
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-20T17:30:00Z") });
});
afterEach(() => {
  clearInterval(tick);
  plugin?.stop?.();
  setup?.stop();
  setup?.hub.dispose();
  vi.useRealTimers();
});

describe("the story (live coaching on)", () => {
  it("hedge streak -> nudge.sent -> second streak -> nudge.skipped (cooldown) -> idle -> conversation.ended -> recap.ready", async () => {
    boot();
    engine.setMode({ enabled: true, by: "test" });
    const id = await play("story");
    expect(topics()).toEqual(["live.mode", "conversation.started", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready"]);
    const [n] = of("nudge.sent").map((p) => p.nudge);
    expect(n).toMatchObject({ conversationId: id, rule: "hedge-streak", wrist: { channel: "replay", status: "replay", todoId: null, leadMs: 10_000, error: null }, replay: true });
    expect(n.text).toMatch(/^\[coach\] \d hedges in 2 min\. Say it plainly\.$/);
    expect(n.text.length).toBeLessThanOrEqual(WRIST_TEXT_MAX);
    const hops = NUDGE_HOP_ORDER.map((k) => n.hops[k]);
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
    expect(n.latencyMs).toEqual({ bee: n.hops.beeAt - n.hops.spokenAt, detect: n.hops.detectedAt - n.hops.beeAt, todo: n.hops.todoAt - n.hops.detectedAt, total: n.hops.alarmAt - n.hops.spokenAt });
    expect(n.latencyMs.bee).toBe(5900);
    expect(n.latencyMs.todo).toBe(1450);
    expect(n.latencyMs.total).toBe(5900 + n.latencyMs.detect + 1450 + 10_000);
    const [s] = of("nudge.skipped").map((p) => p.skip);
    expect(s).toMatchObject({ rule: "hedge-streak", reason: "cooldown", conversationId: id });
    expect(s.retryAfterMs).toBeGreaterThan(0);
    expect(s.detail).toMatch(/^a nudge went out 1 min \d+ s ago; nudges are at least 3 min apart$/);
    const [ended] = of("conversation.ended");
    expect(ended).toMatchObject({ conversationId: id, reason: "idle", recap: "pending", replay: true, otherLines: 14 });
    expect(ended.wearerWords).toBeGreaterThan(150);
    const [{ recap }] = of("recap.ready");
    expect(recap).toMatchObject({ conversationId: id, phrasing: "template", nudges: { sent: 1, skipped: 1 }, delivery: { wrist: "replay", todoId: null }, synthetic: true, replay: true });
    expect(recap.moment).toMatchObject({ text: "I guess we could maybe ship the export on Friday.", rephrase: "We could ship the export on Friday." });
    expect(recap.headline).toMatch(/^Hedges ran high/);
    // live.window: at most one per 3 s per conversation, and never text
    const wins = events.filter((e) => e.topic === "live.window");
    for (let i = 1; i < wins.length; i++) expect(wins[i]!.payload.at - wins[i - 1]!.payload.at).toBeGreaterThanOrEqual(3000);
    expect(wins.at(-1)!.payload.window).toMatchObject({ others: { lines: expect.any(Number), words: expect.any(Number) }, skipped: { frenchLines: 1, drillLines: 0 } });
    // state, recaps and coachNow
    const st = engine.state();
    expect(st).toMatchObject({ conversation: null, lastRecapId: recap.id, mode: { enabled: true, sent: { lastHour: 1, today: 1 } }, wrist: { channel: "replay", healthy: true } });
    expect(st.recentNudges).toHaveLength(1);
    expect(st.recentSkips).toHaveLength(1);
    expect(engine.recap(recap.id)).toEqual(recap);
    const now = engine.coachNow();
    expect(now.basis).toBe("recap");
    expect(now.lastRecap).toEqual({ id: recap.id, endedAt: recap.endedAt, headline: recap.headline });
    expect(now.narration).toMatch(/^Your last conversation ran high on hedges: \d+, or \d\.\d per 100 words against your usual 1\.4\. This week you are at 1\.4 hedges per 100 words, and \d drills are due\. Live coaching is on until 2:30 PM\.$/);
    expect(now.narration.split(/(?<=\.)\s+/).length).toBe(3);
    expect(engine.coachNow().narration).toBe(now.narration); // deterministic
  });
  it("the planted other-speaker line never reaches an event, a recap or a file", async () => {
    boot();
    engine.setMode({ enabled: true });
    await play("story");
    expect(JSON.stringify(events)).not.toContain(PLANTED_OTHER_MARKER);
    expect(JSON.stringify(engine.state())).not.toContain(PLANTED_OTHER_MARKER);
    expect(JSON.stringify(engine.coachNow())).not.toContain(PLANTED_OTHER_MARKER);
    const files = readdirSync(join(dir, "live"));
    expect(files.sort()).toEqual(["nudges.json", "recaps.json"]);
    for (const f of files) expect(readFileSync(join(dir, "live", f), "utf8")).not.toMatch(/zebra|orchid|4417/);
    const recaps = JSON.parse(readFileSync(join(dir, "live", "recaps.json"), "utf8")).recaps;
    expect(recaps).toHaveLength(1);
  });
});

describe("other scripts and suppressions", () => {
  it("live coaching off: the streak is nudge.skipped (off), the recap still comes, and it stays off the wrist", async () => {
    boot();
    await play("story");
    expect(of("nudge.sent")).toHaveLength(0);
    expect(of("nudge.skipped").map((p) => p.skip.reason)).toEqual(["off", "off"]);
    expect(of("recap.ready")[0].recap.delivery).toEqual({ wrist: "off", todoId: null });
    expect(engine.coachNow().narration).toMatch(/Live coaching is off\.$/);
  });
  it("monologue: one nudge after 90 s of one turn", async () => {
    boot();
    engine.setMode({ enabled: true });
    await play("monologue");
    expect(of("nudge.sent").map((p) => p.nudge.rule)).toEqual(["monologue"]);
    expect(of("nudge.sent")[0].nudge.evidence.value).toBeGreaterThanOrEqual(90_000);
    expect(of("recap.ready")[0].recap.headline).toMatch(/^A long turn: \d\.\d minutes without a break\./);
  });
  it("short: under 60 wearer words -> conversation.ended recap skipped-short, no recap", async () => {
    boot();
    await play("short");
    expect(of("conversation.ended")[0]).toMatchObject({ recap: "skipped-short", reason: "idle" });
    expect(of("recap.ready")).toHaveLength(0);
  });
  it("French conversation: recap skipped-french", async () => {
    boot();
    const fr: DemoScript = { name: "short", description: "fr", lines: Array.from({ length: 8 }, () => ({ who: "ada" as const, text: "Oui, je pense que c'est bon pour vendredi, on se parle après le stand-up demain." })) };
    await play(fr);
    expect(of("conversation.ended")[0]).toMatchObject({ recap: "skipped-french" });
  });
  it("a drill in progress suppresses nudges (drill-active)", async () => {
    boot();
    engine.setMode({ enabled: true });
    setup.hub.startSession({ by: "test", size: 1 });
    await play("story");
    expect(of("nudge.skipped").map((p) => p.skip.reason)).toContain("drill-active");
    expect(of("nudge.sent")).toHaveLength(0);
  });
  it("Bee leaving CAPTURING ends the conversation after the delete grace (reason bee-state), before the idle timer", async () => {
    boot();
    const s = scheduleScript(DEMO_SCRIPTS.story);
    const { conversationId } = setup.demo!.replayConversation(s);
    await vi.advanceTimersByTimeAsync(s.lines[12]!.endMs + 6000);
    expect(of("conversation.started")).toHaveLength(1);
    setup.hub.ingestBee({ type: "update-conversation", conversation: { id: 1, conversation_uuid: "someone-else", state: "PROCESSING", start_time: null, end_time: null } });
    expect(of("conversation.ended")).toHaveLength(0); // another conversation's update is ignored
    setup.hub.ingestBee({ type: "update-conversation", conversation: { id: 99_000_101, conversation_uuid: conversationId, state: "CAPTURING", start_time: null, end_time: null } });
    expect(of("conversation.ended")).toHaveLength(0);
    const end = setup.hub.clock() - 1000;
    setup.hub.ingestBee({ type: "update-conversation", conversation: { id: 99_000_101, conversation_uuid: conversationId, state: "PROCESSING", start_time: null, end_time: new Date(end).toISOString() } });
    expect(of("conversation.ended")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BEE_DELETE_GRACE_MS - 1000);
    expect(of("conversation.ended")).toHaveLength(0); // Bee's last lines lag up to ~15 s: still this window (review M5)
    await vi.advanceTimersByTimeAsync(1000);
    expect(of("conversation.ended")[0]).toMatchObject({ conversationId, reason: "bee-state", endedAt: end, recap: "pending" });
    await vi.advanceTimersByTimeAsync(1000);
    await engine.settle();
    expect(of("recap.ready")).toHaveLength(1);
  });
  it("a new conversation uuid ends the current one (reason new-conversation)", async () => {
    boot();
    const s = scheduleScript(DEMO_SCRIPTS.story);
    setup.demo!.replayConversation(s);
    await vi.advanceTimersByTimeAsync(s.lines[14]!.endMs + 6000);
    setup.hub.ingestBee({ type: "new-conversation", conversation: { id: 5, conversation_uuid: "next-conv", start_time: null, state: "CAPTURING" } });
    expect(of("conversation.ended")[0]).toMatchObject({ reason: "new-conversation" });
  });
});

describe("mode expiry and state files", () => {
  it("a rule that fires after the mode ran out, before its timer, publishes live.mode off first", async () => {
    boot();
    engine.setMode({ enabled: true, minutes: 1, by: "test" });
    clearTimeout((engine as unknown as { expiryTimer: NodeJS.Timeout }).expiryTimer); // a late timer on a busy loop
    await play("story");
    expect(of("live.mode").map((p) => [p.mode.enabled, p.mode.reason])).toEqual([[true, "on"], [false, "expired"]]);
    const t = topics();
    expect(t.indexOf("live.mode", 1)).toBeLessThan(t.indexOf("nudge.skipped"));
    expect(of("nudge.skipped")[0].skip.reason).toBe("off");
  });
  it("a state folder that cannot be written never stops the events (logged once, kept in memory)", async () => {
    boot();
    rmSync(join(dir, "live"), { recursive: true, force: true });
    writeFileSync(join(dir, "live"), "not a directory");
    await play("story"); // live coaching is off: every streak is a skip, saved on the ingest path
    expect(of("nudge.skipped").length).toBeGreaterThan(0);
    expect(of("recap.ready")).toHaveLength(1);
    expect(engine.skips.length).toBe(of("nudge.skipped").length);
  });
});

describe("the wrist circuit", () => {
  it("3 failed creates open the circuit: live mode turns off (wrist-down) and the nudge reports failed", async () => {
    let w: BeeTodoWrist | null = null;
    boot({ wrist: (ctx) => (w = new BeeTodoWrist({ exec: async () => Promise.reject(new Error("bee: not logged in")), clock: ctx.hub.clock, ledgerPath: null, minGapMs: 10 })) });
    engine.setMode({ enabled: true });
    await play("story");
    const n = of("nudge.sent")[0].nudge;
    expect(n.wrist).toMatchObject({ channel: "bee-todo", status: "failed", todoId: null });
    expect(n.hops.todoAt).toBeNull();
    expect(n.latencyMs.total).toBeNull();
    expect(of("live.mode").map((p) => [p.mode.enabled, p.mode.reason])).toEqual([[true, "on"], [false, "wrist-down"]]);
    expect(of("nudge.skipped").at(-1).skip.reason).toBe("wrist-down");
    expect(w!.status().healthy).toBe(false);
    expect(plugin.describe!()).toMatchObject({ status: "degraded" });
    expect(existsSync(join(dir, "live", "todos.json"))).toBe(false);
  });
});
