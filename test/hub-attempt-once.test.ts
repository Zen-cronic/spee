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
    const first = demoSetup({ pace: 0.01, stateDir: null }).hub;
    first.openCard({ by: "alexa" });
    const a = first.submit({ text: "the billing export", source: "alexa" }) as Attempt;
    expect(a.status).toBe("pending_bee");
    const saved: Attempt[] = JSON.parse(JSON.stringify(first.attempts)); // what attempts.json holds
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
