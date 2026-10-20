// Bee memory (src/hub/live/facts.ts) against a fake Bee CLI (the injected ExecFn) and a virtual
// clock: off by default with no call at all, one goal fact created then confirmed after a
// Bee-verified pass, the same id updated, restarts and timed-out creates that never make a second
// fact, the breaker that leaves live coaching alone, counts only, and a planted marker that never
// reaches Bee, the ledger, the route or the logs. No real Bee call is ever made here.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BEE_MEMORY_NOTE, type Attempt } from "../src/hub/contract.js";
import type { HubEvent } from "../src/hub/core.js";
import { PLANTED_OTHER_MARKER } from "../src/hub/live/demoScripts.js";
import type { LiveEngine } from "../src/hub/live/engine.js";
import { assertGoalText, BeeFacts, beePass, composeGoal, factsModeFor, GOAL_TEXT_RE, LOOK_FIRST_MS, LOOKS_MAX, UPDATE_MIN_MS, type BeeFactsOptions } from "../src/hub/live/facts.js";
import { INSPECT_CALLS, inspect, jsonShape, outputShape, parseFact, parseFactList, parseInsightCount } from "../src/hub/live/factsParse.js";
import { createLivePlugin } from "../src/hub/live/plugin.js";
import { BeeTodoWrist, type ExecFn } from "../src/hub/live/wrist.js";
import type { PluginCtx } from "../src/hub/plugin.js";
import { demoSetup, type Setup } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const timeoutErr = (what: string) => Object.assign(new Error(`Command failed: bee ${what}`), { killed: true, signal: "SIGTERM" });
const exitErr = (stderr: string) => Object.assign(new Error("Command failed: bee facts"), { code: 1, stderr });

interface FakeFact {
  id: number;
  text: string;
  confirmed: boolean;
}
// An in-memory Bee: facts create/confirm/update/list and insights list, in the documented argument
// shapes. `hook` can fail a call (an Error), or let a create land and then time out ("timeout-landed").
function fakeBee(o: { hook?: (args: string[], n: number) => Error | "timeout-landed" | "landed-no-id" | null; others?: FakeFact[]; insights?: number } = {}) {
  const facts: FakeFact[] = [...(o.others ?? [])];
  const calls: string[][] = [];
  let next = 900;
  let now = T0;
  const arg = (a: string[], k: string) => a[a.indexOf(k) + 1]!;
  const exec: ExecFn = async (_file, args) => {
    calls.push(args);
    now += 400;
    const h = o.hook?.(args, calls.length) ?? null;
    if (h instanceof Error) throw h;
    const [a, b] = args;
    if (a === "facts" && b === "create") {
      const f = { id: ++next, text: arg(args, "--text"), confirmed: false };
      facts.push(f);
      if (h === "timeout-landed") throw timeoutErr("facts create");
      if (h === "landed-no-id") return { stdout: "Fact created." };
      return { stdout: JSON.stringify({ ...f, created_at: now }) };
    }
    if (a === "facts" && (b === "confirm" || b === "update")) {
      const f = facts.find((x) => String(x.id) === args[2]);
      if (!f) throw exitErr("Error: fact not found");
      if (b === "confirm") f.confirmed = true;
      else {
        if (args.includes("--text")) f.text = arg(args, "--text");
        if (args.includes("--confirmed")) f.confirmed = arg(args, "--confirmed") === "true";
      }
      return { stdout: JSON.stringify(f) };
    }
    if (a === "facts" && b === "list") {
      const unconfirmed = args.includes("--unconfirmed");
      return { stdout: JSON.stringify({ facts: facts.filter((f) => f.confirmed === !unconfirmed) }) };
    }
    if (a === "insights" && b === "list") return { stdout: JSON.stringify({ insights: Array.from({ length: o.insights ?? 2 }, (_, i) => ({ id: 70 + i, title: `You and Jordan talked about the ${PLANTED_OTHER_MARKER} passcode`, generated_at: now })) }) };
    if (a === "todos") return { stdout: args[1] === "create" ? JSON.stringify({ id: 5000 + calls.length, text: arg(args, "--text"), alarm_at: Date.parse(arg(args, "--alarm-at")) }) : "[]" };
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { exec, facts, calls, factCalls: () => calls.filter((c) => c[0] === "facts" || c[0] === "insights").map((c) => c.slice(0, 3).join(" ")) };
}

let setups: Setup[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((s) => s());
  setups.splice(0).forEach((s) => (s.stop(), s.hub.dispose()));
});

