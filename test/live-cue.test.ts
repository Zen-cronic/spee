// The if-then wrist cue (src/hub/live/cue.ts) through the real wrist queue on a fake Bee CLI (the
// injected ExecFn) and a virtual clock: one <= 60-character cue as a "cue" to-do, only for a drilled
// habit already practised (never the control, never an unpractised habit), dedupe, the daily cap,
// quiet hours, opt-in, validation and the wrist breaker. No real to-do is ever created here.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CUE_HABITS, WRIST_TEXT_MAX, type CueResponse } from "../src/hub/contract.js";
import { badCueRequest, CUE_CAP_PER_DAY, CUE_DEDUPE_MS, CueBook, cueHabits, cuesEnabledFor } from "../src/hub/live/cue.js";
import { CUE_TEXT } from "../src/hub/live/rules.js";
import { alarmIso, BeeTodoWrist, GENERATED_WRIST_RE, ReplayWrist, type ExecFn } from "../src/hub/live/wrist.js";
import { demoSetup, type Setup } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T17:30:00Z"); // 13:30 in Toronto
const setups: Setup[] = [];
afterEach(() => setups.splice(0).forEach((s) => (s.stop(), s.hub.dispose())));

type Transfer = Parameters<typeof cueHabits>[0];
const habit = (h: string, role: "drilled" | "control", firstDrillAt: number | null, per100 = 1) => ({ habit: h, role, firstDrillAt, before: { words: 500, per100: per100 + 1 }, after: { words: 500, per100 } });

function rig(o: { enabled?: boolean; transfer?: Transfer; fail?: boolean; dir?: string; at?: number } = {}) {
  const s = demoSetup({ pace: 1, stateDir: null });
  setups.push(s);
  let now = o.at ?? T0;
  const calls: string[][] = [];
  let id = 7000;
  const exec: ExecFn = async (_f, args) => {
    calls.push(args);
    now += 400;
    if (o.fail) throw new Error("bee: not logged in");
    if (args[1] === "create") return { stdout: JSON.stringify({ id: ++id, text: args[3], alarm_at: Date.parse(args[5]!) }) };
    return { stdout: "[]" };
  };
  const wrist = new BeeTodoWrist({ exec, clock: () => now, sleep: async (ms) => void (now += ms), ledgerPath: null });
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "cue-"));
  const book = new CueBook({ hub: s.hub, wrist, enabled: o.enabled ?? true, stateDir: dir, clock: () => now, transfer: o.transfer === undefined ? undefined : () => o.transfer! });
  return { s, book, wrist, calls, dir, now: () => now, advance: (ms: number) => void (now += ms), creates: () => calls.filter((c) => c[1] === "create") };
}

describe("POST /api/coach/cue (CueBook)", () => {
  it("sends one <= 60-character if-then cue through the wrist queue as a 'cue' to-do", async () => {
    const r = rig();
    const res = await r.book.request({ inMinutes: 0, by: "skill" });
    expect(res.status).toBe(200);
    const b = res.body as CueResponse;
    expect(CUE_HABITS).toContain(b.cue.habit);
    expect(b.cue.text).toBe(CUE_TEXT[b.cue.habit]);
    expect(b.cue.text.startsWith("[coach] ") && b.cue.text.length <= WRIST_TEXT_MAX).toBe(true);
    expect(b).toMatchObject({ cue: { by: "skill", id: expect.stringMatching(/^cue_/) }, wrist: { channel: "bee-todo", status: "scheduled", todoId: "7001", error: null }, deduped: false });
    expect(b.narration).toMatch(/^Cue set: your wrist alarm goes off at 1:30 PM\. If /);
    expect(r.creates()).toEqual([["todos", "create", "--text", b.cue.text, "--alarm-at", alarmIso(T0 + 10_000), "--json"]]);
    expect(r.wrist.entries()[0]).toMatchObject({ kind: "cue", refId: b.cue.id, cleanup: "delete", state: "pending" });
    expect(JSON.parse(readFileSync(join(r.dir, "live", "cues.json"), "utf8")).cues[0]).toMatchObject({ id: b.cue.id, habit: b.cue.habit, text: b.cue.text });
  });
  it("inMinutes sets a later alarm", async () => {
    const r = rig();
    const b = (await r.book.request({ inMinutes: 10 })).body as CueResponse;
    expect(r.creates()[0]![5]).toBe(alarmIso(T0 + 10 * 60_000));
    expect(b.cue.alarmAt).toBe(Date.parse(alarmIso(T0 + 10 * 60_000)));
    expect(b.cue.by).toBe("http");
  });
  it("every cue text is generated coach text <= 60 characters, and the stale sweep knows it as the coach's", () => {
    for (const t of Object.values(CUE_TEXT)) {
      expect(t.length).toBeLessThanOrEqual(WRIST_TEXT_MAX);
      expect(GENERATED_WRIST_RE.test(t)).toBe(true);
    }
    expect(GENERATED_WRIST_RE.test("[coach] If asked for status: say the dentist's name")).toBe(false);
  });
});

