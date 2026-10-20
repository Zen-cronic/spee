// Live ingest (src/hub/ingest.ts): the running hub turns a finished Bee conversation into a stats
// session, so the transfer's first signal moves without `npm run real` or a restart. Fake Bee source
// and a fake `bee stream` only: no bee CLI, no network, no model.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, Me } from "../src/bee/schemas.js";
import type { BeeEvent } from "../src/hub/bee.js";
import { CoachHub, type Attempt, type HubEvent } from "../src/hub/core.js";
import { INGEST_TIMINGS, LiveIngest, type IngestSource } from "../src/hub/ingest.js";
import { LiveEngine } from "../src/hub/live/engine.js";
import { loadPrinciples } from "../src/hub/live/principles.js";
import { ReplayWrist } from "../src/hub/live/wrist.js";
import type { HubDeck } from "../src/hub/scheduler.js";
import { liveSetup, wearerRule } from "../src/hub/setup.js";
import { firstSignalSentence, LIVE_SESSIONS_FILE, loadRealSessions, type TransferPrereg } from "../src/hub/stats.js";
import { wordCount } from "../src/real/text.js";

const ME: Me = { id: 1, first_name: "Ada", last_name: "Demo" };
const SECRET = "zebra orchid quantum walrus"; // planted in another speaker's line: must never leave memory
const TZ = "America/Toronto";
const T_DRILL = Date.parse("2026-10-20T14:00:00Z");
const DRILL_UTT = 200_005; // the wearer line Bee heard as the drill attempt
const deck = JSON.parse(readFileSync("fixtures/demo/deck.json", "utf8")) as HubDeck; // card demo:hedge-i-guess (synthetic)
const PREREG: TransferPrereg = {
  kind: "transfer", registered_at: "2026-10-12T13:00:00.000Z", registered_local: "", lang: "en", basis: "test",
  drilled: [{ habit: "hedges", why: "" }, { habit: "filler:like", why: "" }], control: [{ habit: "restart", why: "" }], min_words_per_period: 400, cutover_rule: "",
};
const attempt = { id: "att_1", cardId: "demo:hedge-i-guess", sessionId: null, status: "graded", counted: true, createdAt: T_DRILL, settledAt: T_DRILL + 6000, provisional: null, bee: { text: "The billing export is ready for review today.", utteranceIds: [DRILL_UTT], speakerScore: 0.8, via: "stream", latencyMs: 5900, coverage: null, replay: false }, final: null, agreement: "bee-only", reason: "", box: null } as unknown as Attempt;

// Everyday wearer speech: short, spontaneous lines (the mislabel detector keeps them), 9-10 words each.
const SPEECH = [
  "Yeah so I guess the export is mostly done now.",
  "Okay, I think we can ship it on Friday maybe.",
  "Um, the totals match the ledger, I checked them twice.",
  "Right, so the retry job runs every night at two.",
  "Yeah, the billing team wanted a summary by Thursday morning.",
  "Okay so I sent the draft to Sam this morning.",
  "Um, we still need the sign-off from finance though, yeah.",
  "Right, I guess the dashboard is kind of slow today.",
  "Yeah, I'll look at the query plan after lunch, okay.",
  "Okay, the migration finished and the counts look right.",
  "Um, I think the release notes are nearly ready, yeah.",
  "Right, let's sync again on Monday after the stand-up.",
];
const DRILL_LINE = "The billing export is ready for review today.";

function conversation(id: number, startMs: number, o: { state?: string; wearer?: string[]; other?: string[]; drill?: boolean } = {}): ConversationDetail {
  const wearer = o.wearer ?? SPEECH;
  const utts: [string, string][] = [];
  wearer.forEach((t, i) => {
    utts.push(["Ada", t]);
    if (i === 2) for (const x of o.other ?? [`Sure, and ${SECRET} is on the agenda too.`]) utts.push(["Unknown", x]);
  });
  if (o.drill) utts.splice(4, 0, ["Ada", DRILL_LINE]);
  return {
    id, start_time: startMs, end_time: startMs + 600_000, device_type: "watch", summary: null, short_summary: null, state: o.state ?? "COMPLETED", created_at: startMs, updated_at: startMs,
    transcriptions: [{ id: id * 10, realtime: false, utterances: utts.map(([speaker, text], i) => ({ id: o.drill && i === 4 && speaker === "Ada" && text === DRILL_LINE ? DRILL_UTT : id * 1000 + 1 + i, realtime: false, start: i * 5, end: i * 5 + 4, spoken_at: startMs + i * 5000, text, speaker, created_at: startMs })) }],
    suggested_links: [], primary_location: null,
  };
}

