// Bee live-feed parsing and attempt verification, on synthetic events shaped like the recorded
// stream (FL-8). No CLI, no network: a manual clock drives every timeout.
import { describe, expect, it } from "vitest";
import { BeeVerifier, DEFAULT_TIMINGS, parseStreamLine, type BeeAttempt, type BeeEvent, type PolledUtterance, type Verification } from "../src/hub/bee.js";
import { wearerRule } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const ME = { first_name: "Ada", last_name: "Demo" };
const TARGET = "The billing export is ready for review today.";

function rig(poll?: (q: unknown) => Promise<PolledUtterance[]>) {
  let now = T0;
  const verifications: Verification[] = [];
  const beeOnly: BeeAttempt[] = [];
  const polling: string[] = [];
  const v = new BeeVerifier({ clock: () => now, rule: wearerRule(ME, ""), poll, onVerification: (x) => verifications.push(x), onBeeAttempt: (x) => beeOnly.push(x), onPolling: (id) => polling.push(id) });
  v.openCard({ cardId: "c1", resay: TARGET, lang: "en", openedAt: T0 - 2000 });
  return {
    v, verifications, beeOnly, polling,
    advance: async (ms: number) => {
      now += ms;
      await v.tick();
    },
    now: () => now,
  };
}
const utt = (id: number, text: string, endMs: number, durS = 3): BeeEvent => ({ type: "new-utterance", conversation_uuid: "conv-1", utterance: { id, sample_id: `s${id}`, start: 10, end: 10 + durS, text, spoken_at: new Date(endMs - durS * 1000).toISOString() } });
const tag = (id: number, name = "Ada", score = 0.82): BeeEvent => ({ type: "tagged-utterance", utterance_id: id, person_id: 7, person_first_name: name, speaker_score: score, conversation_uuid: "conv-1" });

describe("stream parsing", () => {
  it("parses the recorded event shapes, prefixed capture lines and keepalives", () => {
    expect(parseStreamLine('{"timestamp":1792175734000}')).toEqual({ type: "keepalive", timestamp: 1792175734000 });
    const u = parseStreamLine('1792175839.672  {"type":"new-utterance","conversation_uuid":"x","utterance":{"id":5,"sample_id":"s","start":36.8,"end":44,"text":"hello there","spoken_at":"2026-10-16T18:37:08.000Z"}}');
    expect(u).toMatchObject({ type: "new-utterance", utterance: { id: 5, text: "hello there" } });
    expect(parseStreamLine('{"type":"tagged-utterance","utterance_id":5,"person_id":1,"person_first_name":"Ada","speaker_score":0.8,"conversation_uuid":"x"}')).toMatchObject({ type: "tagged-utterance", utterance_id: 5 });
    expect(parseStreamLine('{"type":"new-conversation","conversation":{"id":9,"conversation_uuid":"x","start_time":"2026-10-16T18:37:01.229Z","state":"CAPTURING","extra":1}}')).toMatchObject({ type: "new-conversation", conversation: { id: 9 } });
    expect(parseStreamLine('{"type":"update-conversation","conversation":{}}')).toBeNull();
    expect(parseStreamLine("start 1792175733.152 14:35:33 EDT")).toBeNull();
    expect(parseStreamLine("{not json")).toBeNull();
  });
});