function hub() {
  const s = demoSetup({ pace: 1, stateDir: null });
  setups.push(s);
  return s.hub;
}
function rig(bee: ReturnType<typeof fakeBee>, o: Partial<BeeFactsOptions> & { dir?: string; logs?: { event: string; data?: Record<string, unknown> }[] } = {}) {
  let now = T0;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "facts-"));
  const h = o.hub ?? hub();
  const f = new BeeFacts({ hub: h, mode: "live", stateDir: dir, exec: bee.exec, clock: () => now, sleep: async (ms) => void (now += ms), log: (event, data) => o.logs?.push({ event, data }), countsFirstMs: 1e9, ...o });
  f.start();
  stops.push(() => f.stop());
  return { f, h, dir, advance: (ms: number) => void (now += ms), ledger: () => JSON.parse(readFileSync(join(dir, "live", "facts.json"), "utf8")) };
}
// A Bee-verified pass, published the way the hub does (attempt.graded).
function pass(h: ReturnType<typeof hub>, mutate?: (a: Attempt) => void) {
  const base = h.attempts.filter(beePass).at(-1)!;
  const a: Attempt = { ...structuredClone(base), id: `att_test_${h.attempts.length}` };
  mutate?.(a);
  h.attempts.push(a);
  h.dataChanged();
  h.publish("attempt.graded", { attempt: a });
  return a;
}

describe("factsModeFor: opt-in, live mode only", () => {
  it("off unless COACH_FACTS=1, live, with the Bee stream", () => {
    expect(factsModeFor({ demo: false, stream: true, env: {} })).toBe("off");
    expect(factsModeFor({ demo: false, stream: true, env: { COACH_FACTS: "0" } })).toBe("off");
    expect(factsModeFor({ demo: false, stream: false, env: { COACH_FACTS: "1" } })).toBe("off");
    expect(factsModeFor({ demo: false, stream: true, env: { COACH_FACTS: "1" } })).toBe("live");
    expect(factsModeFor({ demo: true, stream: true, env: { COACH_FACTS: "1" } })).toBe("demo");
  });
});

describe("the goal text", () => {
  it("is the template, from the transfer's numbers, the habit names and Bee's passes", () => {
    const d = composeGoal(hub())!;
    expect(d.text).toBe('Speaking goal (Speaking Mirror): fewer unsure words and filler "like". Since Oct 15: unsure words 2.1 → 0.6 per 100 words; filler "like" 2.5 → 0.8 per 100 words; 4 lines passed, checked by Bee.');
    expect(d.verdictKey).toBe("hedges:dropped|filler:like:dropped");
    expect(GOAL_TEXT_RE.test(d.text)).toBe(true);
    // the plan's example passes the same guard
    expect(() => assertGoalText('Speaking goal (Speaking Mirror): fewer unsure words and filler "like". Since Oct 17: unsure words 2.6 → 0.8 per 100 words; filler "like" needs more speech; 3 lines passed, checked by Bee.')).not.toThrow();
  });
  it("the guard refuses anything else: a transcript line, a name, another speaker's words", () => {
    for (const t of ["I guess we could maybe ship it", `Speaking goal (Speaking Mirror): fewer unsure words. Since Oct 15: unsure words 2.1 → 0.6 per 100 words; 4 lines passed, checked by Bee. ${PLANTED_OTHER_MARKER}`, 'Speaking goal (Speaking Mirror): fewer Jordan. So far: unsure words needs more speech; 1 line passed, checked by Bee.']) expect(() => assertGoalText(t)).toThrow();
  });
});