class FakeBee implements IngestSource {
  convs = new Map<number, ConversationDetail>();
  calls: string[] = [];
  fail: Error | null = null; // every call throws this while set
  failIds = new Map<number, Error>(); // `get <id>` throws this while set
  meFails = false;
  add(c: ConversationDetail) {
    this.convs.set(c.id, c);
    return this;
  }
  async me() {
    this.calls.push("me");
    if (this.fail) throw this.fail;
    if (this.meFails) throw new Error("bee me failed");
    return ME;
  }
  async conversations(since: number) {
    this.calls.push("list");
    if (this.fail) throw this.fail;
    return [...this.convs.values()].filter((c) => c.start_time >= since).map((c) => ({ id: c.id, start_time: c.start_time, end_time: c.end_time, created_at: c.created_at, summary: null, state: c.state }));
  }
  async conversation(id: number) {
    this.calls.push(`get ${id}`);
    if (this.fail) throw this.fail;
    const f = this.failIds.get(id);
    if (f) throw f;
    return structuredClone(this.convs.get(id) ?? null);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stateDir() {
  const d = mkdtempSync(join(tmpdir(), "hub-ingest-"));
  dirs.push(d);
  return d;
}
// The offline run's corpus (as scripts/real.ts writes it): one conversation the day before the drill.
function writeOffline(dir: string, convs: ConversationDetail[]) {
  const sessions = convs.map((c) => ({ id: String(c.id), kind: "conversation", state: "COMPLETED", startMs: c.start_time, totalLines: 1, wearerLines: 1, uncertainLines: 0, wearerShare: 1 }));
  const lines = convs.flatMap((c) => c.transcriptions[0]!.utterances.filter((u) => u.speaker === "Ada").map((u) => ({ key: `u:${u.id}`, session: String(c.id), kind: "conversation", start: u.start, end: u.end, spokenAt: u.spoken_at, text: u.text, lang: "en", dom: "en", uncertain: false, mislabelScore: 0, reasons: [] })));
  writeFileSync(join(dir, "corpus.json"), JSON.stringify({ generatedAt: "x", wearer: { labels: ["Ada"], method: "profile-name", counts: {} }, sessions, lines }));
}
const BEFORE = conversation(100, T_DRILL - 86_400_000, { other: [] });

// `poll: false`: no list poll, to watch the stream path alone.
function rig(o: { offline?: ConversationDetail[]; bee?: FakeBee; me?: Me | null; dir?: string; poll?: false } = {}) {
  const dir = o.dir ?? stateDir();
  if (!o.dir) writeOffline(dir, o.offline ?? [BEFORE]);
  let now = T_DRILL + 2 * 3600_000;
  const hub = new CoachHub({ mode: "live", clock: () => now, tz: TZ, deck: structuredClone(deck), deckPath: null, attempts: [structuredClone(attempt)], attemptsPath: null, sessions: loadRealSessions(dir), prereg: PREREG, preregPath: "p", wearer: wearerRule(ME, ""), replay: false });
  const events: HubEvent[] = [];
  hub.on("event", (e: HubEvent) => events.push(e));
  const logs: string[] = [];
  const bee = o.bee ?? new FakeBee();
  const ingest = new LiveIngest({ src: bee, stateDir: dir, clock: () => now, known: () => new Set(hub.sessions.map((s) => s.id)), onSessions: (ss) => hub.addSessions(ss), me: o.me === undefined ? ME : o.me, log: (e, d) => logs.push(JSON.stringify({ e, ...d })), timings: o.poll === false ? { firstPollMs: 1e12 } : {} });
  hub.onBee({ conversation: (c) => ingest.onConversation(c) });
  const ended = (id: number, state: string): BeeEvent => ({ type: "update-conversation", conversation: { id, conversation_uuid: `uuid-${id}`, start_time: new Date(T_DRILL + 3600_000).toISOString(), end_time: new Date(T_DRILL + 4200_000).toISOString(), state } });
  return { dir, hub, events, logs, bee, ingest, ended, advance: (ms: number) => (now += ms), now: () => now };
}
const hedges = (hub: CoachHub) => hub.transfer()!.firstSignal.find((f) => f.habit === "hedges")!;
// Every file the ingest could have written, with the .bak/.tmp copies.
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));

