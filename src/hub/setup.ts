// Builds a CoachHub for live mode (real gitignored data, spawned `bee stream`, Bee CLI poll) or
// demo mode (synthetic fixtures, a demo clock, and scripted Bee replays labelled as replay).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliBeeSource, pickUtterances } from "../bee/source.js";
import type { Me } from "../bee/schemas.js";
import { discoverWearerLabels, isWearer, matchesProfile } from "../real/wearer.js";
import { DEFAULT_TIMINGS, replay, scaleTimings, spawnBeeStream, toMs, type BeeEvent, type PolledUtterance, type PollFn, type ReplayStep, type StreamHandle, type TaggedUtterance, type WearerTagRule } from "./bee.js";
import { beeCalendar, type CalendarFn } from "./brief.js";
import { deriveHabit, deriveMustSay, type HubCard } from "./cards.js";
import { CoachHub, loadAttempts, type Attempt } from "./core.js";
import { DEMO_DEFAULT_CYCLE, DEMO_EPOCH, DEMO_LABEL, DEMO_TZ, DEMO_WEARER, type DemoScenario } from "./demoData.js";
import { loadHubDeck, saveHubDeck, type HubDeck } from "./scheduler.js";
import { loadPrereg, loadRealSessions, type StatSession, type TransferPrereg } from "./stats.js";

export const MIN_SPEAKER_SCORE = 0.5; // observed wearer scores 0.64-0.86 (2026-10-16)

export interface Setup {
  hub: CoachHub;
  calendar: CalendarFn;
  stream: StreamHandle | null;
  demo: DemoDirector | null;
  describe: Record<string, unknown>;
  stop(): void;
}

// Wearer rule: the tag's person is the Bee profile owner (first name matches `bee me`), or the
// person id in BEE_WEARER_PERSON_ID; and the speaker score is at least MIN_SPEAKER_SCORE.
export function wearerRule(me: Pick<Me, "first_name" | "last_name"> | null, personIds = process.env.BEE_WEARER_PERSON_ID): WearerTagRule {
  const ids = new Set((personIds ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0));
  return {
    minScore: MIN_SPEAKER_SCORE,
    isWearer: (t: TaggedUtterance) => (t.person_id != null && ids.has(t.person_id)) || (!!me && !!t.person_first_name && matchesProfile(t.person_first_name, me)),
  };
}

// Live

export async function liveSetup(opts: { stateDir?: string; bee?: boolean; log?: (e: string, d?: Record<string, unknown>) => void } = {}): Promise<Setup> {
  const dir = opts.stateDir ?? "real";
  const log = opts.log ?? (() => {});
  const src = new CliBeeSource();
  const me = await src.me().catch(() => null);
  if (!me) log("bee.me.unavailable", { note: "wearer tags cannot be matched to the profile; set BEE_WEARER_PERSON_ID" });
  const deckPath = join(dir, "deck.json");
  const deck = loadHubDeck(deckPath);
  const attemptsPath = join(dir, "hub-attempts.json");
  const preregPath = "prereg/transfer.json";
  const prereg = existsSync(preregPath) ? loadPrereg(preregPath) : null;
  // Fallback poll: the conversations active in the window, wearer-labelled lines only.
  const poll: PollFn = async ({ conversationIds, fromMs, toMs: until }) => {
    const ids = conversationIds.length ? conversationIds : (await src.conversations(fromMs - 6 * 3600_000)).filter((c) => c.start_time <= until).map((c) => c.id).slice(-3);
    const out: PolledUtterance[] = [];
    for (const id of ids) {
      const c = await src.conversation(id);
      if (!c) continue;
      const utts = pickUtterances(c);
      const counts: Record<string, number> = {};
      for (const u of utts) counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
      const w = discoverWearerLabels(counts, me);
      for (const u of utts) {
        if (!isWearer(u.speaker, w) || u.spoken_at == null) continue;
        const s = toMs(u.spoken_at)!;
        out.push({ id: u.id, text: u.text, startMs: s, endMs: s + (u.start != null && u.end != null ? Math.max(0, u.end - u.start) * 1000 : 0) });
      }
    }
    return out;
  };
  const hub = new CoachHub({
    mode: "live",
    deck,
    deckPath,
    attempts: loadAttempts(attemptsPath),
    attemptsPath,
    sessions: loadRealSessions(dir),
    prereg,
    preregPath,
    wearer: wearerRule(me),
    timings: DEFAULT_TIMINGS,
    poll,
    replay: false,
  });
  const stream = opts.bee === false ? null : spawnBeeStream({ onEvent: (e) => hub.ingestBee(e), log });
  return {
    hub,
    calendar: beeCalendar(),
    stream,
    demo: null,
    describe: { mode: "live", deckPath, attemptsPath, cards: deck.cards.length, sessions: hub.sessions.length, prereg: prereg ? preregPath : null, beeStream: stream ? "bee stream (spawned)" : "off (--no-bee)", wearerProfile: !!me },
    stop: () => stream?.stop(),
  };
}