describe("off by default", () => {
  it("makes no Bee call at all: no fact, no count, no subscription (the plugin on a live hub, COACH_FACTS unset)", async () => {
    const prev = process.env.COACH_FACTS;
    delete process.env.COACH_FACTS;
    try {
      const bee = fakeBee();
      const s = demoSetup({ pace: 1, stateDir: null });
      setups.push(s);
      const dir = mkdtempSync(join(tmpdir(), "facts-off-"));
      let facts: BeeFacts | null = null;
      const plugin = createLivePlugin({ exec: bee.exec, onFacts: (f) => (facts = f) });
      const ctx = { hub: s.hub, setup: { ...s, stream: {} }, stateDir: dir, pace: 1, demo: false, fixtureV2: false, log: () => {}, publish: (t: any, d: any) => s.hub.publish(t, d) } as unknown as PluginCtx;
      plugin.attach!(ctx);
      stops.push(() => plugin.stop!());
      pass(s.hub);
      s.hub.publishStats();
      await facts!.tick();
      await facts!.sync("pass");
      expect(facts!.mode).toBe("off");
      expect(bee.factCalls()).toEqual([]);
      expect(bee.calls.every((c) => c[0] === "todos")).toBe(true); // only the wrist's start-up sweep
      expect(facts!.memory()).toEqual({ dataLabel: s.hub.dataLabel, synthetic: false, enabled: false, status: "off", goal: null, insights: null, facts: null, note: BEE_MEMORY_NOTE });
    } finally {
      if (prev === undefined) delete process.env.COACH_FACTS;
      else process.env.COACH_FACTS = prev;
    }
  });
  it("demo shows the goal it would write and calls nothing", async () => {
    const bee = fakeBee();
    const h = hub();
    const f = new BeeFacts({ hub: h, mode: "demo", stateDir: null, exec: bee.exec });
    f.start();
    pass(h);
    await f.tick();
    expect(bee.calls).toEqual([]);
    expect(f.memory()).toMatchObject({ enabled: true, status: "demo", synthetic: true, goal: { factId: null, confirmed: false, text: expect.stringMatching(GOAL_TEXT_RE) }, insights: null, facts: null, note: BEE_MEMORY_NOTE });
  });
});

