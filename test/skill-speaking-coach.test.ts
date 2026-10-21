// The speaking-coach Agent Skill (skills/speaking-coach): its frontmatter, the heartbeat's decide()
// window (8 to 12 min before a meeting, once per meeting), and that no output line or saved state
// carries a calendar title. Hub calls go to a fake hub on a free port, and to the in-process demo
// hub for the routes it already serves.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CUE_WINDOW_MIN, cuedFor, decide, eventKey, loadSent, run } from "../skills/speaking-coach/scripts/coach.mjs";
import { BEE_MEMORY_NOTE, type BeeMemory, type Brief, type CueResponse } from "../src/hub/contract.js";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";

const ROOT = new URL("../", import.meta.url);
const SKILL_DIR = "skills/speaking-coach";
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const TITLE = "Quarterly review with Dana Whitfield";
const T0 = Date.parse("2026-10-21T13:00:00.000Z");

const brief = (startsInMin: number | null, over: Partial<Brief> = {}): Brief => ({
  dataLabel: "SYNTHETIC DEMO DATA",
  generatedAt: new Date(T0).toISOString(),
  event: startsInMin === null ? null : { title: TITLE, startsAt: new Date(T0 + startsInMin * 60_000).toISOString(), startsInMin, date: "2026-10-21", source: "test calendar" },
  eventNote: null,
  topHabit: { key: "hedges", label: "unsure words", per100: 2.6, count: 9, words: 350, range: "week", source: "bee" },
  warmup: null,
  nudge: startsInMin === null ? "No meeting on your calendar soon." : `${TITLE} in ${startsInMin} min. The habit to watch this week: unsure words (2.6 per 100 words).`,
  ...over,
});

describe("SKILL.md", () => {
  const text = read(`${SKILL_DIR}/SKILL.md`);
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  const field = (k: string) => fm?.[1]!.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  it("has Agent Skill frontmatter: a name that matches its folder and a description of what and when", () => {
    expect(fm).not.toBeNull();
    expect(field("name")).toBe("speaking-coach");
    expect(field("name")).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(field("name")).not.toMatch(/anthropic|claude/);
    const d = field("description");
    expect(d.length).toBeGreaterThan(50);
    expect(d.length).toBeLessThanOrEqual(1024);
    expect(d).not.toMatch(/[<>]/);
    expect(d).toMatch(/Use when/);
  });
  it("documents every command the script runs, and the script's path exists", () => {
    for (const cmd of ["status", "brief", "goal", "cue", "heartbeat"]) expect(text).toContain(`\`${cmd}`);
    expect(text).toContain(`node ${SKILL_DIR}/scripts/coach.mjs <command>`);
    expect(read(`${SKILL_DIR}/scripts/coach.mjs`).startsWith("#!/usr/bin/env node")).toBe(true);
  });
  it("the cue length it states is the wrist limit, and it never offers the control habit", () => {
    expect(text).toContain("at most 60 characters");
    expect(text).toContain("never the one kept unpractised for comparison");
  });
});

describe("decide(): one cue per meeting, 8 to 12 minutes before it", () => {
  it("cues inside the window, edges included", () => {
    for (const m of [8, 9.5, 10, 12]) expect(decide(brief(m), {}).action, `${m} min`).toBe("cue");
    expect(CUE_WINDOW_MIN).toEqual({ from: 8, to: 12 });
  });
  it("waits outside it", () => {
    expect(decide(brief(12.5), {})).toMatchObject({ action: "wait", reason: "too-early" });
    expect(decide(brief(60), {})).toMatchObject({ action: "wait", reason: "too-early" });
    expect(decide(brief(7.5), {})).toMatchObject({ action: "wait", reason: "too-late" });
    expect(decide(brief(-1), {})).toMatchObject({ action: "wait", reason: "started" });
    expect(decide(brief(null), {})).toMatchObject({ action: "wait", reason: "no-meeting", key: null });
    expect(decide(null, {})).toMatchObject({ action: "wait", reason: "no-meeting" });
    expect(decide(brief(10, { event: { ...brief(10).event!, startsAt: "soon" } }), {})).toMatchObject({ action: "wait", reason: "no-meeting" });
  });
  it("once per meeting: a meeting already cued waits, another meeting cues", () => {
    const b = brief(10);
    const d = decide(b, {});
    expect(d.key).toBe(eventKey(b.event!.startsAt));
    expect(decide(b, { [d.key!]: T0 })).toMatchObject({ action: "wait", reason: "already-cued" });
    expect(decide(brief(11), { [d.key!]: T0 }).action).toBe("cue");
  });
  it("counts minutes on the hub's clock (generatedAt), and on its own clock only without one", () => {
    expect(decide(brief(10), {}, T0 + 3_600_000).action).toBe("cue");
    expect(decide(brief(10, { generatedAt: "" }), {}, T0 + 3_600_000)).toMatchObject({ action: "wait", reason: "started" });
  });
  it("the meeting key is a hash of the start time, not the title", () => {
    const k = decide(brief(10), {}).key!;
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(decide(brief(10, { event: { ...brief(10).event!, title: "Another title" } }), {}).key).toBe(k);
  });
});