describe("which habit a cue names", () => {
  it("only a drilled habit already practised; never the control (restart), never an unpractised habit", async () => {
    // even a transfer that lists the control as drilled and practised never gets a restart cue
    expect(cueHabits({ habits: [habit("restart", "drilled", T0, 9), habit("hedges", "drilled", null, 5), habit("filler:like", "drilled", T0, 1)] })).toEqual(["filler:like"]);
    expect(cueHabits({ habits: [habit("restart", "control", T0, 9), habit("hedges", "drilled", T0, 1), habit("filler:like", "drilled", T0, 2)] })).toEqual(["filler:like", "hedges"]);
    expect(cueHabits({ habits: [habit("hedges", "drilled", T0, 1), habit("filler:like", "drilled", T0, 1)] })).toEqual(["hedges", "filler:like"]);
    expect(cueHabits({ habits: [habit("vague", "drilled", T0, 9)] })).toEqual([]);
    expect(cueHabits(null)).toEqual([]);
  });
  it("nothing practised: 409 no_practised_habit, and no to-do", async () => {
    const r = rig({ transfer: { habits: [habit("hedges", "drilled", null), habit("filler:like", "drilled", null), habit("restart", "control", null)] } });
    const res = await r.book.request({});
    expect(res).toMatchObject({ status: 409, body: { error: "no_practised_habit" } });
    expect(r.calls).toEqual([]);
  });
  it("on the demo hub's own data, the practised habit with the higher rate (filler 'like')", async () => {
    const r = rig();
    expect(((await r.book.request({})).body as CueResponse).cue.habit).toBe("filler:like");
  });
});

