// The wrist (src/hub/live/wrist.ts) against a fake Bee CLI and a virtual clock: execFile-style
// argument arrays, a serialized queue with gaps, timeouts, retries without duplicates, the circuit
// breaker, the ledger and the cleanup sweeps. No real to-do is ever created here.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alarmIso, BeeTodoWrist, MIN_GAP_MS, parseTodo, parseTodoList, ReplayWrist, type ExecFn } from "../src/hub/live/wrist.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
type Call = { file: string; args: string[]; timeout: number; start: number; end: number };

function rig(script: (args: string[], n: number) => string | Error = () => "{}", opts: { ledger?: boolean; logs?: string[] } = {}) {
  let now = T0;
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, o) => {
    const start = now;
    now += 400; // the CLI takes 0.4 s
    calls.push({ file, args, timeout: o.timeout, start, end: now });
    const r = script(args, calls.length);
    if (r instanceof Error) throw r;
    return { stdout: r };
  };
  const dir = opts.ledger === false ? null : mkdtempSync(join(tmpdir(), "wrist-"));
  const opened: number[] = [];
  const w = new BeeTodoWrist({ exec, bin: "bee", clock: () => now, sleep: async (ms) => void (now += ms), ledgerPath: dir ? join(dir, "live", "todos.json") : null, log: (e) => opts.logs?.push(e) });
  w.onCircuitOpen = () => opened.push(now);
  return { w, calls, dir, opened, now: () => now, advance: (ms: number) => void (now += ms) };
}
let nextId = 29_200_000;
const created = (args: string[]) => {
  const i = args.indexOf("--alarm-at");
  return JSON.stringify({ id: ++nextId, text: args[args.indexOf("--text") + 1], alarm_at: Date.parse(args[i + 1]!), completed: false, created_at: T0, corrections: [], timezone: "America/Toronto" });
};
const timeoutErr = () => Object.assign(new Error("Command failed: bee todos create"), { killed: true, signal: "SIGTERM" });

