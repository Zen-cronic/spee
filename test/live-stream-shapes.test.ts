// End-of-conversation evidence from a real `bee stream --types all` capture (2026-10-16, text
// stripped), replayed here as SYNTHETIC lines of the same shapes (invented ids and text):
//   - update-conversation {conversation: {id, start_time, end_time (set when recording stops),
//     conversation_uuid, device_type, state: "PROCESSING", summary: null, ...}}
//   - delete-conversation, same object, about 0.4 s later (Bee discarded the conversation)
//   - todo-deleted {todo: {id, conversationId, text, completed, alarmAt, appleId}}
//   - a keepalive line {timestamp} with no type
// Every line goes through parseStreamLine and the hub's verifier, as on the live stream.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStreamLine } from "../src/hub/bee.js";
import type { HubEvent } from "../src/hub/core.js";
import { BEE_DELETE_GRACE_MS, type LiveEngine } from "../src/hub/live/engine.js";
import { createLivePlugin } from "../src/hub/live/plugin.js";
import { BeeTodoWrist, type ExecFn } from "../src/hub/live/wrist.js";
import type { PluginCtx } from "../src/hub/plugin.js";
import { demoSetup, type Setup } from "../src/hub/setup.js";

let setup: Setup;
let engine: LiveEngine;
let events: HubEvent[];
let dir: string;
let tick: NodeJS.Timeout;
let wrist: BeeTodoWrist;
let todoN = 71_000_000;

const ADA = [
  "The billing export finished on Monday and the totals match the ledger.",
  "I guess we could maybe ship the export on Friday afternoon.",
  "I think the retry logic is kind of ready for the review.",
  "We moved the release of the mobile build to Friday afternoon.",
  "The search page loads in two seconds on the staging server now.",
  "Support closed forty tickets this week, mostly password resets.",
  "I will send the release notes to the sales team tomorrow.",
];
const iso = (ms: number) => new Date(ms).toISOString();
const convObj = (id: number, uuid: string, start: number, end: number | null, state: string) => ({ id, start_time: iso(start), end_time: end == null ? null : iso(end), conversation_uuid: uuid, device_type: "unknown", device_id: null, summary: null, short_summary: null, state, primary_location: null, template: null, city: null, business: null, bookmarked: false });

// A synthetic capture: [ms after t0, JSONL line].
function capture(t0: number, n: number, opts: { deleteAfterMs?: number | null; noise?: boolean } = {}): [number, string][] {
  const uuid = `synthetic-conv-${n}`;
  const id = 5_000_000 + n;
  const out: [number, string][] = [[0, JSON.stringify({ type: "new-conversation", conversation: convObj(id, uuid, t0, null, "CAPTURING") })]];
  let at = 2000;
  ADA.forEach((text, i) => {
    const utt = 6_000_000 + n * 100 + i;
    const dur = 4.5;
    out.push([at + dur * 1000 + 5400, JSON.stringify({ type: "new-utterance", conversation_uuid: uuid, utterance: { id: utt, sample_id: `s-${utt}`, start: at / 1000, end: at / 1000 + dur, text, spoken_at: iso(t0 + at) } })]);
    out.push([at + dur * 1000 + 5900, JSON.stringify({ type: "tagged-utterance", utterance_id: utt, person_id: 1, person_first_name: "Ada", speaker_score: 0.8, conversation_uuid: uuid })]);
    const oth = utt + 50;
    out.push([at + dur * 1000 + 7000, JSON.stringify({ type: "new-utterance", conversation_uuid: uuid, utterance: { id: oth, sample_id: `s-${oth}`, start: at / 1000 + dur + 1, end: at / 1000 + dur + 3, text: "the zebra orchid passcode is 4417", spoken_at: iso(t0 + at + dur * 1000 + 1000) } })]);
    at += 10_000;
  });
  if (opts.noise) {
    out.push([at, JSON.stringify({ timestamp: t0 + at })]);
    out.push([at + 100, JSON.stringify({ type: "todo-deleted", todo: { id: 1, conversationId: null, text: "Buy milk", completed: false, alarmAt: t0, appleId: null } })]);
  }
  const end = t0 + at + 20_000;
  out.push([at + 20_000, JSON.stringify({ type: "update-conversation", conversation: convObj(id, uuid, t0, end, "PROCESSING") })]);
  if (opts.deleteAfterMs != null) out.push([at + 20_000 + opts.deleteAfterMs, JSON.stringify({ type: "delete-conversation", conversation: convObj(id, uuid, t0, end, "PROCESSING") })]);
  return out;
}

async function playCapture(lines: [number, string][]) {
  const t0 = Date.now();
  for (const [ms, line] of lines.sort((a, b) => a[0] - b[0])) {
    await vi.advanceTimersByTimeAsync(Math.max(0, t0 + ms - Date.now()));
    const e = parseStreamLine(line);
    if (e) setup.hub.ingestBee(e);
  }
}