// Demo

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export class DemoDirector {
  private n = 0;
  private uttId = 9_100_000;
  private handles: StreamHandle[] = [];
  readonly pollStore: PolledUtterance[] = [];
  readonly convUuid = "demo-0000-4000-8000-000000000001";
  private cycle: DemoScenario[];
  forceNext: DemoScenario | null = null; // set just before a submit to pick that attempt's scenario

  constructor(
    private hub: CoachHub,
    private pace: number,
    cycle: DemoScenario[] = DEMO_DEFAULT_CYCLE,
  ) {
    this.cycle = cycle;
  }

  start() {
    this.emitLater([{ dtMs: 0, event: { type: "new-conversation", conversation: { id: 99_000_001, conversation_uuid: this.convUuid, start_time: new Date(this.hub.clock()).toISOString(), state: "CAPTURING" } } }]);
  }

  private emitLater(steps: ReplayStep[]) {
    this.handles.push(replay(steps, (e) => this.hub.ingestBee(e), this.pace));
  }

  private utterance(text: string, endMs: number, durMs: number): { id: number; event: BeeEvent } {
    const id = ++this.uttId;
    const startMs = endMs - durMs;
    return {
      id,
      event: { type: "new-utterance", conversation_uuid: this.convUuid, utterance: { id, sample_id: `demo-sample-${id}`, start: 0, end: durMs / 1000, text, spoken_at: new Date(Math.floor(startMs / 1000) * 1000).toISOString() } },
    };
  }

  private tag(id: number, name: string, score: number): BeeEvent {
    return { type: "tagged-utterance", utterance_id: id, person_id: name === DEMO_WEARER.first_name ? 1 : 2, person_first_name: name, speaker_score: score, conversation_uuid: this.convUuid };
  }

  // Bee's "transcript" of what the wearer said, per scenario.
  static beeText(text: string, s: DemoScenario): string {
    if (s === "bee-hears-filler") return `Um, ${text[0]!.toLowerCase()}${text.slice(1)}`;
    if (s === "merged") return `${/[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`} How did I do?`;
    if (s === "asr-slip") {
      let t = text.replace(/\bcard\b/gi, "car").replace(/\brack board\b/gi, "rec board");
      if (t === text) t = text.replace(/\b(\p{L}{6,})\b/u, (w) => w.slice(0, -1));
      return t;
    }
    return text;
  }

  scenarioFor(attempt: Attempt): DemoScenario {
    void attempt;
    const f = this.forceNext;
    this.forceNext = null;
    return f ?? this.cycle[this.n++ % this.cycle.length]!;
  }

  // Replay Bee's view of a provisional attempt (5.4 s to the line, 0.5 s more to the tag).
  replayAttempt(a: Attempt, scenario = this.scenarioFor(a)) {
    if (!a.provisional) return scenario;
    const end = a.provisional.speechEndAt;
    const words = a.provisional.text.split(/\s+/).length;
    const dur = Math.max(1500, (words / 2.5) * 1000);
    const u = this.utterance(DemoDirector.beeText(a.provisional.text, scenario), end, dur);
    if (scenario === "poll") {
      this.pollStore.push({ id: u.id, text: DemoDirector.beeText(a.provisional.text, "verified"), startMs: end - dur, endMs: end });
      return scenario;
    }
    // Typical line at +5.4 s (tag +0.5 s); a merged line lands later (+16.5 s), as on the real device.
    const at = scenario === "merged" ? 16_500 : 5400;
    const steps: ReplayStep[] = [{ dtMs: at, event: u.event }];
    if (scenario === "other-speaker") steps.push({ dtMs: at + 500, event: this.tag(u.id, "Sam", 0.77) });
    else if (scenario !== "untagged") steps.push({ dtMs: at + 500, event: this.tag(u.id, DEMO_WEARER.first_name, 0.82) });
    this.emitLater(steps);
    return scenario;
  }

  // Bee hears the wearer say the open card with no phone/Alexa preview.
  replayBeeOnly(text?: string) {
    const st = this.hub.sessionState();
    const t = text ?? st.openCard?.resay;
    if (!t) return null;
    const u = this.utterance(t, this.hub.clock(), Math.max(1500, (t.split(/\s+/).length / 2.5) * 1000));
    this.emitLater([
      { dtMs: 5400, event: u.event },
      { dtMs: 5900, event: this.tag(u.id, DEMO_WEARER.first_name, 0.82) },
    ]);
    return { utteranceId: u.id, text: t };
  }

  poll: PollFn = async ({ fromMs, toMs: until }) => this.pollStore.filter((l) => l.endMs >= fromMs && l.startMs <= until);

  stop() {
    this.handles.forEach((h) => h.stop());
  }
}

export function demoSetup(opts: { pace?: number; fixturesDir?: string; stateDir?: string | null; cycle?: DemoScenario[] } = {}): Setup {
  const dir = opts.fixturesDir ?? "fixtures/demo";
  const pace = opts.pace ?? 1;
  const realStart = Date.now();
  const clock = () => DEMO_EPOCH + (Date.now() - realStart);
  const deck = readJson<HubDeck>(join(dir, "deck.json"));
  deck.cards = deck.cards.map((c: HubCard) => ({ ...c, habit: c.habit ?? deriveHabit(c), mustSay: c.mustSay ?? deriveMustSay(c) }));
  const attempts = readJson<{ attempts: Attempt[] }>(join(dir, "attempts.json")).attempts;
  const sessions = readJson<{ sessions: StatSession[] }>(join(dir, "sessions.json")).sessions;
  const prereg = readJson<TransferPrereg>(join(dir, "prereg-transfer.json"));
  const demo = readJson<{ calendar: { title: string; startsAt: string }[] }>(join(dir, "demo.json"));
  const stateDir = opts.stateDir === undefined ? "out/demo" : opts.stateDir;
  const deckPath = stateDir ? join(stateDir, "deck.json") : null;
  if (deckPath) saveHubDeck(deckPath, deck); // fresh copy every start: demo runs are reproducible
  let director: DemoDirector | null = null;
  const hub = new CoachHub({
    mode: "demo",
    clock,
    tz: DEMO_TZ,
    deck,
    deckPath,
    attempts,
    attemptsPath: stateDir ? join(stateDir, "attempts.json") : null,
    sessions,
    prereg,
    preregPath: join(dir, "prereg-transfer.json"),
    wearer: wearerRule(DEMO_WEARER, ""),
    timings: scaleTimings(DEFAULT_TIMINGS, pace),
    poll: (q) => director!.poll(q),
    replay: true,
    dataLabel: DEMO_LABEL,
  });
  director = new DemoDirector(hub, pace, opts.cycle);
  director.start();
  hub.on("event", (ev) => {
    if (ev.topic !== "attempt.provisional") return;
    const a = (ev.payload as { attempt: Attempt }).attempt;
    director!.replayAttempt(a);
  });
  const calendar: CalendarFn = async () => ({ events: demo.calendar.map((e) => ({ title: e.title, startsAt: Date.parse(e.startsAt) })), source: "demo calendar (injected; live mode reads Bee's today brief)" });
  return {
    hub,
    calendar,
    stream: null,
    demo: director,
    describe: { mode: "demo", label: DEMO_LABEL, beeStream: "REPLAY of recorded-shape Bee events (no Watch, no network)", pace, demoNow: new Date(DEMO_EPOCH).toISOString(), fixtures: dir, stateDir },
    stop: () => director!.stop(),
  };
}