describe("dedupe, cap, quiet hours, opt-in", () => {
  it("a cue whose alarm is within 10 min of an earlier cue's alarm is deduped: the first cue back, no second to-do; also when sent at once", async () => {
    expect(CUE_DEDUPE_MS).toBe(10 * 60_000);
    const r = rig();
    const [a, b] = await Promise.all([r.book.request({}), r.book.request({ inMinutes: 5 })]);
    expect((a.body as CueResponse).deduped).toBe(false);
    expect(b.body).toMatchObject({ deduped: true, cue: { id: (a.body as CueResponse).cue.id } });
    r.advance(CUE_DEDUPE_MS - 60_000);
    const c = await r.book.request({});
    // its alarm has gone off, so the narration never says it is "already set" for that time
    expect(c.body).toMatchObject({ deduped: true, cue: { id: (a.body as CueResponse).cue.id }, narration: "That cue went off 9 min ago, so I didn't send another." });
    expect(r.creates()).toHaveLength(1);
  });
  it("back-to-back meetings at 14:00 and 14:30 each get their cue (the dedupe is on the alarm, not on when it was asked for)", async () => {
    const r = rig({ at: Date.parse("2026-10-20T17:50:00Z") }); // 13:50 local, the heartbeat for 14:00
    const a = (await r.book.request({ inMinutes: 0, by: "skill:heartbeat" })).body as CueResponse;
    r.advance(Date.parse("2026-10-20T18:19:00Z") - r.now()); // 14:19, the heartbeat for 14:30
    const b = (await r.book.request({ inMinutes: 0, by: "skill:heartbeat" })).body as CueResponse;
    expect(a.deduped).toBe(false);
    expect(b).toMatchObject({ deduped: false, wrist: { status: "scheduled" }, narration: expect.stringMatching(/^Cue set: your wrist alarm goes off at 2:19 PM\./) });
    expect(b.cue.id).not.toBe(a.cue.id);
    expect(r.creates()).toHaveLength(2);
  });
  it("a cue asked for hours ahead never dedupes one for an earlier meeting, and one asked for long ago dedupes a cue next to its alarm", async () => {
    const r = rig({ at: Date.parse("2026-10-20T17:00:00Z") }); // 13:00 local
    const call = (await r.book.request({ inMinutes: 120, by: "skill" })).body as CueResponse; // a 15:00 call
    r.advance(15 * 60_000);
    const meeting = (await r.book.request({ inMinutes: 0, by: "skill:heartbeat" })).body as CueResponse; // a 13:25 meeting
    expect(meeting.deduped).toBe(false);
    expect(r.creates()).toHaveLength(2);
    const early = rig({ at: Date.parse("2026-10-20T16:00:00Z") }); // 12:00 local
    const first = (await early.book.request({ inMinutes: 180 })).body as CueResponse; // alarm 15:00
    early.advance(Date.parse("2026-10-20T18:55:00Z") - early.now()); // 14:55
    expect((await early.book.request({})).body).toMatchObject({ deduped: true, cue: { id: first.cue.id }, narration: "That cue is already set for 3:00 PM, so I didn't send another." });
    expect(early.creates()).toHaveLength(1);
    expect(call.cue.alarmAt).toBe(Date.parse("2026-10-20T19:00:00Z"));
  });
  it("dedupe survives a restart (the ledger)", async () => {
    const r = rig();
    const a = (await r.book.request({})).body as CueResponse;
    const r2 = rig({ dir: r.dir, at: r.now() + 60_000 });
    expect((await r2.book.request({})).body).toMatchObject({ deduped: true, cue: { id: a.cue.id } });
    expect(r2.creates()).toEqual([]);
  });
  it(`at most ${CUE_CAP_PER_DAY} cues a day: then 429 cue_cap, no to-do`, async () => {
    const r = rig({ at: Date.parse("2026-10-20T12:30:00Z") }); // 08:30 local
    for (let i = 0; i < CUE_CAP_PER_DAY; i++) {
      expect(((await r.book.request({})).body as CueResponse).deduped).toBe(false);
      r.advance(CUE_DEDUPE_MS + 60_000);
    }
    expect(await r.book.request({})).toMatchObject({ status: 429, body: { error: "cue_cap" } });
    expect(r.creates()).toHaveLength(CUE_CAP_PER_DAY);
  });
  it("quiet hours (22:00 to 08:00 local): 409 quiet_hours, also when the alarm would land in them", async () => {
    const late = rig({ at: Date.parse("2026-10-21T03:00:00Z") }); // 23:00 local
    expect(await late.book.request({})).toMatchObject({ status: 409, body: { error: "quiet_hours" } });
    const edge = rig({ at: Date.parse("2026-10-21T01:55:00Z") }); // 21:55 local, +10 min
    expect(await edge.book.request({ inMinutes: 10 })).toMatchObject({ status: 409, body: { error: "quiet_hours" } });
    expect((await edge.book.request({ inMinutes: 1 })).status).toBe(200);
    expect(late.calls).toEqual([]);
  });
  it("off unless COACH_CUES=1 (live): 409 cues_off, no to-do; the demo hub always answers", async () => {
    const r = rig({ enabled: false });
    expect(await r.book.request({})).toMatchObject({ status: 409, body: { error: "cues_off" } });
    expect(r.calls).toEqual([]);
    expect(cuesEnabledFor({ demo: false, env: {} })).toBe(false);
    expect(cuesEnabledFor({ demo: false, env: { COACH_CUES: "true" } })).toBe(false);
    expect(cuesEnabledFor({ demo: false, env: { COACH_CUES: "1" } })).toBe(true);
    expect(cuesEnabledFor({ demo: true, env: {} })).toBe(true);
  });
  it("validates the request (400 bad_request)", () => {
    for (const b of [{ inMinutes: -1 }, { inMinutes: 181 }, { inMinutes: "5" }, { inMinutes: Number.NaN }, { by: "x".repeat(41) }, { by: 3 }]) expect(badCueRequest(b), JSON.stringify(b)).not.toBeNull();
    for (const b of [{}, { inMinutes: 0 }, { inMinutes: 180 }, { inMinutes: 2.5, by: "skill" }]) expect(badCueRequest(b)).toBeNull();
  });
});

describe("the wrist", () => {
  it("a failed create answers status failed, and counts toward neither the dedupe nor the cap; an open circuit is 503 wrist_down", async () => {
    const r = rig({ fail: true });
    const a = await r.book.request({});
    expect(a).toMatchObject({ status: 200, body: { deduped: false, wrist: { status: "failed", todoId: null }, narration: expect.stringMatching(/couldn't put the cue/) } });
    expect(r.wrist.circuitOpenUntil()).not.toBeNull(); // 3 failed creates
    expect(await r.book.request({})).toMatchObject({ status: 503, body: { error: "wrist_down" } });
  });
  it("the replay wrist (demo): no CLI, a replay result with its alarm", async () => {
    const s = demoSetup({ pace: 0.001, stateDir: null });
    setups.push(s);
    const book = new CueBook({ hub: s.hub, wrist: new ReplayWrist({ clock: s.hub.clock, pace: 0.001 }), enabled: true, stateDir: null });
    const b = (await book.request({ inMinutes: 0, by: "check" })).body as CueResponse;
    expect(b).toMatchObject({ wrist: { channel: "replay", status: "replay", todoId: null }, deduped: false, narration: expect.stringMatching(/^Demo cue, no Bee call/) });
    expect(b.cue.alarmAt).toEqual(expect.any(Number));
  });
});