describe("one goal fact (COACH_FACTS=1)", () => {
  it("a Bee-verified pass creates one fact, then confirms it", async () => {
    const bee = fakeBee();
    const r = rig(bee);
    expect(r.f.memory()).toMatchObject({ enabled: true, status: "pending", goal: null });
    const failed = { ...structuredClone(r.h.attempts.filter(beePass)[0]!), id: "att_fail", final: { source: "bee" as const, pass: false, grade: r.h.attempts.filter(beePass)[0]!.final!.grade } };
    r.h.publish("attempt.graded", { attempt: failed }); // a failed attempt writes nothing
    await r.f.settle();
    expect(bee.calls).toEqual([]);
    pass(r.h);
    await r.f.settle();
    const text = composeGoal(r.h)!.text;
    expect(bee.calls).toEqual([
      ["facts", "create", "--text", text, "--json"],
      ["facts", "confirm", "901", "--json"],
    ]);
    expect(bee.facts).toEqual([{ id: 901, text, confirmed: true }]);
    expect(r.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901", text, confirmed: true, updatedAt: expect.any(Number) }, note: BEE_MEMORY_NOTE });
    expect(r.ledger().goal).toMatchObject({ factId: "901", text, confirmed: true });
    expect(r.ledger().pendingCreate).toBeNull();
  });
  it("a second pass updates the same id (a text-only change at most every 10 min); a verdict change updates at once", async () => {
    const bee = fakeBee();
    const r = rig(bee);
    pass(r.h);
    await r.f.settle();
    pass(r.h); // 6 passes now: the count changed, the verdicts did not, and it is under 10 min
    await r.f.settle();
    expect(bee.factCalls()).toEqual(["facts create --text", "facts confirm 901"]);
    r.advance(UPDATE_MIN_MS);
    pass(r.h);
    await r.f.settle();
    const t7 = composeGoal(r.h)!.text;
    expect(t7).toMatch(/; 7 lines passed, checked by Bee\.$/);
    expect(bee.calls.at(-1)).toEqual(["facts", "update", "901", "--text", t7, "--confirmed", "true", "--json"]);
    // the verdicts change (no speech since the first drill): stats.updated updates the same id at once
    const cut = Math.min(...r.h.transfer()!.habits.filter((h) => h.role === "drilled").map((h) => h.firstDrillAt!));
    r.h.sessions = r.h.sessions.filter((s) => s.startMs < cut);
    r.h.dataChanged();
    await r.f.sync("stats");
    const tv = composeGoal(r.h)!;
    expect(tv.verdictKey).not.toBe("hedges:dropped|filler:like:dropped");
    expect(bee.calls.at(-1)).toEqual(["facts", "update", "901", "--text", tv.text, "--confirmed", "true", "--json"]);
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(bee.facts).toEqual([{ id: 901, text: tv.text, confirmed: true }]);
    expect(r.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901", text: tv.text } });
  });
  it("a restart never makes a second fact (the ledger), and nothing is called when nothing changed", async () => {
    const bee = fakeBee();
    const a = rig(bee);
    pass(a.h);
    await a.f.settle();
    a.f.stop();
    const n = bee.calls.length;
    const b = rig(bee, { dir: a.dir, hub: a.h });
    expect(b.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901", confirmed: true } });
    a.h.publish("attempt.graded", { attempt: a.h.attempts.at(-1)! }); // the same pass again: same text
    await b.f.settle();
    expect(bee.calls.length).toBe(n);
    expect(bee.facts).toHaveLength(1);
  });
  it("a create that timed out but landed is adopted (no duplicate), then confirmed", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? "timeout-landed" : null) });
    const logs: { event: string }[] = [];
    const r = rig(bee, { logs });
    pass(r.h);
    await r.f.settle();
    expect(bee.factCalls()).toEqual(["facts create --text", "facts list --unconfirmed", "facts confirm 901"]);
    expect(bee.facts).toHaveLength(1);
    expect(r.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901", confirmed: true } });
    expect(logs.map((l) => l.event)).toContain("facts.goal.adopted");
  });
  it("a restart during a create looks for it first and adopts it (the intent was written before the call)", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? "timeout-landed" : a[1] === "list" ? new Error("network down") : null) });
    const a = rig(bee);
    pass(a.h);
    await a.f.settle();
    expect(a.ledger().pendingCreate).toMatchObject({ outcome: "unknown" });
    expect(a.f.memory().status).toBe("failed");
    a.f.stop();
    const ok = fakeBee({ others: bee.facts.map((f) => ({ ...f })) });
    const b = rig(ok, { dir: a.dir, hub: a.h });
    await b.f.settle(); // start() adopts it without a pass
    expect(ok.factCalls()).toEqual(["facts list --unconfirmed", "facts confirm 901"]);
    expect(b.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901" } });
  });
  it("the create's intent is on disk before the call returns (a hub stopped mid-call looks for it, never creates again)", async () => {
    const bee = fakeBee();
    let release: () => void = () => {};
    const held: ExecFn = (f, a, o) => (a[1] === "create" ? new Promise((res) => (release = () => void bee.exec(f, a, o).then(res))) : bee.exec(f, a, o));
    const r = rig({ ...bee, exec: held });
    pass(r.h);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.ledger()).toMatchObject({ goal: null, pendingCreate: { text: composeGoal(r.h)!.text, outcome: "unknown" } });
    release();
    await r.f.settle();
    expect(r.ledger()).toMatchObject({ goal: { factId: "901", confirmed: true }, pendingCreate: null });
  });
  it("a create that exited 0 without an id is never made again, even after more passes", async () => {
    // the output shape is unknown: here neither the create's output nor the list gives the fact back
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? "landed-no-id" : null) });
    const blind: ExecFn = async (f, a, o) => (a[1] === "list" ? { stdout: "[]" } : bee.exec(f, a, o));
    const r = rig({ ...bee, exec: blind });
    pass(r.h);
    await r.f.settle();
    expect(r.f.calls.map((c) => c.args.join(" "))).toEqual(["facts create", "facts list", "facts list"]);
    expect(r.ledger().pendingCreate).toMatchObject({ outcome: "landed" });
    r.advance(UPDATE_MIN_MS);
    pass(r.h);
    await r.f.settle();
    expect(r.f.calls.filter((c) => c.args[1] === "create")).toHaveLength(1);
    expect(r.f.memory()).toMatchObject({ status: "failed", goal: { factId: null, confirmed: false } });
  });
  it("a create that timed out and never shows up is never made again: looked for at most 5 times, further apart, then failed", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? timeoutErr("facts create") : null) }); // it did not land
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const r = rig(bee, { logs });
    const looks = () => bee.factCalls().filter((c) => c === "facts list --unconfirmed").length;
    pass(r.h);
    await r.f.settle();
    expect(bee.factCalls()).toEqual(["facts create --text", "facts list --unconfirmed", "facts list --limit"]); // look 1, at once
    expect(r.ledger().pendingCreate).toMatchObject({ outcome: "unknown", looks: 1, nextLookAt: expect.any(Number) });
    expect(r.f.memory()).toMatchObject({ status: "failed", goal: { factId: null } });
    pass(r.h); // before the next look is due: no call at all
    await r.f.settle();
    expect(looks()).toBe(1);
    for (let i = 2; i <= LOOKS_MAX; i++) {
      r.advance(LOOK_FIRST_MS * 2 ** (i - 2));
      pass(r.h);
      await r.f.settle();
      expect(looks(), `look ${i}`).toBe(i);
    }
    expect(r.ledger().pendingCreate).toMatchObject({ looks: LOOKS_MAX, nextLookAt: null });
    expect(r.f.describe()).toBe("live (failed: Bee never listed the goal create, so it is not made again; see docs/live.md)");
    expect(logs.filter((l) => l.event === "facts.goal.failed").at(-1)?.data?.error).toMatch(/stopped looking and never creates it again/);
    r.advance(6 * 3600_000);
    pass(r.h);
    await r.f.sync("stats");
    await r.f.tick(); // the counts only
    expect(looks()).toBe(LOOKS_MAX);
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(bee.facts).toHaveLength(0);
    expect(r.f.memory()).toMatchObject({ status: "failed", goal: { factId: null, confirmed: false } });
    // a restart keeps it: no look, no create, still failed
    r.f.stop();
    const b = rig(bee, { dir: r.dir, hub: r.h });
    pass(r.h);
    await b.f.settle();
    expect(looks()).toBe(LOOKS_MAX);
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(b.f.memory().status).toBe("failed");
  });
  it("a look that could not read Bee's lists does not count toward the 5", async () => {
    let down = true;
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? timeoutErr("facts create") : a[1] === "list" && down ? new Error("bee: 503 Service Unavailable") : null) });
    const r = rig(bee, { breakerThreshold: 99 });
    pass(r.h);
    await r.f.settle();
    expect(r.ledger().pendingCreate).toMatchObject({ looks: 0, nextLookAt: expect.any(Number) });
    expect(r.f.memory().status).toBe("failed");
    down = false;
    r.advance(LOOK_FIRST_MS);
    pass(r.h);
    await r.f.settle();
    expect(r.ledger().pendingCreate).toMatchObject({ looks: 1, nextLookAt: expect.any(Number) });
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
  });
  it("the look follows Bee's list past its first page (the cursor), and adopts the fact it finds there", async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, text: `Invented fact ${i}`, confirmed: true }));
    const bee = fakeBee({ others, hook: (a) => (a[1] === "create" ? "timeout-landed" : null) });
    const lists: string[][] = [];
    const paged: ExecFn = async (f, a, o) => {
      if (a[1] === "list") lists.push(a);
      if (a[1] === "create") {
        try {
          return await bee.exec(f, a, o);
        } finally {
          bee.facts.at(-1)!.confirmed = true; // Bee confirmed it at once, so it sits after 100 others
        }
      }
      if (a[0] === "facts" && a[1] === "list" && !a.includes("--unconfirmed")) {
        const all = bee.facts.filter((x) => x.confirmed);
        return { stdout: JSON.stringify(a.includes("--cursor") ? { facts: all.slice(100) } : { facts: all.slice(0, 100), next_cursor: "c2" }) };
      }
      return bee.exec(f, a, o);
    };
    const r = rig({ ...bee, exec: paged });
    pass(r.h);
    await r.f.settle();
    expect(r.f.calls.map((c) => c.args.join(" "))).toEqual(["facts create", "facts list", "facts list", "facts list"]);
    expect(lists).toEqual([
      ["facts", "list", "--unconfirmed", "--limit", "100", "--json"],
      ["facts", "list", "--limit", "100", "--json"],
      ["facts", "list", "--limit", "100", "--cursor", "c2", "--json"],
    ]);
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(r.f.memory()).toMatchObject({ status: "synced", goal: { factId: "901", confirmed: true } });
  });
  it("while a create is stuck, stats.updated never looks for it: no list call, no ledger write, no log line", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? "landed-no-id" : null) });
    const blind: ExecFn = async (f, a, o) => (a[1] === "list" ? { stdout: "[]" } : bee.exec(f, a, o));
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const r = rig({ ...bee, exec: blind }, { logs, statsDebounceMs: 1 });
    pass(r.h);
    await r.f.settle();
    const n = r.f.calls.length;
    const lines = logs.length;
    const ledgerIno = statSync(join(r.dir, "live", "facts.json")).ino; // each save renames a new file in
    for (let i = 0; i < 5; i++) {
      r.advance(UPDATE_MIN_MS);
      r.h.publish("stats.updated", {});
      await new Promise((res) => setTimeout(res, 5));
      await r.f.sync("stats");
    }
    expect(r.f.calls.length).toBe(n);
    expect(logs.length).toBe(lines);
    expect(statSync(join(r.dir, "live", "facts.json")).ino).toBe(ledgerIno);
    expect(r.f.memory()).toMatchObject({ status: "failed", goal: { factId: null } });
  });
  it("the look timer looks again without a pass, then stops", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? timeoutErr("facts create") : null) });
    const h = hub();
    const f = new BeeFacts({ hub: h, mode: "live", stateDir: mkdtempSync(join(tmpdir(), "facts-look-")), exec: bee.exec, minGapMs: 0, countsFirstMs: 1e9, lookFirstMs: 5, looksMax: 3 });
    f.start();
    stops.push(() => f.stop());
    pass(h);
    await f.settle();
    for (let i = 0; i < 40 && bee.factCalls().filter((c) => c === "facts list --unconfirmed").length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await f.settle();
    expect(bee.factCalls().filter((c) => c === "facts list --unconfirmed")).toHaveLength(3);
    expect(bee.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(f.memory().status).toBe("failed");
  });
  it("a fact deleted in the Bee app is forgotten, and the next pass writes one goal fact again", async () => {
    const bee = fakeBee();
    const r = rig(bee);
    pass(r.h);
    await r.f.settle();
    bee.facts.length = 0; // the wearer deleted it
    r.advance(UPDATE_MIN_MS);
    pass(r.h);
    await r.f.settle();
    expect(r.f.memory()).toMatchObject({ status: "pending", goal: null });
    pass(r.h);
    await r.f.settle();
    expect(bee.facts).toHaveLength(1);
    expect(r.f.memory()).toMatchObject({ status: "synced", goal: { factId: "902" } });
  });
});