describe("BeeTodoWrist", () => {
  it("creates a to-do with execFile arguments (no shell), a 10 s timeout and an alarm 10 s ahead", async () => {
    const r = rig((a) => (a[1] === "create" ? created(a) : "[]"));
    const text = `[coach] 5 hedges in 2 min. "Say it"; $(plainly)`;
    const res = await r.w.send({ kind: "nudge", refId: "ndg_1", text });
    expect(r.calls[0]).toMatchObject({ file: "bee", timeout: 10_000, args: ["todos", "create", "--text", text, "--alarm-at", alarmIso(T0 + 10_000), "--json"] });
    expect(res).toMatchObject({ channel: "bee-todo", status: "scheduled", todoId: String(nextId), todoAt: T0 + 400, alarmAt: Date.parse(alarmIso(T0 + 10_000)), leadMs: 10_000, error: null });
    const ledger = JSON.parse(readFileSync(join(r.dir!, "live", "todos.json"), "utf8"));
    expect(ledger.todos[0]).toMatchObject({ todoId: String(nextId), kind: "nudge", refId: "ndg_1", text, cleanup: "delete", state: "pending" });
    expect(r.w.status()).toMatchObject({ channel: "bee-todo", healthy: true, failures: 0, pendingTodos: 1, leadMs: 10_000 });
  });
  it("rejects text that is not generated coach text, without calling the CLI", async () => {
    const r = rig();
    expect((await r.w.send({ kind: "nudge", refId: "x", text: "I guess we could maybe ship it" })).status).toBe("failed");
    expect((await r.w.send({ kind: "nudge", refId: "x", text: `[coach] ${"x".repeat(60)}` })).status).toBe("failed");
    expect(r.calls).toHaveLength(0);
  });
  it("serializes calls at least 1.5 s apart, creates ahead of cleanups", async () => {
    const r = rig((a) => (a[1] === "create" ? created(a) : "{}"));
    await Promise.all([1, 2, 3].map((i) => r.w.send({ kind: "nudge", refId: `n${i}`, text: `[coach] nudge ${i}` })));
    expect(r.calls.map((c) => c.args[1])).toEqual(["create", "create", "create"]);
    for (let i = 1; i < r.calls.length; i++) expect(r.calls[i]!.start - r.calls[i - 1]!.end).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });
  it("retries a failed create, and adopts a create that timed out but landed (no duplicate)", async () => {
    const r = rig((a, n) => (a[1] === "create" ? (n <= 2 ? new Error("network down") : created(a)) : "[]"));
    const res = await r.w.send({ kind: "nudge", refId: "n1", text: "[coach] retry me" });
    expect(res.status).toBe("scheduled");
    expect(r.calls.map((c) => c.args[1])).toEqual(["create", "create", "create"]);
    expect(r.w.status().failures).toBe(0);

    let landed = "";
    const t = rig((a) => {
      if (a[1] === "create") return (landed = created(a)), timeoutErr();
      if (a[1] === "list") return JSON.stringify([JSON.parse(landed)]);
      return "{}";
    });
    const res2 = await t.w.send({ kind: "nudge", refId: "n2", text: "[coach] slow create" });
    expect(res2).toMatchObject({ status: "scheduled", todoId: String(JSON.parse(landed).id) });
    expect(t.calls.map((c) => c.args[1])).toEqual(["create", "list"]);
  });
  it("a create whose output has no id is checked against the list before any retry (one alarm, not three)", async () => {
    let landed = "";
    const r = rig((a) => {
      if (a[1] === "create") return (landed = created(a)), "Created.";
      if (a[1] === "list") return JSON.stringify([JSON.parse(landed)]);
      return "{}";
    });
    const res = await r.w.send({ kind: "nudge", refId: "n3", text: "[coach] quiet create" });
    expect(res).toMatchObject({ status: "scheduled", todoId: String(JSON.parse(landed).id) });
    expect(r.calls.map((c) => c.args[1])).toEqual(["create", "list"]);
    // a notice line before the JSON is read past
    const n = rig((a) => (a[1] === "create" ? `A new version of bee is available.\n${created(a)}` : "[]"));
    expect(await n.w.send({ kind: "nudge", refId: "n4", text: "[coach] notice first" })).toMatchObject({ status: "scheduled", todoId: String(nextId) });
    expect(n.calls.map((c) => c.args[1])).toEqual(["create"]);
  });
  it("a create that exits 0 with no id and no list match is never made again, and never opens the circuit", async () => {
    const r = rig((a) => (a[1] === "create" ? "Created." : "[]"));
    for (let i = 1; i <= 3; i++) {
      const res = await r.w.send({ kind: "nudge", refId: `q${i}`, text: `[coach] quiet ${i}` });
      expect(res).toMatchObject({ status: "scheduled", todoId: null, error: expect.stringMatching(/no to-do id/) });
    }
    // One create per nudge (one alarm on the wrist), each checked once against the list.
    expect(r.calls.map((c) => c.args[1])).toEqual(["create", "list", "create", "list", "create", "list"]);
    expect(r.opened).toEqual([]);
    expect(r.w.status()).toMatchObject({ failures: 0, healthy: true });
  });
  it("reads the JSON when a notice line follows it, as well as before it", async () => {
    const r = rig((a) => (a[1] === "create" ? `${created(a)}\nA new version of bee is available: run bee update.` : "[]"));
    expect(await r.w.send({ kind: "nudge", refId: "t1", text: "[coach] notice after" })).toMatchObject({ status: "scheduled", todoId: String(nextId) });
    expect(r.calls.map((c) => c.args[1])).toEqual(["create"]);
    expect(parseTodo('Update available\n{\n "id": 9,\n "alarm_at": 1792177029000\n}\nRun bee update [y/N]')).toEqual({ id: "9", alarmAt: 1792177029000 });
    expect(parseTodo('{"id": 10}\nnotice one\nnotice two')).toEqual({ id: "10", alarmAt: null });
    expect(parseTodoList('banner\n[\n {"id": 1, "text": "a"},\n {"id": 2, "text": "b"}\n]\n(2 to-dos)')).toMatchObject([{ id: "1" }, { id: "2" }]);
    expect(parseTodo("Created.\nno json here")).toBeNull();
  });
  it("a ledger that cannot be written never turns a created to-do into a failure and a retry", async () => {
    const logs: string[] = [];
    const r = rig((a) => (a[1] === "create" ? created(a) : "[]"), { logs });
    writeFileSync(join(r.dir!, "live"), "not a directory"); // the ledger's folder cannot be made
    const res = await r.w.send({ kind: "nudge", refId: "n5", text: "[coach] full disk" });
    expect(res.status).toBe("scheduled");
    expect(r.calls.filter((c) => c.args[1] === "create")).toHaveLength(1);
    expect(logs).toContain("wrist.ledger.save-failed");
  });
  it("opens the circuit after 3 consecutive failures, then fails fast", async () => {
    const r = rig(() => new Error("bee: not logged in"));
    const res = await r.w.send({ kind: "nudge", refId: "n1", text: "[coach] fail" });
    expect(res).toMatchObject({ status: "failed", todoId: null, todoAt: null, alarmAt: null });
    expect(r.calls).toHaveLength(3);
    expect(r.opened).toHaveLength(1);
    expect(r.w.status()).toMatchObject({ healthy: false, failures: 3 });
    expect(r.w.circuitOpenUntil()).toBeGreaterThan(r.now());
    const again = await r.w.send({ kind: "nudge", refId: "n2", text: "[coach] fail again" });
    expect(again.error).toMatch(/circuit open/);
    expect(r.calls).toHaveLength(3);
  });
  it("cleanup: deletes a nudge 10 min after its alarm, completes a recap 30 min after its alarm", async () => {
    const r = rig((a) => (a[1] === "create" ? created(a) : "{}"));
    const n = await r.w.send({ kind: "nudge", refId: "n1", text: "[coach] nudge" });
    const c = await r.w.send({ kind: "recap", refId: "r1", text: "[coach] Recap: hedges high" });
    r.advance(9 * 60_000);
    await r.w.cleanupDue();
    expect(r.calls.filter((x) => x.args[1] !== "create")).toHaveLength(0);
    r.advance(2 * 60_000);
    await r.w.cleanupDue();
    expect(r.calls.at(-1)!.args).toEqual(["todos", "delete", n.todoId, "--json"]);
    r.advance(20 * 60_000);
    await r.w.cleanupDue();
    expect(r.calls.at(-1)!.args).toEqual(["todos", "complete", c.todoId, "--json"]);
    expect(r.w.entries().map((e) => e.state)).toEqual(["done", "done"]);
    expect(r.w.status().pendingTodos).toBe(0);
  });
  it("sweep: deletes only stale, untracked, open [coach] to-dos", async () => {
    const r = rig((a) =>
      a[1] === "list"
        ? JSON.stringify({ todos: [
            { id: 1, text: "[coach] probe 10s", completed: false, alarm_at: T0 - 3600_000 },
            { id: 2, text: "Buy milk", completed: false, alarm_at: T0 - 3600_000 },
            { id: 3, text: "[coach] Recap: old", completed: true, alarm_at: T0 - 3600_000 },
            { id: 4, text: "[coach] fresh", completed: false, alarm_at: T0 - 60_000 },
            { id: 5, text: "[coach] prep 1:1 notes", completed: false, alarm_at: T0 - 3600_000 }, // a personal to-do (review M3)
            { id: 6, text: "[coach]: call the dentist", completed: false, alarm_at: T0 - 3600_000 },
            { id: 7, text: "[coach] Recap: hedges high", completed: 1, alarm_at: T0 - 3600_000 }, // completed reported as 1
          ] })
        : "{}",
    );
    expect(await r.w.sweep()).toBe(1);
    expect(r.calls.map((c) => c.args)).toEqual([
      ["todos", "list", "--limit", "100", "--json"],
      ["todos", "delete", "1", "--json"],
    ]);
  });
  it("a cue to-do: a later alarm when asked, deleted 10 min after it, and the stale sweep knows its text", async () => {
    const r = rig((a) => (a[1] === "create" ? created(a) : "{}"));
    const text = '[coach] If asked for status: result first, no "I guess".';
    const res = await r.w.send({ kind: "cue", refId: "cue_1", text, alarmAt: T0 + 10 * 60_000 });
    expect(r.calls[0]!.args).toEqual(["todos", "create", "--text", text, "--alarm-at", alarmIso(T0 + 10 * 60_000), "--json"]);
    expect(r.w.entries()[0]).toMatchObject({ kind: "cue", refId: "cue_1", cleanup: "delete", cleanupAt: res.alarmAt! + 10 * 60_000 });
    // never sooner than the lead
    await r.w.send({ kind: "cue", refId: "cue_2", text, alarmAt: T0 });
    expect(Date.parse(r.calls[1]!.args[5]!)).toBeGreaterThanOrEqual(T0 + 10_000 + 400);
    const s = rig((a) => (a[1] === "list" ? JSON.stringify([{ id: 8, text, completed: false, alarm_at: T0 - 3600_000 }]) : "{}"));
    expect(await s.w.sweep()).toBe(1);
  });
  it("parses the create and list outputs defensively", () => {
    expect(parseTodo('{"id":29154389,"text":"x","alarm_at":1792177029000}')).toEqual({ id: "29154389", alarmAt: 1792177029000 });
    expect(parseTodo('{"todo":{"id":"7","alarmAt":"2026-10-20T17:30:10Z"}}')).toEqual({ id: "7", alarmAt: T0 + 10_000 });
    expect(parseTodo("not json")).toBeNull();
    expect(parseTodo('Update available\n{\n "id": 9,\n "alarm_at": 1792177029000\n}')).toEqual({ id: "9", alarmAt: 1792177029000 });
    expect(parseTodoList('[{"id":1,"text":"a","completed":false,"alarm_at":null}]')).toEqual([{ id: "1", text: "a", completed: false, alarmAt: null }]);
    expect(parseTodoList('{"items":[{"id":2}]}')[0]!.id).toBe("2");
    expect(alarmIso(T0 + 10_400)).toBe("2026-10-20T17:30:11Z");
  });
});

describe("ReplayWrist", () => {
  it("reports replay hops: ~1.45 s to the to-do and the alarm lead, scaled by the pace", async () => {
    let now = T0;
    const w = new ReplayWrist({ clock: () => now, pace: 0.001 });
    const t = setInterval(() => (now += 1), 1);
    const r = await w.send({ kind: "nudge", refId: "n", text: "[coach] 5 hedges in 2 min. Say it plainly." });
    clearInterval(t);
    expect(r).toMatchObject({ channel: "replay", status: "replay", todoId: null, leadMs: 10_000, error: null });
    expect(r.alarmAt! - r.todoAt!).toBe(10);
    expect(w.status()).toMatchObject({ channel: "replay", healthy: true, pendingTodos: 0 });
  });
});