const of = (t: string) => events.filter((e) => e.topic === t).map((e) => e.payload as any);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-20T17:30:00Z") });
  dir = mkdtempSync(join(tmpdir(), "live-shapes-"));
  setup = demoSetup({ pace: 1, stateDir: dir });
  events = [];
  setup.hub.on("event", (e: HubEvent) => events.push(e));
  const exec: ExecFn = async (_f, args) => ({ stdout: args[1] === "create" ? JSON.stringify({ id: ++todoN, alarm_at: Date.parse(args[args.indexOf("--alarm-at") + 1]!) }) : "[]" });
  const ctx = { hub: setup.hub, setup, stateDir: dir, pace: 1, demo: true, fixtureV2: false, log: () => {}, publish: (t: any, d: any) => setup.hub.publish(t, d) } as unknown as PluginCtx;
  const plugin = createLivePlugin({ wrist: (c) => (wrist = new BeeTodoWrist({ exec, clock: c.hub.clock, ledgerPath: join(dir, "live", "todos.json"), minGapMs: 10 })), onEngine: (e) => (engine = e) });
  plugin.attach!(ctx);
  tick = setInterval(() => void setup.hub.verifier.tick(), 100);
});
afterEach(() => {
  clearInterval(tick);
  engine.stop();
  setup.stop();
  setup.hub.dispose();
  vi.useRealTimers();
});

describe("Bee's end-of-conversation events (capture-shaped)", () => {
  it("update-conversation (PROCESSING, end_time) ends the conversation after the delete grace; the recap follows", async () => {
    const t0 = setup.hub.clock();
    const lines = capture(t0, 1, { noise: true });
    await playCapture(lines);
    expect(of("conversation.ended")).toHaveLength(0); // held for the delete grace
    await vi.advanceTimersByTimeAsync(BEE_DELETE_GRACE_MS + 10);
    await engine.settle();
    const [ended] = of("conversation.ended");
    const upd = JSON.parse(lines.at(-1)![1]).conversation;
    expect(ended).toMatchObject({ conversationId: "synthetic-conv-1", reason: "bee-state", endedAt: Date.parse(upd.end_time), recap: "pending", otherLines: ADA.length });
    expect(of("recap.ready")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/zebra|4417|milk/i);
  });
  it("update then delete-conversation 0.4 s later (as captured): no recap, ever", async () => {
    const t0 = setup.hub.clock();
    await playCapture(capture(t0, 2, { deleteAfterMs: 400 }));
    await vi.advanceTimersByTimeAsync(120_000);
    await engine.settle();
    expect(of("conversation.ended")).toEqual([expect.objectContaining({ conversationId: "synthetic-conv-2", reason: "bee-state", recap: "skipped-short" })]);
    expect(of("recap.ready")).toHaveLength(0);
    expect(engine.recapList(10)).toHaveLength(0);
  });
  it("a delete after an idle-ended recap retracts the recap from memory and disk", async () => {
    engine.setMode({ enabled: true });
    const t0 = setup.hub.clock();
    const lines = capture(t0, 3, { deleteAfterMs: 400 });
    const tail = lines.splice(-2); // Bee's update/delete come minutes later
    await playCapture(lines);
    await vi.advanceTimersByTimeAsync(95_000);
    await engine.settle();
    expect(of("conversation.ended")[0]).toMatchObject({ reason: "idle", recap: "pending" });
    const recap = of("recap.ready")[0].recap;
    expect(engine.recap(recap.id)).not.toBeNull();
    for (const [, l] of tail) setup.hub.ingestBee(parseStreamLine(l)!);
    expect(engine.recap(recap.id)).toBeNull();
    expect(engine.coachNow().basis).toBe("week");
    const disk = JSON.parse(readFileSync(join(dir, "live", "recaps.json"), "utf8"));
    expect(disk.recaps.find((r: any) => r.id === recap.id)).toBeUndefined();
    expect(of("conversation.ended")).toHaveLength(1);
  });
  it("todo-deleted reconciles the wrist ledger (the wearer deleted our recap to-do)", async () => {
    engine.setMode({ enabled: true });
    const t0 = setup.hub.clock();
    await playCapture(capture(t0, 4));
    await vi.advanceTimersByTimeAsync(BEE_DELETE_GRACE_MS + 2000);
    await engine.settle();
    const entry = wrist.entries().find((e) => e.kind === "recap")!;
    expect(entry).toMatchObject({ state: "pending", cleanup: "complete" });
    setup.hub.ingestBee(parseStreamLine(JSON.stringify({ type: "todo-deleted", todo: { id: Number(entry.todoId), conversationId: null, text: "[coach] Recap", completed: false, alarmAt: entry.alarmAt, appleId: null } }))!);
    expect(entry.state).toBe("gone");
    expect(wrist.status().pendingTodos).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "live", "todos.json"), "utf8")).todos.find((t: any) => t.todoId === entry.todoId).state).toBe("gone");
  });
});