describe("the breaker", () => {
  it("opens after 3 failed calls and stops calling; live coaching and the wrist are unaffected", async () => {
    const bee = fakeBee({ hook: (a) => (a[0] === "facts" || a[0] === "insights" ? new Error("bee: 503 Service Unavailable") : null) });
    const s = demoSetup({ pace: 1, stateDir: null });
    setups.push(s);
    const dir = mkdtempSync(join(tmpdir(), "facts-breaker-"));
    let engine: LiveEngine | null = null;
    let facts: BeeFacts | null = null;
    let wrist: BeeTodoWrist | null = null;
    const events: HubEvent[] = [];
    s.hub.on("event", (e: HubEvent) => events.push(e));
    const plugin = createLivePlugin({ exec: bee.exec, factsMode: "live", facts: { countsFirstMs: 1e9, minGapMs: 0 }, wrist: () => (wrist = new BeeTodoWrist({ exec: bee.exec, ledgerPath: null, minGapMs: 0 })), onEngine: (e) => (engine = e), onFacts: (f) => (facts = f) });
    const ctx = { hub: s.hub, setup: { ...s, stream: {} }, stateDir: dir, pace: 1, demo: false, fixtureV2: false, log: () => {}, publish: (t: any, d: any) => s.hub.publish(t, d) } as unknown as PluginCtx;
    plugin.attach!(ctx);
    stops.push(() => plugin.stop!());
    engine!.setMode({ enabled: true, by: "test" });
    pass(s.hub);
    await facts!.settle(); // create fails (1)
    await facts!.tick(); // insights list (2), facts list (3): open
    expect(facts!.circuitOpenUntil()).not.toBeNull();
    const n = bee.factCalls().length;
    expect(n).toBe(3);
    pass(s.hub);
    await facts!.settle();
    await facts!.tick();
    expect(bee.factCalls().length).toBe(n); // open: no call
    expect(facts!.memory().status).toBe("failed");
    // live coaching carries on: mode still on, the wrist healthy and still creating to-dos
    expect(engine!.state().mode).toMatchObject({ enabled: true, reason: "on" });
    expect(engine!.state().wrist).toMatchObject({ healthy: true, failures: 0, circuitOpenUntil: null });
    expect(events.some((e) => e.topic === "live.mode" && (e.payload as any).mode?.reason === "wrist-down")).toBe(false);
    expect(await wrist!.send({ kind: "nudge", refId: "n1", text: "[coach] 4 unsure words in 2 minutes. Say it plainly." })).toMatchObject({ status: "scheduled" });
  });
});

