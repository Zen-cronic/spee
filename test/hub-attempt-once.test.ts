// An attempt counts at most once, and never hangs: a restart closes what the last hub left waiting for
// Bee, and one Bee line verifies one attempt even when the phone and Alexa both previewed it.
import { describe, expect, it } from "vitest";
import { BeeVerifier, type BeeEvent, type Verification } from "../src/hub/bee.js";
import { CoachHub, type Attempt } from "../src/hub/core.js";
import { demoSetup, wearerRule } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const TARGET = "The billing export is ready for review today.";
const utt = (id: number, text: string, endMs: number, durS = 3): BeeEvent => ({ type: "new-utterance", conversation_uuid: "conv-1", utterance: { id, sample_id: `s${id}`, start: 10, end: 10 + durS, text, spoken_at: new Date(endMs - durS * 1000).toISOString() } });
const tag = (id: number): BeeEvent => ({ type: "tagged-utterance", utterance_id: id, person_id: 7, person_first_name: "Ada", speaker_score: 0.82, conversation_uuid: "conv-1" });

describe("an attempt left waiting for Bee by a hub restart", () => {
  it("is closed as unverified on the next start, so the verdict answers instead of 'ask again'", () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    const first = setup.hub;
    first.openCard({ by: "alexa" });
    const a = first.submit({ text: "the billing export", source: "alexa" }) as Attempt;
    expect(a.status).toBe("pending_bee");
    const saved: Attempt[] = JSON.parse(JSON.stringify(first.attempts)); // what attempts.json holds
    setup.stop(); // the demo director's replay timers, so nothing ingests into a disposed hub (review L30)
    first.dispose();

    const opts = (first as unknown as { opts: ConstructorParameters<typeof CoachHub>[0] }).opts;
    const second = new CoachHub({ ...opts, attempts: saved });
    const v = second.verdict(a.id)!;
    expect(v.status).toBe("unverified");
    expect(v.attempt.counted).toBe(false);
    expect(v.verdictReady).toBe(true);
    expect(v.retryAfterMs).toBeNull();
    expect(v.narration).toMatch(/Try it again/);
    expect(v.attempt.reason).toMatch(/hub restarted/);
    // Settled attempts are left as they were.
    expect(second.attempts.filter((x) => x.status === "pending_bee" || x.status === "polling")).toHaveLength(0);
    expect(second.attempts.filter((x) => x.id !== a.id)).toEqual(saved.filter((x) => x.id !== a.id));
    second.dispose();
  });
});

describe("one Bee line, two previews", () => {
  it("verifies one attempt; the other ends unverified and is not counted", async () => {
    let now = T0;
    const out: Verification[] = [];
    const v = new BeeVerifier({ clock: () => now, rule: wearerRule({ first_name: "Ada", last_name: "Demo" }, ""), onVerification: (x) => out.push(x), onBeeAttempt: () => {} });
    v.openCard({ cardId: "c1", resay: TARGET, lang: "en", openedAt: T0 - 5000 });
    // The phone and Alexa both heard the same sentence (or Alexa retried the request).
    v.expect({ attemptId: "phone", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    v.expect({ attemptId: "alexa", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 + 200 });
    now += 5500;
    v.ingest(utt(1, TARGET, T0));
    v.ingest(tag(1));
    expect(out.filter((x) => x.status === "verified")).toHaveLength(1);
    now = T0 + 46_000;
    await v.tick();
    expect(out).toHaveLength(2);
    expect(out.filter((x) => x.status === "verified")).toHaveLength(1);
    expect(out.find((x) => x.status === "unverified")?.beeUtteranceIds).toEqual([]);
  });
});

describe("a Bee line counts once, and only after the card opened", () => {
  const verifier = (now: () => number) => {
    const out: Verification[] = [];
    const beeOnly: unknown[] = [];
    const v = new BeeVerifier({ clock: now, rule: wearerRule({ first_name: "Ada", last_name: "Demo" }, ""), onVerification: (x) => out.push(x), onBeeAttempt: (x) => beeOnly.push(x) });
    return { v, out, beeOnly };
  };
  it("a counted line resent after the buffer forgot it is a duplicate (review L42)", () => {
    let now = T0;
    const { v, beeOnly } = verifier(() => now);
    v.openCard({ cardId: "c1", resay: TARGET, lang: "en", openedAt: T0 - 5000 });
    now += 4000;
    v.ingest(utt(1, TARGET, T0));
    v.ingest(tag(1));
    expect(beeOnly).toHaveLength(1);
    now += 4 * 60_000; // past the 180 s buffer
    v.purge();
    v.ingest(utt(1, TARGET, T0)); // a restarted bee stream resends it
    v.ingest(tag(1));
    expect(beeOnly).toHaveLength(1);
  });
  it("a wearer line from before the card opened never joins a split attempt (review L41)", () => {
    const opened = T0 - 2000;
    let now = opened - 200;
    const { v, out } = verifier(() => now);
    v.ingest(utt(1, "Um, okay, quiz me.", opened - 500, 1)); // said, and delivered by Bee, before the card opened
    v.ingest(tag(1));
    now = T0;
    v.openCard({ cardId: "c1", resay: TARGET, lang: "en", openedAt: opened });
    v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: opened + 200, speechEndMs: T0 });
    now += 5000;
    // Bee split the attempt so neither half matches alone, and the group decides
    v.ingest(utt(2, "The billing export", T0 - 1500, 1));
    v.ingest(tag(2));
    expect(out).toHaveLength(0);
    v.ingest(utt(3, "is ready for review today.", T0, 2));
    v.ingest(tag(3));
    const ok = out.find((x) => x.status === "verified");
    expect(ok?.beeUtteranceIds).toEqual([2, 3]);
  });
});