describe("Bee verification", () => {
  it("verifies a provisional attempt when Bee tags the wearer saying it (with an ASR slip)", async () => {
    const r = rig();
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    await r.advance(5400);
    r.v.ingest(utt(1, "The billing export is ready for review to day", T0));
    expect(r.verifications).toHaveLength(0); // waits for the tag
    await r.advance(500);
    r.v.ingest(tag(1));
    expect(r.verifications[0]).toMatchObject({ attemptId: "a1", status: "verified", via: "stream", speakerScore: 0.82, beeUtteranceIds: [1], latencyMs: 5900 });
  });
  it("handles a tag that arrives before its utterance, and duplicate events", async () => {
    const r = rig();
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.v.ingest(tag(2));
    r.v.ingest(utt(2, TARGET, T0));
    r.v.ingest(utt(2, TARGET, T0));
    r.v.ingest(tag(2));
    expect(r.verifications).toHaveLength(1);
    expect(r.v.counters.duplicates).toBe(2);
  });
  it("joins two Bee lines when Bee split the attempt", async () => {
    const r = rig();
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 4000, speechEndMs: T0 });
    r.v.ingest(utt(3, "The billing export", T0 - 2500, 1.5));
    r.v.ingest(tag(3));
    expect(r.verifications).toHaveLength(0); // half the sentence matches neither the attempt nor the card well enough
    r.v.ingest(utt(4, "is ready for review today", T0, 2));
    r.v.ingest(tag(4));
    expect(r.verifications[0]).toMatchObject({ status: "verified", beeUtteranceIds: [3, 4] });
  });
  it("Bee wins on the words: a wearer line matching the card confirms even when the preview text differs", async () => {
    const r = rig();
    r.v.expect({ attemptId: "a1", cardId: "c1", text: "the bill in export his red", speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.v.ingest(utt(5, "Um, the billing export is ready for review today", T0));
    r.v.ingest(tag(5));
    expect(r.verifications[0]).toMatchObject({ status: "verified", beeText: "Um, the billing export is ready for review today" });
  });
  it("never-tagged line: polls, then 'unverified' with the reason", async () => {
    const r = rig(async () => []);
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.v.ingest(utt(6, TARGET, T0));
    await r.advance(DEFAULT_TIMINGS.tagWaitMs + 10);
    await r.advance(DEFAULT_TIMINGS.pollAtMs[0]! - DEFAULT_TIMINGS.tagWaitMs);
    expect(r.polling).toEqual(["a1"]);
    expect(r.v.counters.polls).toBe(1);
    await r.advance(DEFAULT_TIMINGS.pollAtMs[1]! - DEFAULT_TIMINGS.pollAtMs[0]!);
    expect(r.verifications).toHaveLength(0);
    await r.advance(DEFAULT_TIMINGS.giveUpAfterMs - DEFAULT_TIMINGS.pollAtMs[1]!);
    expect(r.verifications[0]).toMatchObject({ status: "unverified", reason: "Bee heard it but never tagged the wearer (tag timeout)" });
    expect(r.v.counters.polls).toBe(2);
  });
  it("another speaker or a low speaker score never verifies", async () => {
    for (const [name, score, reason] of [["Sam", 0.9, /another speaker/], ["Ada", 0.3, /speaker score was below 0.5/]] as const) {
      const r = rig();
      r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
      r.v.ingest(utt(7, TARGET, T0));
      r.v.ingest(tag(7, name, score));
      await r.advance(DEFAULT_TIMINGS.giveUpAfterMs + 1);
      expect(r.verifications[0]).toMatchObject({ status: "unverified" });
      expect(r.verifications[0]!.reason).toMatch(reason);
    }
  });
  it("missed stream events: the fallback poll verifies, and a polled line is never reused", async () => {
    const lines: PolledUtterance[] = [{ id: 8, text: TARGET, startMs: T0 - 3000, endMs: T0 }];
    const r = rig(async () => lines);
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    await r.advance(DEFAULT_TIMINGS.pollAtMs[0]!);
    expect(r.verifications[0]).toMatchObject({ attemptId: "a1", status: "verified", via: "poll", beeUtteranceIds: [8] });
    r.v.expect({ attemptId: "a2", cardId: "c1", text: TARGET, speechStartMs: T0 - 1000, speechEndMs: T0 + 2000 });
    await r.advance(DEFAULT_TIMINGS.giveUpAfterMs + 1);
    expect(r.verifications[1]).toMatchObject({ attemptId: "a2", status: "unverified" });
  });
  it("no attempt in time window: 'no Bee utterance' reason", async () => {
    const r = rig(async () => []);
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.v.ingest(utt(9, TARGET, T0 - 120_000));
    r.v.ingest(tag(9));
    await r.advance(DEFAULT_TIMINGS.giveUpAfterMs + 1);
    expect(r.verifications[0]!.reason).toBe("no Bee utterance in the time window (stream and poll)");
  });
  it("Bee-only attempt: a wearer line saying the open card, with no preview", async () => {
    const r = rig();
    r.v.ingest(utt(10, "the billing export is ready for review today", T0 + 4000));
    r.v.ingest(tag(10));
    expect(r.beeOnly[0]).toMatchObject({ cardId: "c1", beeUtteranceIds: [10], speakerScore: 0.82 });
    r.v.ingest(utt(11, "what time is lunch", T0 + 8000));
    r.v.ingest(tag(11));
    expect(r.beeOnly).toHaveLength(1); // off-topic speech is not an attempt
  });
  it("a late Bee line goes to the card it matches, even after the next card opened", async () => {
    const r = rig();
    r.v.openCard({ cardId: "c2", resay: "I fixed the invoice retry job this morning.", lang: "en", openedAt: T0 + 1000 });
    r.v.ingest(utt(12, TARGET, T0 + 500));
    r.v.ingest(tag(12));
    expect(r.beeOnly[0]!.cardId).toBe("c1");
  });
  it("matches a merged Bee line that carries extra trailing words, 16-19 s late (real-device case)", async () => {
    const r = rig();
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    await r.advance(16_500);
    r.v.ingest(utt(13, `${TARGET} How did I do?`, T0 + 2000, 5));
    r.v.ingest(tag(13));
    expect(r.verifications[0]).toMatchObject({ status: "verified", via: "stream", beeText: `${TARGET} How did I do?` });
  });
  it("ignores Bee lines delivered or spoken before the card opened", async () => {
    const r = rig();
    const OTHER = "I fixed the invoice retry job this morning.";
    r.v.ingest(utt(14, OTHER, T0)); // delivered at T0, before c2 opens
    r.v.ingest(tag(14));
    await r.advance(1000);
    r.v.openCard({ cardId: "c2", resay: OTHER, lang: "en", openedAt: r.now() });
    r.v.expect({ attemptId: "a2", cardId: "c2", text: OTHER, speechStartMs: r.now() + 1000, speechEndMs: r.now() + 4000 });
    r.v.ingest(utt(15, OTHER, r.now() - 20_000)); // delivered now, but spoken 20 s before the card opened
    r.v.ingest(tag(15));
    await r.advance(DEFAULT_TIMINGS.giveUpAfterMs + 5000);
    expect(r.beeOnly.filter((b) => b.cardId === "c2")).toHaveLength(0);
    expect(r.verifications.find((v) => v.attemptId === "a2")).toMatchObject({ status: "unverified" });
  });
});