describe("live ingest: a finished conversation becomes a stats session", () => {
  it("a COMPLETED event ingests it and the first signal goes from no-next-conversation to measured", async () => {
    const r = rig();
    r.bee.add(conversation(200, T_DRILL + 3600_000, { drill: true }));
    expect(hedges(r.hub).status).toBe("no-next-conversation");
    expect(firstSignalSentence(r.hub.transfer()!.firstSignal)).toBeNull();
    // "how am I doing?" (GET /api/coach/now) with no next conversation yet: no first-signal sentence
    const engine = new LiveEngine({ hub: r.hub, publish: () => {}, pace: 1, demo: false, stateDir: null, wrist: new ReplayWrist({ clock: r.now, pace: 1 }), principles: loadPrinciples(), baselineWpm: null });
    const before = engine.coachNow().narration;

    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200"]); // the CliBeeSource path: one `bee conversations get`

    const f = hedges(r.hub);
    expect(f.status).toBe("measured");
    expect(f.after).toMatchObject({ session: "200" });
    // the drill line Bee heard is left out, as in the transfer periods (DrillLines)
    expect(f.after!.words).toBe(SPEECH.reduce((n, t) => n + wordCount(t), 0));
    expect(f.after!.count).toBeGreaterThan(0);
    // "how am I doing?" reads the same transfer on every ask: it now says the first signal
    const sentence = firstSignalSentence(r.hub.transfer()!.firstSignal);
    expect(sentence).not.toBeNull();
    expect(engine.coachNow().narration).toContain(sentence!);
    expect(before).not.toContain(sentence!);
    engine.stop();
    // stats.updated tells the screens to refetch stats and the transfer
    expect(r.events.filter((e) => e.topic === "stats.updated")).toHaveLength(1);
    expect(r.hub.stats({ kind: "all" }).sessions.map((s) => s.id)).toEqual(["100", "200"]);
    // persisted for the next start, merged by loadRealSessions
    const stored = JSON.parse(readFileSync(join(r.dir, LIVE_SESSIONS_FILE), "utf8"));
    expect(stored.sessions).toMatchObject([{ id: "200", wearerLines: SPEECH.length + 1, totalLines: SPEECH.length + 2 }]);
    expect(loadRealSessions(r.dir).map((s) => s.id)).toEqual(["100", "200"]);
    expect(r.logs.some((l) => l.includes('"bee.ingest.added"') && l.includes('"via":"stream"'))).toBe(true);
    // a repeated event (or a duplicate in the stream) does not fetch again
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200"]);
  });

  it("a recording that stops in PROCESSING is re-fetched on a backoff until Bee completes it", async () => {
    const r = rig({ poll: false });
    const c = conversation(200, T_DRILL + 3600_000, { state: "PROCESSING" });
    r.bee.add(c);
    r.hub.ingestBee(r.ended(200, "PROCESSING"));
    await r.ingest.tick();
    expect(r.bee.calls).toEqual([]); // not before the first recheck
    r.advance(INGEST_TIMINGS.recheckMs[0]!);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200"]);
    expect(hedges(r.hub).status).toBe("no-next-conversation");
    // Bee's delete-conversation that follows a stop does not cancel the fetch
    r.hub.ingestBee({ ...r.ended(200, "PROCESSING"), type: "delete-conversation" } as BeeEvent);
    r.bee.add({ ...c, state: "COMPLETED" });
    r.advance(INGEST_TIMINGS.recheckMs[1]! - 1);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200"]); // backoff: 2 min after the first recheck
    r.advance(1);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200", "get 200"]);
    expect(hedges(r.hub).status).toBe("measured");
  });

  it("after delete-conversation, a failed fetch backs off; the entry is dropped only when Bee says it is gone", async () => {
    const r = rig({ poll: false });
    r.bee.add(conversation(300, T_DRILL + 3600_000));
    r.hub.ingestBee(r.ended(300, "PROCESSING"));
    r.hub.ingestBee({ ...r.ended(300, "PROCESSING"), type: "delete-conversation" } as BeeEvent);
    // a timeout on the first re-fetch: not "gone", so it is tried again after its backoff
    r.bee.failIds.set(300, Object.assign(new Error("Command failed: bee conversations get 300 --json"), { killed: true, signal: "SIGKILL" }));
    r.advance(INGEST_TIMINGS.recheckMs[0]!);
    await r.ingest.tick();
    expect(r.ingest.status().pending).toBe(1);
    r.bee.failIds.delete(300);
    r.advance(INGEST_TIMINGS.retryBaseMs);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 300", "get 300"]);
    expect(r.hub.sessions.map((s) => s.id)).toContain("300");
  });

  it("a deleted conversation Bee no longer returns is dropped, not retried", async () => {
    const r = rig({ poll: false });
    r.hub.ingestBee(r.ended(301, "PROCESSING"));
    r.hub.ingestBee({ ...r.ended(301, "PROCESSING"), type: "delete-conversation" } as BeeEvent);
    r.bee.failIds.set(301, Object.assign(new Error("Command failed: bee conversations get 301 --json: Conversation not found"), { code: 1 }));
    r.advance(INGEST_TIMINGS.recheckMs[0]!);
    await r.ingest.tick();
    expect(r.ingest.status().pending).toBe(0);
    // an error that does not say so is retried, and dropped after a few in a row
    r.hub.ingestBee(r.ended(302, "PROCESSING"));
    r.hub.ingestBee({ ...r.ended(302, "PROCESSING"), type: "delete-conversation" } as BeeEvent);
    r.bee.failIds.set(302, Object.assign(new Error("Command failed"), { code: 1 }));
    for (let i = 0; i < INGEST_TIMINGS.deletedFailures; i++) {
      r.advance(INGEST_TIMINGS.retryBaseMs * 4);
      await r.ingest.tick();
    }
    expect(r.bee.calls.filter((c) => c === "get 302")).toHaveLength(INGEST_TIMINGS.deletedFailures);
    expect(r.ingest.status().pending).toBe(0);
    r.advance(INGEST_TIMINGS.retryMaxMs);
    await r.ingest.tick();
    expect(r.bee.calls.filter((c) => c === "get 302")).toHaveLength(INGEST_TIMINGS.deletedFailures);
  });

  it("a conversation fetched before Bee labelled it is fetched again on a later COMPLETED event, after its backoff", async () => {
    const r = rig({ poll: false });
    const labelled = conversation(200, T_DRILL + 3600_000);
    // first fetch: COMPLETED, but only the realtime transcript (every speaker "Unknown")
    const realtime = structuredClone(labelled);
    realtime.transcriptions = [{ ...realtime.transcriptions[0]!, realtime: true, utterances: realtime.transcriptions[0]!.utterances.map((u) => ({ ...u, realtime: true, speaker: "Unknown" })) }];
    r.bee.add(realtime);
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200"]);
    expect(r.hub.sessions.map((s) => s.id)).not.toContain("200");
    // Bee sends COMPLETED again and again while it finishes: none of them fetches before the backoff
    for (let i = 0; i < 8; i++) {
      r.advance(30_000);
      r.hub.ingestBee(r.ended(200, "COMPLETED"));
      await r.ingest.tick();
    }
    expect(r.bee.calls).toEqual(["get 200"]);
    // Bee has the labelled final transcript now; the queued event fetches it once the backoff is over
    r.bee.add(labelled);
    r.advance(INGEST_TIMINGS.retryBaseMs - 8 * 30_000);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["get 200", "get 200"]);
    expect(hedges(r.hub).status).toBe("measured");
  });

  it("a final transcript with no wearer line yet is re-fetched by later polls, a bounded number of times", async () => {
    const r = rig();
    const unlabelled = conversation(200, T_DRILL + 3600_000);
    unlabelled.transcriptions[0]!.utterances = unlabelled.transcriptions[0]!.utterances.map((u) => ({ ...u, speaker: "Unknown" }));
    r.bee.add(unlabelled);
    r.advance(INGEST_TIMINGS.firstPollMs);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["list", "get 200"]);
    expect(r.ingest.status().ingested).toBe(0);
    r.bee.add(conversation(200, T_DRILL + 3600_000)); // labelled now
    r.advance(INGEST_TIMINGS.retryBaseMs);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["list", "get 200", "list", "get 200"]);
    expect(hedges(r.hub).status).toBe("measured");
    // one that never gets a wearer line is stored after notReadyTries fetches, and not fetched again
    const r2 = rig();
    const empty = conversation(210, T_DRILL + 3600_000);
    empty.transcriptions[0]!.utterances = empty.transcriptions[0]!.utterances.map((u) => ({ ...u, speaker: "Unknown" }));
    r2.bee.add(empty);
    for (let i = 0; i < 20; i++) {
      r2.advance(INGEST_TIMINGS.retryMaxMs / 4);
      await r2.ingest.tick();
    }
    expect(r2.bee.calls.filter((c) => c === "get 210")).toHaveLength(INGEST_TIMINGS.notReadyTries);
    expect(r2.ingest.status().ingested).toBe(1);
  });
});