// A fake hub with the contract's shapes: GET /api/brief, /api/coach/now, /api/coach/facts and POST /api/coach/cue.
interface Fake {
  url: string;
  brief: Brief;
  memory: BeeMemory;
  cueStatus: number;
  cueBody: unknown;
  cues: unknown[];
  server: Server;
}
async function fakeHub(): Promise<Fake> {
  const f = {
    brief: brief(10),
    memory: { dataLabel: "SYNTHETIC DEMO DATA", synthetic: true, enabled: false, status: "off", goal: null, insights: null, facts: null, note: BEE_MEMORY_NOTE, stopped: false },
    cueStatus: 200,
    cueBody: null as unknown,
    cues: [] as unknown[],
  } as Omit<Fake, "url" | "server">;
  const cueOk: CueResponse = {
    cue: { id: "cue_1", habit: "hedges", text: '[coach] If asked for status: result first, no "I guess".', alarmAt: T0 + 10_000, by: "skill:heartbeat" },
    wrist: { channel: "replay", status: "replay", todoId: null, error: null },
    deduped: false,
    narration: "Cue set: result first, no \"I guess\". It reaches your wrist in about 10 seconds.",
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/api/brief") return send(200, f.brief);
    if (req.method === "GET" && path === "/api/coach/now") return send(200, { dataLabel: "SYNTHETIC DEMO DATA", narration: "This week, unsure words are at 2.6 per 100 words.", mode: { enabled: false }, drills: { dueNow: 2, nextCardId: null } });
    if (req.method === "GET" && path === "/api/coach/facts") return send(200, f.memory);
    if (req.method === "POST" && path === "/api/coach/cue") {
      let raw = "";
      for await (const c of req) raw += c;
      f.cues.push(JSON.parse(raw || "{}"));
      return send(f.cueStatus, f.cueBody ?? cueOk);
    }
    return send(404, { error: "not_found", message: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return Object.assign(f, { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
}

async function cli(hub: string, args: string[], state?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...args, "--hub", hub, ...(state ? ["--state", state] : [])], { out: (s) => out.push(s), err: (s) => err.push(s), now: () => T0, env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("the commands against a fake hub", () => {
  let f: Fake;
  let dir: string;
  let state: string;
  beforeAll(async () => {
    f = await fakeHub();
  });
  afterAll(() => new Promise<void>((r) => f.server.close(() => r())));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "coach-skill-"));
    state = join(dir, "state", "coach-skill.json");
    Object.assign(f, { brief: brief(10), cueStatus: 200, cueBody: null, cues: [] });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("no output and no saved state carries the meeting's title", async () => {
    const runs = [await cli(f.url, ["brief"]), await cli(f.url, ["brief", "--json"]), await cli(f.url, ["heartbeat", "--dry-run"], state), await cli(f.url, ["heartbeat", "--json"], state), await cli(f.url, ["heartbeat"], state)];
    for (const r of runs) {
      expect(r.code).toBe(0);
      expect(`${r.out}\n${r.err}`).not.toContain("Dana");
      expect(`${r.out}\n${r.err}`).not.toContain("Quarterly");
    }
    expect(runs[0]!.out).toContain("Next meeting in 10 min.");
    expect(runs[0]!.out).toContain("unsure words (2.6 per 100 words)");
    expect(readFileSync(state, "utf8")).not.toContain("Dana");
    expect(Object.keys(loadSent(state, T0))).toEqual([eventKey(f.brief.event!.startsAt)]);
  });
  it("heartbeat: one cue per meeting, then it waits", async () => {
    const first = await cli(f.url, ["heartbeat"], state);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Cue for the meeting in 10 min:");
    expect(f.cues).toEqual([{ inMinutes: 0, by: "skill:heartbeat" }]);
    const again = await cli(f.url, ["heartbeat"], state);
    expect(again.out).toContain("No cue: this meeting already had its cue");
    expect(f.cues).toHaveLength(1);
  });
  it("heartbeat: outside the window it sends nothing; --dry-run never sends", async () => {
    f.brief = brief(30);
    expect((await cli(f.url, ["heartbeat"], state)).out).toContain("No cue: the cue goes out 8 to 12 min before (next meeting in 30 min).");
    f.brief = brief(10);
    expect((await cli(f.url, ["heartbeat", "--dry-run"], state)).out).toContain("Would send a cue now (next meeting in 10 min).");
    expect(f.cues).toEqual([]);
  });
  it("heartbeat: a meeting is cued only when a to-do was set for it; a refusal, a failed send or a hub failure is asked again", async () => {
    const answer = (over: Partial<CueResponse>): CueResponse => ({ cue: { id: "cue_0", habit: "hedges", text: "[coach] x", alarmAt: T0 + 10_000, by: "skill:heartbeat" }, wrist: { channel: "bee-todo", status: "scheduled", todoId: "t1", error: null }, deduped: false, narration: "Cue set.", ...over });
    Object.assign(f, { cueStatus: 503, cueBody: { error: "wrist_down", message: "the wrist is down" } });
    expect((await cli(f.url, ["heartbeat"], state)).code).toBe(1);
    expect(loadSent(state, T0)).toEqual({});
    Object.assign(f, { cueStatus: 409, cueBody: { error: "quiet_hours", message: "No cues during quiet hours (22:00 to 08:00)." } });
    const refused = await cli(f.url, ["heartbeat"], state);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("No cues during quiet hours");
    expect(loadSent(state, T0)).toEqual({});
    Object.assign(f, { cueStatus: 200, cueBody: answer({ wrist: { channel: "bee-todo", status: "failed", todoId: null, error: "bee todos create failed" }, cue: { ...answer({}).cue, alarmAt: null } }) });
    expect((await cli(f.url, ["heartbeat"], state)).code).toBe(0);
    expect(loadSent(state, T0)).toEqual({});
    // deduped against the cue for an earlier meeting (its alarm 20 min before this one starts)
    f.cueBody = answer({ deduped: true, cue: { ...answer({}).cue, alarmAt: T0 - 10 * 60_000 }, narration: "That cue went off 10 min ago, so I didn't send another." });
    expect((await cli(f.url, ["heartbeat"], state)).code).toBe(0);
    expect(loadSent(state, T0)).toEqual({});
    expect(f.cues).toHaveLength(4);
    // deduped against a cue already set for this meeting (its alarm in the 12 min before it starts)
    f.cueBody = answer({ deduped: true, narration: "That cue is already set for 1:00 PM, so I didn't send another." });
    expect((await cli(f.url, ["heartbeat"], state)).code).toBe(0);
    expect(Object.keys(loadSent(state, T0))).toEqual([eventKey(f.brief.event!.startsAt)]);
    expect((await cli(f.url, ["heartbeat"], state)).out).toContain("already had its cue");
    expect(f.cues).toHaveLength(5);
  });
  it("cuedFor: a cue sent now, or the same cue already set in the meeting's last 12 minutes", () => {
    const at = T0 + 10 * 60_000; // the meeting starts
    const ok = (body: Partial<CueResponse>, status = 200) => cuedFor({ status, body: { cue: { id: "c", habit: "hedges", text: "[coach] x", alarmAt: T0 + 10_000, by: "skill" }, wrist: { channel: "replay", status: "replay", todoId: null, error: null }, deduped: false, narration: "", ...body } }, at);
    expect(ok({})).toBe(true);
    expect(ok({ wrist: { channel: "bee-todo", status: "scheduled", todoId: "t", error: null } })).toBe(true);
    expect(ok({ wrist: { channel: "bee-todo", status: "failed", todoId: null, error: "x" } })).toBe(false);
    expect(ok({}, 409)).toBe(false);
    for (const [alarmAt, set] of [[at - 12 * 60_000, true], [at, true], [T0 + 5 * 60_000, true], [at - 12 * 60_000 - 1, false], [at + 1, false], [null, false]] as const) {
      expect(ok({ deduped: true, cue: { id: "c", habit: "hedges", text: "[coach] x", alarmAt, by: "skill" } }), String(alarmAt)).toBe(set);
    }
    expect(cuedFor({ status: 0, body: { error: "hub_unreachable" } }, at)).toBe(false);
    expect(cuedFor(null, at)).toBe(false);
  });
  it("cue: posts the minutes, says when it was deduped, and checks --in", async () => {
    const r = await cli(f.url, ["cue", "--in", "5"]);
    expect(r.code).toBe(0);
    expect(f.cues).toEqual([{ inMinutes: 5, by: "skill" }]);
    expect(r.out).toContain("Cue set");
    f.cueBody = { cue: { id: "cue_1", habit: "hedges", text: "[coach] x", alarmAt: null, by: "skill" }, wrist: { channel: "replay", status: "replay", todoId: null, error: null }, deduped: true, narration: "Already sent." } satisfies CueResponse;
    expect((await cli(f.url, ["cue"])).out).toContain("nothing new reached the wrist");
    expect((await cli(f.url, ["cue", "--in", "-3"])).code).toBe(2);
    expect((await cli(f.url, ["cue", "--in", "1.5"])).code).toBe(2);
    expect(f.cues).toHaveLength(2);
  });
  it("goal: off, then a confirmed goal with Bee's counts and the note", async () => {
    const off = await cli(f.url, ["goal"]);
    expect(off.out).toContain("Bee memory is off on this hub");
    expect(off.out).toContain(BEE_MEMORY_NOTE);
    f.memory = { ...f.memory, enabled: true, status: "synced", goal: { factId: "f1", text: 'Speaking goal (Speaking Mirror): fewer unsure words and filler "like".', confirmed: true, updatedAt: T0 }, facts: { count: 12, readAt: T0 }, insights: { count: 0, readAt: T0 } };
    const on = await cli(f.url, ["goal"]);
    expect(on.out).toContain("Goal in Bee: Speaking goal (Speaking Mirror)");
    expect(on.out).toContain("It is a confirmed Bee fact.");
    expect(on.out).toContain("Bee holds 12 facts and 0 insights (counts only).");
  });
  it("goal: after the coach stopped trying, it never says the goal is in Bee (an older hub without `stopped` reads as false)", async () => {
    const text = 'Speaking goal (Speaking Mirror): fewer unsure words and filler "like".';
    f.memory = { ...f.memory, enabled: true, status: "failed", goal: { factId: null, text, confirmed: false, updatedAt: null }, stopped: true };
    const gaveUp = await cli(f.url, ["goal"]);
    expect(gaveUp.code).toBe(0);
    expect(gaveUp.out).not.toContain("Goal in Bee");
    expect(gaveUp.out).not.toContain("Bee has not confirmed it yet.");
    expect(gaveUp.out).toContain(`Goal the coach tried to save in Bee: ${text}`);
    expect(gaveUp.out).toContain("Bee never listed it, so it may not be in Bee at all. The coach stopped trying");
    expect(gaveUp.out).toContain(BEE_MEMORY_NOTE);
    const { stopped: _, ...older } = f.memory;
    f.memory = older as BeeMemory;
    const old = await cli(f.url, ["goal"]);
    expect(old.out).toContain(`Goal in Bee: ${text}`);
    expect(old.out).not.toContain("stopped trying");
  });
  it("status, usage errors and an absent hub", async () => {
    const s = await cli(f.url, ["status"]);
    expect(s.out).toContain("unsure words are at 2.6");
    expect(s.out).toContain("Live coaching: off");
    expect((await cli(f.url, ["nope"])).code).toBe(2);
    expect((await cli("ftp://x", ["status"])).code).toBe(2);
    const away = await cli("http://127.0.0.1:9", ["status"]);
    expect(away.code).toBe(1);
    expect(away.err).toContain("no answer from http://127.0.0.1:9/");
  });
  it("runs as a script: node coach.mjs --help", () => {
    const r = spawnSync(process.execPath, [`${SKILL_DIR}/scripts/coach.mjs`, "--help"], { cwd: new URL(ROOT).pathname, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("usage: coach.mjs <status|brief|goal|cue|heartbeat>");
  });
});

describe("the commands against the demo hub", () => {
  let s: HubServer;
  let setup: ReturnType<typeof demoSetup>;
  beforeAll(async () => {
    setup = demoSetup({ pace: 0.05, stateDir: null });
    s = await startHubServer({ maskTerms: [], port: 0, host: "127.0.0.1", quiet: true, setup, pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
    // a meeting 10 minutes from the demo clock, with a title that must never be printed
    setup.calendar = async () => ({ events: [{ title: TITLE, startsAt: setup.hub.clock() + 10 * 60_000 }], source: "test calendar" });
  });
  afterAll(async () => s.close());
  let out = "";
  beforeEach(() => void (out = ""));
  it("status reads GET /api/coach/now", async () => {
    const r = await run(["status", "--hub", s.url], { out: (l) => void (out += l), err: () => {}, env: {} });
    expect(r).toBe(0);
    expect(out).toContain("Live coaching:");
  });
  it("brief and a dry-run heartbeat see the meeting, never its title", async () => {
    expect(await run(["brief", "--hub", s.url], { out: (l) => void (out += `${l}\n`), err: () => {}, env: {} })).toBe(0);
    expect(await run(["brief", "--json", "--hub", s.url], { out: (l) => void (out += `${l}\n`), err: () => {}, env: {} })).toBe(0);
    expect(await run(["heartbeat", "--dry-run", "--hub", s.url, "--state", join(tmpdir(), "coach-skill-unused.json")], { out: (l) => void (out += `${l}\n`), err: () => {}, env: {} })).toBe(0);
    expect(out).toContain("Next meeting in 10 min.");
    expect(out).toContain("Would send a cue now (next meeting in 10 min).");
    expect(out).not.toContain("Dana");
    expect(out).not.toContain("Quarterly");
  });
  it("heartbeat: a meeting that started 3 min ago never hides the next one, 10 min away (GET /api/brief?upcoming=1)", async () => {
    const calendar = setup.calendar;
    const now = setup.hub.clock();
    setup.calendar = async () => ({ events: [{ title: "Invented sync", startsAt: now - 3 * 60_000 }, { title: TITLE, startsAt: now + 10 * 60_000 }], source: "test calendar" });
    try {
      const brief = async (q: string) => (await (await fetch(`${s.url}/api/brief${q}`)).json()) as Brief;
      expect((await brief("")).event?.startsInMin).toBe(-3); // the brief itself still shows the one under way
      expect((await brief("?upcoming=1")).event).toMatchObject({ title: TITLE, startsInMin: 10 });
      expect((await brief("?upcoming=0")).event?.startsInMin).toBe(-3);
      expect((await fetch(`${s.url}/api/brief?upcoming=yes`)).status).toBe(400);
      expect(await run(["heartbeat", "--dry-run", "--hub", s.url, "--state", join(tmpdir(), "coach-skill-unused.json")], { out: (l) => void (out += `${l}\n`), err: () => {}, env: {} })).toBe(0);
      expect(out).toContain("Would send a cue now (next meeting in 10 min).");
      expect(out).not.toContain("the meeting has started");
      expect(out).not.toContain("Dana");
    } finally {
      setup.calendar = calendar;
    }
  });
  // The cross-packet check with the live plugin's Bee memory and cue routes: skipped only while the
  // hub has no such route (404 not_found); once it does, the skill must render its real answers.
  it("goal and cue render the hub's real answers (skipped until the hub has the routes)", async (t) => {
    const probe = await fetch(`${s.url}/api/coach/facts`);
    const probeBody = (await probe.json()) as { error?: string };
    if (probe.status === 404 && probeBody.error === "not_found") return t.skip();
    let err = "";
    const io = { out: (l: string) => void (out += `${l}\n`), err: (l: string) => void (err += `${l}\n`), env: {} };
    expect(await run(["goal", "--hub", s.url], io)).toBe(0);
    expect(out).toContain(BEE_MEMORY_NOTE);
    expect(out).not.toContain("The hub sent no Bee memory.");
    out = "";
    const code = await run(["cue", "--hub", s.url], io);
    if (code === 0) {
      expect(out).not.toContain("The hub sent no cue.");
      expect(out.split("\n")[0]!.length).toBeGreaterThan(0);
    } else {
      expect(code).toBe(2); // a refusal: its message, never a bare status
      expect(err).toMatch(/^coach: /);
      expect(err).not.toMatch(/HTTP \d{3}|no cue route/);
    }
    expect(`${out}${err}`).not.toContain("Dana");
  });
});