describe("counts only, every 6 h", () => {
  it("reads insights and facts counts (paged), never their text", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, text: `Jordan's ${PLANTED_OTHER_MARKER} code is 4417`, confirmed: true }));
    const bee = fakeBee({ insights: 3 });
    const paged: ExecFn = async (f, a, o) => (a[0] === "facts" && a[1] === "list" && !a.includes("--unconfirmed") ? { stdout: JSON.stringify(a.includes("--cursor") ? { facts: page(20, 200) } : { facts: page(100, 100), next_cursor: "c2" }) } : bee.exec(f, a, o));
    const r = rig({ ...bee, exec: paged });
    await r.f.tick();
    expect(r.f.memory()).toMatchObject({ insights: { count: 3, readAt: expect.any(Number) }, facts: { count: 120, readAt: expect.any(Number) } });
    expect(r.f.calls.map((c) => c.args.join(" "))).toEqual(["insights list", "facts list", "facts list"]);
    expect(r.ledger()).toMatchObject({ insights: { count: 3 }, facts: { count: 120 } });
  });
  it("the timer reads them on start and every 6 h", async () => {
    const bee = fakeBee();
    const h = hub();
    const f = new BeeFacts({ hub: h, mode: "live", stateDir: null, exec: bee.exec, minGapMs: 0, countsFirstMs: 5, countsEveryMs: 40 });
    f.start();
    stops.push(() => f.stop());
    await new Promise((r) => setTimeout(r, 70));
    await f.settle();
    expect(bee.factCalls().filter((c) => c === "insights list --limit").length).toBeGreaterThanOrEqual(2);
  });
});