describe("live ingest: de-duplication with the offline files", () => {
  it("a conversation an offline file already has is never fetched or changed", async () => {
    const offline200 = conversation(200, T_DRILL + 3600_000, { other: [], wearer: SPEECH.slice(0, 3) });
    const r = rig({ offline: [BEFORE, offline200] });
    r.bee.add(conversation(200, T_DRILL + 3600_000));
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    r.advance(INGEST_TIMINGS.firstPollMs);
    await r.ingest.tick(); // the list poll sees 200 too
    expect(r.bee.calls).toEqual(["list"]);
    expect(r.hub.sessions.find((s) => s.id === "200")!.lines).toHaveLength(3);
    expect(existsSync(join(r.dir, LIVE_SESSIONS_FILE))).toBe(false);
  });

  it("loadRealSessions: offline files win a conflict whole; live-only sessions are added", () => {
    const dir = stateDir();
    writeOffline(dir, [BEFORE]);
    mkdirSync(join(dir, "live"));
    const live = {
      generatedAt: "x", note: "", wearer: { labels: [], method: "none", counts: {} },
      sessions: [
        { id: "100", kind: "conversation", state: "COMPLETED", startMs: 1, totalLines: 1, wearerLines: 1, uncertainLines: 0, wearerShare: 1 },
        { id: "300", kind: "conversation", state: "COMPLETED", startMs: T_DRILL + 7200_000, totalLines: 1, wearerLines: 1, uncertainLines: 0, wearerShare: 1 },
      ],
      lines: [
        { key: "u:999", session: "100", kind: "conversation", text: "an extra live line", dom: "en", uncertain: false },
        { key: "u:301", session: "300", kind: "conversation", text: "Yeah I guess so.", dom: "en", uncertain: false },
      ],
    };
    writeFileSync(join(dir, LIVE_SESSIONS_FILE), JSON.stringify(live));
    const ss = loadRealSessions(dir);
    expect(ss.map((s) => s.id)).toEqual(["100", "300"]);
    const s100 = ss.find((s) => s.id === "100")!;
    expect(s100.startMs).toBe(BEFORE.start_time); // the offline session, not the live one
    expect(s100.lines.map((l) => l.key)).not.toContain("u:999");
    expect(ss.find((s) => s.id === "300")!.lines.map((l) => l.key)).toEqual(["u:301"]);
    // a damaged live file is never fatal at startup: its last good copy is restored, else it is set aside
    const quiet = console.error;
    console.error = () => {};
    try {
      writeFileSync(join(dir, LIVE_SESSIONS_FILE), "{ not json");
      expect(loadRealSessions(dir).map((s) => s.id)).toEqual(["100", "300"]);
      rmSync(join(dir, `${LIVE_SESSIONS_FILE}.bak`));
      writeFileSync(join(dir, LIVE_SESSIONS_FILE), "{ not json");
      expect(loadRealSessions(dir).map((s) => s.id)).toEqual(["100"]);
    } finally {
      console.error = quiet;
    }
  });

  it("after a restart, what was ingested loads with the offline files and is not fetched again", async () => {
    const first = rig();
    first.bee.add(conversation(200, T_DRILL + 3600_000));
    first.hub.ingestBee(first.ended(200, "COMPLETED"));
    await first.ingest.tick();
    const bee = new FakeBee().add(conversation(200, T_DRILL + 3600_000));
    const second = rig({ dir: first.dir, bee });
    expect(second.hub.sessions.map((s) => s.id)).toEqual(["100", "200"]);
    expect(hedges(second.hub).status).toBe("measured");
    second.hub.ingestBee(second.ended(200, "COMPLETED"));
    second.advance(INGEST_TIMINGS.firstPollMs);
    await second.ingest.tick();
    expect(bee.calls).toEqual(["list"]);
  });
});