describe("today's drill tally on the screens", () => {
  it("is in the join snapshot, and stats.updated goes out again when the hub's local day turns", () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    setup.stop();
    setup.hub.dispose();
    const opts = (setup.hub as unknown as { opts: ConstructorParameters<typeof CoachHub>[0] }).opts;
    // 23:59:58 in Toronto (EDT, UTC-4) on 2026-10-20, with two drills earlier that day.
    let now = Date.parse("2026-10-21T03:59:58Z");
    const earlier = (id: string, h: number): Attempt => ({ ...(opts.attempts ?? [])[0]!, id, status: "graded", counted: true, final: { source: "bee", pass: true } as Attempt["final"], createdAt: now - h * 3600_000 });
    const hub = new CoachHub({ ...opts, clock: () => now, attempts: [earlier("t1", 2), earlier("t2", 1)] });
    const published: { topic: string; payload: Record<string, unknown> }[] = [];
    hub.on("event", (e) => published.push(e));
    expect(hub.sessionState().practiceToday).toMatchObject({ attempts: 2, counted: 2, passed: 2 });
    expect(hub.rollDay()).toBe(false); // first look: remembers the day, publishes nothing
    now += 1500; // 23:59:59.5
    expect(hub.rollDay()).toBe(false);
    now += 1000; // 00:00:00.5 the next day
    expect(hub.rollDay()).toBe(true);
    const stats = published.filter((e) => e.topic === "stats.updated");
    expect(stats).toHaveLength(1);
    expect(stats[0]!.payload.practiceToday).toEqual({ attempts: 0, counted: 0, passed: 0, unverified: 0, beeOverrules: 0 });
    expect(hub.sessionState().practiceToday).toMatchObject({ attempts: 0 });
    now += 5000;
    expect(hub.rollDay()).toBe(false); // once per day
    hub.dispose();
  });

  it("a day roll that throws is tried once, logged once, and never stops the purge", () => {
    const setup = demoSetup({ pace: 0.01, stateDir: null });
    setup.stop();
    setup.hub.dispose();
    const opts = (setup.hub as unknown as { opts: ConstructorParameters<typeof CoachHub>[0] }).opts;
    let now = Date.parse("2026-10-21T03:59:58Z");
    const hub = new CoachHub({ ...opts, clock: () => now });
    let purges = 0;
    let statsRuns = 0;
    hub.verifier.purge = () => void purges++;
    // A bad record: computing the week's stats throws.
    hub.stats = () => {
      statsRuns++;
      throw new Error("bad session record");
    };
    const logged: { event: string; data?: Record<string, unknown> }[] = [];
    const log = (event: string, data?: Record<string, unknown>) => void logged.push({ event, data });
    hub.housekeep(log); // remembers the day
    now += 3000; // past midnight
    for (let i = 0; i < 30; i++, now += 1000) hub.housekeep(log);
    expect(purges).toBe(31);
    expect(statsRuns).toBe(1); // tried once for the new day, not every second
    expect(logged).toEqual([{ event: "hub.tick-error", data: { job: "roll-day", error: "bad session record" } }]);
    hub.dispose();
  });
});