describe("one Bee call at a time", () => {
  it("the count read and a pass's create and confirm run on one chain: never two calls at once, always the gap apart", async () => {
    const bee = fakeBee();
    let inFlight = 0;
    let most = 0;
    const spans: { start: number; end: number }[] = [];
    const slow: ExecFn = async (f, a, o) => {
      most = Math.max(most, ++inFlight);
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await bee.exec(f, a, o);
      } finally {
        inFlight--;
        spans.push({ start, end: Date.now() });
      }
    };
    const h = hub();
    const f = new BeeFacts({ hub: h, mode: "live", stateDir: mkdtempSync(join(tmpdir(), "facts-chain-")), exec: slow, minGapMs: 20, countsFirstMs: 1e9 });
    f.start();
    stops.push(() => f.stop());
    pass(h); // the pass's sync is queued first; the count reads and the tick come while it runs
    await Promise.all([f.readCounts(), f.tick()]);
    await f.settle();
    expect(bee.factCalls()).toEqual(["facts create --text", "facts confirm 901", "insights list --limit", "facts list --limit", "insights list --limit", "facts list --limit"]);
    expect(most).toBe(1);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start - spans[i - 1]!.end, `call ${i}`).toBeGreaterThanOrEqual(19);
  });
});

describe("privacy", () => {
  it("a planted marker (a wearer line, another speaker in Bee's facts and insights) never reaches Bee, the ledger, the route or the logs", async () => {
    const other = { id: 55, text: `Jordan said the ${PLANTED_OTHER_MARKER} passcode is 4417`, confirmed: false };
    const bee = fakeBee({ others: [other, { ...other, id: 56, confirmed: true }] });
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const h = hub();
    h.sessions = [...h.sessions, { id: "planted", kind: "conversation", startMs: Date.parse("2026-10-19T15:00:00Z"), lines: [{ key: "u:planted:0", text: `I guess the ${PLANTED_OTHER_MARKER} thing is fine`, dom: "en", uncertain: false }], synthetic: true } as any];
    h.dataChanged();
    const r = rig(bee, { hub: h, logs, minGapMs: 0 });
    pass(h, (a) => (a.bee = { ...a.bee!, text: `um the ${PLANTED_OTHER_MARKER} passcode is 4417` }));
    await r.f.settle();
    await r.f.tick();
    r.advance(UPDATE_MIN_MS);
    pass(h);
    await r.f.settle();
    const written = bee.calls.filter((c) => c[1] === "create" || c[1] === "update").map((c) => c[c.indexOf("--text") + 1]!);
    expect(written.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify([written, readFileSync(join(r.dir, "live", "facts.json"), "utf8"), r.f.memory(), logs]);
    expect(all).not.toContain(PLANTED_OTHER_MARKER);
    expect(all).not.toContain("4417");
    expect(all).not.toContain("Jordan");
    for (const t of written) expect(GOAL_TEXT_RE.test(t)).toBe(true);
  });
});

describe("the read-only spike (npx tsx src/hub/live/factsParse.ts inspect)", () => {
  it("runs only list calls and prints shapes and counts, never a fact's or an insight's text", async () => {
    const other = { id: 55, text: `Jordan said the ${PLANTED_OTHER_MARKER} passcode is 4417`, confirmed: false };
    const bee = fakeBee({ others: [other, { ...other, id: 56, confirmed: true }] });
    const lines: string[] = [];
    const notice: ExecFn = async (f, a, o) => {
      const r = await bee.exec(f, a, o);
      return { stdout: `A new version of bee is available (${PLANTED_OTHER_MARKER}).\n${r.stdout}` };
    };
    expect(await inspect({ exec: notice, print: (l) => lines.push(l) })).toBe(0);
    expect(bee.calls).toEqual(INSPECT_CALLS.map((c) => [...c]));
    expect(bee.calls.every((c) => c[1] === "list")).toBe(true);
    const out = lines.join("\n");
    expect(out).not.toContain(PLANTED_OTHER_MARKER);
    expect(out).not.toContain("Jordan");
    expect(out).not.toContain("4417");
    const [all, unconfirmed, insights] = lines.map((l) => JSON.parse(l));
    expect(all).toMatchObject({ command: "bee facts list --limit 5 --json", ok: true, output: { json: true, lines: 2, shape: { facts: { array: 1, of: { id: "number", text: "string", confirmed: "boolean" } } } }, parsed: { count: 1, confirmed: 1 } });
    expect(unconfirmed.parsed).toMatchObject({ count: 1, unconfirmed: 1 });
    expect(insights).toMatchObject({ ok: true, parsed: { count: 2 } });
    // a failed call says how it failed, not what it printed
    const failing: ExecFn = async () => {
      throw Object.assign(new Error(`Command failed: bee facts list\n${PLANTED_OTHER_MARKER}`), { code: 2 });
    };
    const flines: string[] = [];
    expect(await inspect({ exec: failing, print: (l) => flines.push(l) })).toBe(1);
    expect(flines.join("\n")).not.toContain(PLANTED_OTHER_MARKER);
    expect(JSON.parse(flines[0]!)).toMatchObject({ ok: false, error: "exit 2" });
  });
  it("jsonShape keeps keys and types only; a key that may be data is not shown", () => {
    expect(jsonShape({ facts: [{ id: 1, text: "secret", confirmed: true, tags: null }], next_cursor: "abc", "Jordan Quill": 1 })).toEqual({ facts: { array: 1, of: { id: "number", text: "string", confirmed: "boolean", tags: "null" } }, next_cursor: "string", "<key>": "1 key(s) that are not field names" });
    expect(outputShape("Created.")).toEqual({ json: false, shape: null, lines: 1 });
    expect(JSON.stringify(outputShape(`{"text":"${PLANTED_OTHER_MARKER}"}`))).not.toContain(PLANTED_OTHER_MARKER);
  });
  it("the hub logs only the shape of a create output it cannot read", async () => {
    const bee = fakeBee({ hook: (a) => (a[1] === "create" ? "landed-no-id" : null) });
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const r = rig(bee, { logs });
    pass(r.h);
    await r.f.settle();
    expect(logs.find((l) => l.event === "facts.create.unreadable")?.data).toEqual({ output: { json: false, shape: null, lines: 1 } });
  });
});

describe("the parsers (the JSON shape is unverified: defensive)", () => {
  it("one fact: plain, wrapped, string ids, notice lines; null otherwise", () => {
    expect(parseFact('{"id":901,"text":"x","confirmed":false}')).toEqual({ id: "901", text: "x", confirmed: false });
    expect(parseFact('{"fact":{"id":"f_1","text":"y","confirmed":true}}')).toEqual({ id: "f_1", text: "y", confirmed: true });
    expect(parseFact('{"data":{"id":3,"text":"z"}}')).toEqual({ id: "3", text: "z", confirmed: null });
    expect(parseFact('A new version of bee is available.\n{"id": 4, "text": "w", "confirmed": 1}')).toEqual({ id: "4", text: "w", confirmed: true });
    expect(parseFact("Fact created.")).toBeNull();
    expect(parseFact('{"ok":true}')).toBeNull();
    expect(parseFact("[]")).toBeNull();
  });
  it("a list: array or wrapped, with or without a cursor; [] on anything else", () => {
    expect(parseFactList('[{"id":1,"text":"a","confirmed":true},{"text":"no id"}]')).toEqual({ items: [{ id: "1", text: "a", confirmed: true }], cursor: null });
    expect(parseFactList('{"facts":[{"id":2,"text":"b"}],"next_cursor":"abc"}')).toEqual({ items: [{ id: "2", text: "b", confirmed: null }], cursor: "abc" });
    expect(parseFactList('{"items":[{"id":3}],"nextCursor":7}').cursor).toBe("7");
    expect(parseFactList("nothing")).toEqual({ items: [], cursor: null });
    expect(parseInsightCount('{"insights":[{"id":1,"title":"t"},{"id":2}]}')).toEqual({ count: 2, cursor: null });
    expect(parseInsightCount("[]")).toEqual({ count: 0, cursor: null });
    expect(parseInsightCount("no json")).toBeNull();
  });
});