describe("live ingest: the list poll fallback", () => {
  it("picks up COMPLETED conversations the stream missed, every 10 min, within the lookback", async () => {
    const r = rig();
    r.bee
      .add(conversation(200, T_DRILL + 3600_000))
      .add(conversation(201, T_DRILL + 5400_000, { state: "CAPTURING" }))
      .add(conversation(150, T_DRILL - 3 * 86_400_000)); // older than the 24 h lookback
    await r.ingest.tick();
    expect(r.bee.calls).toEqual([]); // the first poll waits firstPollMs after start
    r.advance(INGEST_TIMINGS.firstPollMs);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["list", "get 200"]);
    expect(hedges(r.hub).status).toBe("measured");
    expect(r.logs.some((l) => l.includes('"bee.ingest.added"') && l.includes('"via":"poll"'))).toBe(true);
    r.advance(INGEST_TIMINGS.pollEveryMs - 1);
    await r.ingest.tick();
    expect(r.bee.calls).toHaveLength(2);
    r.bee.add({ ...r.bee.convs.get(201)!, state: "COMPLETED" });
    r.advance(1);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual(["list", "get 200", "list", "get 201"]);
    expect(r.hub.sessions.map((s) => s.id)).toEqual(["100", "200", "201"]);
  });
});

describe("live ingest: failures never stop the hub", () => {
  it("logs a failure once, opens the circuit after 3 different calls fail in a row, and recovers", async () => {
    const r = rig({ poll: false });
    for (const id of [200, 201, 202]) r.bee.add(conversation(id, T_DRILL + 3600_000 + (id - 200) * 60_000));
    // a parse error can quote the CLI's output: the message must never be logged
    r.bee.fail = new SyntaxError(`Unexpected token in JSON: "${SECRET}"`);
    for (const id of [200, 201, 202]) r.hub.ingestBee(r.ended(id, "COMPLETED"));
    await expect(r.ingest.tick()).resolves.toBeUndefined();
    expect(r.bee.calls).toEqual(["get 200", "get 201", "get 202"]);
    expect(r.logs.filter((l) => l.includes('"bee.ingest.error"'))).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes('"bee.ingest.circuit-open"'))).toHaveLength(1);
    expect(r.ingest.status().circuitOpen).toBe(true);
    await r.ingest.tick();
    expect(r.bee.calls.length).toBe(3); // the circuit is open: no CLI call
    r.bee.fail = null;
    r.advance(INGEST_TIMINGS.breakerOpenMs);
    await r.ingest.tick();
    expect(hedges(r.hub).status).toBe("measured");
    expect(r.logs.join("\n")).not.toContain(SECRET);
    expect(r.logs.join("\n")).not.toContain("Unexpected token");
  });

  it("one conversation that always fails counts once toward the circuit and waits a growing backoff", async () => {
    const r = rig({ poll: false });
    r.bee.add(conversation(200, T_DRILL + 3600_000));
    r.bee.failIds.set(200, new SyntaxError("bad json"));
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    for (let i = 0; i < 12; i++) {
      await r.ingest.tick();
      r.advance(INGEST_TIMINGS.recheckMs.at(-1)!);
    }
    // 2 hours: tried at 0, 10, 30 and 70 min (backoff 10, 20, 40 min), never opening the circuit
    expect(r.bee.calls).toEqual(["get 200", "get 200", "get 200", "get 200"]);
    expect(r.ingest.status().counters.circuitOpened).toBe(0);
  });

  it("conversations that always fail never starve a newer one the stream missed", async () => {
    const r = rig();
    const poison = [210, 211, 212];
    poison.forEach((id, i) => (r.bee.add(conversation(id, T_DRILL + 3600_000 + i * 60_000)), r.bee.failIds.set(id, new SyntaxError("bad json"))));
    r.bee.add(conversation(220, T_DRILL + 3 * 3600_000));
    r.advance(INGEST_TIMINGS.firstPollMs);
    await r.ingest.tick();
    // newest first: the good one is in at the first poll
    expect(r.bee.calls.slice(0, 2)).toEqual(["list", "get 220"]);
    expect(r.hub.sessions.map((s) => s.id)).toContain("220");
    // three hours of polls: each failing one waits its backoff instead of being first in line every time
    for (let i = 0; i < 18; i++) {
      r.advance(INGEST_TIMINGS.pollEveryMs);
      await r.ingest.tick();
    }
    const gets = r.bee.calls.filter((c) => c.startsWith("get 21"));
    expect(gets.length).toBeLessThan(poison.length * 6);
  });

  it("a queued conversation the hub already has by then is not fetched: no CLI call, and the entry goes", async () => {
    const r = rig({ poll: false });
    r.hub.ingestBee(r.ended(200, "PROCESSING"));
    expect(r.ingest.status().pending).toBe(1);
    // the hub gets it another way before the re-fetch (an earlier ingest, an offline file)
    r.hub.addSessions([{ id: "200", kind: "conversation", startMs: T_DRILL + 3600_000, lines: [] }]);
    r.advance(INGEST_TIMINGS.recheckMs[0]!);
    await r.ingest.tick();
    expect(r.bee.calls).toEqual([]);
    expect(r.ingest.status().pending).toBe(0);
  });

  it("a write that fails is logged once; the session still counts in memory", async () => {
    const r = rig();
    writeFileSync(join(r.dir, "live"), "a file where the live/ directory should be");
    r.bee.add(conversation(200, T_DRILL + 3600_000)).add(conversation(201, T_DRILL + 5400_000));
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    r.hub.ingestBee(r.ended(201, "COMPLETED"));
    await r.ingest.tick();
    expect(hedges(r.hub).status).toBe("measured");
    expect(r.hub.sessions.map((s) => s.id)).toEqual(["100", "200", "201"]);
    expect(r.logs.filter((l) => l.includes('"bee.ingest.persist-error"'))).toHaveLength(1);
  });

  it("an onSessions failure (a bug downstream) is caught: tick resolves and logs the kind once", async () => {
    const dir = stateDir();
    const bee = new FakeBee().add(conversation(200, T_DRILL + 3600_000));
    const logs: string[] = [];
    const ingest = new LiveIngest({ src: bee, stateDir: dir, clock: () => T_DRILL, known: () => new Set(), onSessions: () => { throw new Error(SECRET); }, me: ME, log: (e, d) => logs.push(JSON.stringify({ e, ...d })) });
    ingest.onConversation({ type: "update-conversation", id: 200, uuid: null, state: "COMPLETED", startMs: null, endMs: null, receivedAt: T_DRILL });
    await expect(ingest.tick()).resolves.toBeUndefined();
    expect(logs.filter((l) => l.includes('"bee.ingest.error"'))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("without the Bee profile nothing is attributed: the conversation waits, then is ingested once `bee me` works", async () => {
    const bee = new FakeBee().add(conversation(200, T_DRILL + 3600_000));
    bee.meFails = true;
    const r = rig({ bee, me: null });
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    expect(bee.calls).toEqual(["get 200"]); // `bee me` is not retried before meRetryMs
    expect(hedges(r.hub).status).toBe("no-next-conversation");
    expect(r.logs.filter((l) => l.includes('"bee.ingest.deferred"'))).toHaveLength(1);
    expect(existsSync(join(r.dir, LIVE_SESSIONS_FILE))).toBe(false);
    bee.meFails = false;
    r.advance(INGEST_TIMINGS.meRetryMs);
    await r.ingest.tick();
    expect(bee.calls).toContain("me");
    expect(hedges(r.hub).status).toBe("measured");
  });
});

describe("live ingest: privacy", () => {
  it("another speaker's line never reaches the file, the hub's events, its responses or the logs", async () => {
    const r = rig();
    r.bee.add(conversation(200, T_DRILL + 3600_000, { drill: true, other: [`Sure, and ${SECRET} is on the agenda too.`, `${SECRET} again, from me.`] }));
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    expect(hedges(r.hub).status).toBe("measured");
    const stored = readFileSync(join(r.dir, LIVE_SESSIONS_FILE), "utf8");
    expect(stored).toContain(SPEECH[0]); // the wearer's own lines are kept
    expect(JSON.parse(stored).sessions[0]).toMatchObject({ totalLines: SPEECH.length + 3, wearerLines: SPEECH.length + 1 }); // other speakers: counts only
    const everything = [
      ...files(r.dir).map((f) => readFileSync(f, "utf8")),
      JSON.stringify(r.events),
      JSON.stringify(r.hub.stats({ kind: "all" })),
      JSON.stringify(r.hub.stats({ kind: "all" }, "all")),
      JSON.stringify(r.hub.transfer()),
      JSON.stringify(r.hub.sessions),
      JSON.stringify(loadRealSessions(r.dir)),
      JSON.stringify(r.ingest.status()),
      r.logs.join("\n"),
    ].join("\n");
    expect(everything).not.toContain("zebra orchid");
    expect(everything).not.toContain(SECRET);
  });

  it("a line Bee labels as anyone but the profile-named wearer is never kept, a named colleague or the product's own voice", async () => {
    const r = rig();
    const c = conversation(200, T_DRILL + 3600_000, { other: [] });
    // the coach's own spoken prompt, picked up by the watch and labelled as another speaker, and an
    // enrolled colleague with a name of their own
    const PROMPT = "You can also ask how am I doing.";
    const theirs: [string, string][] = [["Unknown", PROMPT], ["Sam Quill", `${SECRET}, says Sam.`], ["Sam", `${SECRET} from a first name only.`]];
    const base = c.transcriptions[0]!.utterances;
    theirs.forEach(([speaker, text], i) => base.push({ ...base[0]!, id: 200_900 + i, speaker, text, spoken_at: c.start_time + 500_000 + i * 1000 }));
    r.bee.add(c);
    r.hub.ingestBee(r.ended(200, "COMPLETED"));
    await r.ingest.tick();
    const stored = JSON.parse(readFileSync(join(r.dir, LIVE_SESSIONS_FILE), "utf8"));
    const keys = new Set(base.filter((u) => u.speaker === "Ada").map((u) => `u:${u.id}`));
    expect(stored.lines.length).toBe(keys.size);
    expect(stored.lines.every((l: { key: string }) => keys.has(l.key))).toBe(true);
    const text = JSON.stringify([stored, r.hub.sessions]);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(SECRET);
  });
});

describe("live ingest: wired into the live hub (liveSetup, fake bee stream and CLI)", () => {
  it("a COMPLETED line on the stream reaches the stats and the first signal", async () => {
    const dir = stateDir();
    writeOffline(dir, [BEFORE]);
    writeFileSync(join(dir, "deck.json"), JSON.stringify(deck));
    writeFileSync(join(dir, "hub-attempts.json"), JSON.stringify({ attempts: [attempt] }));
    const bee = new FakeBee().add(conversation(200, T_DRILL + 3600_000));
    const stdout = new PassThrough();
    const spawnFn = (() => Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), pid: 4242, exitCode: 1, signalCode: null, kill: () => {} })) as never;
    const s = await liveSetup({ stateDir: dir, source: bee, spawnFn, ingest: { tickMs: 5, firstPollMs: 3600_000 } });
    try {
      const t = () => s.hub.transfer()!.firstSignal.find((f) => f.habit === "hedges")!;
      expect(t().status).toBe("no-next-conversation");
      expect(s.describe.ingest).toMatch(/finished conversations/);
      const seen: string[] = [];
      s.hub.on("event", (e: HubEvent) => seen.push(e.topic));
      stdout.write(JSON.stringify({ type: "update-conversation", conversation: { id: 200, conversation_uuid: "uuid-200", start_time: new Date(T_DRILL + 3600_000).toISOString(), end_time: new Date(T_DRILL + 4200_000).toISOString(), state: "COMPLETED" } }) + "\n");
      for (let i = 0; i < 200 && t().status !== "measured"; i++) await new Promise((res) => setTimeout(res, 5));
      expect(t().status).toBe("measured");
      expect(seen).toContain("stats.updated");
      expect(bee.calls.filter((c) => c.startsWith("get"))).toEqual(["get 200"]);
      expect(readFileSync(join(dir, LIVE_SESSIONS_FILE), "utf8")).not.toContain(SECRET);
    } finally {
      s.stop();
      s.hub.dispose();
    }
  });
});
