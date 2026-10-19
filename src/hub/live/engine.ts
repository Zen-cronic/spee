// The live engine: Bee lines in, live windows, nudges and recaps out.
//
//   bee.line / bee.conversation (core.ts, from the one `bee stream` subscriber)
//     -> ConversationWindow (window.ts) -> rules (rules.ts) -> policy (policy.ts)
//     -> wrist (wrist.ts) -> nudge.sent | nudge.skipped
//   end of conversation (Bee leaves CAPTURING, 90 s idle, or a new uuid)
//     -> conversation.ended -> recap (recap.ts; optional model phrasing) -> recap.ready -> wrist -> disk
//
// The model observes and proposes; code decides. Rules and policy read numbers only, and the
// optional model call (recap phrasing) runs off the request path. coachNow() is deterministic.
//
// PRIVACY. Wearer text stays in memory (the window); other speakers are word counts. Persisted
// under <stateDir>/live/: recaps.json (the recap moment is <= 12 of the wearer's own words) and
// nudges.json (generated text and numbers only).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeeConversationEvent, BeeLine } from "../bee.js";
import type { CoachNow, ConversationEnded, LiveModeRequest, LiveModeResponse, LiveState, Nudge, NudgeSkipped, Recap, SequencedTopic } from "../contract.js";
import type { CoachHub } from "../core.js";
import { localDate } from "../../real/deck.js";
import { computeBaseline, type Baseline } from "./baseline.js";
import { clockTime, LivePolicy, modeNarration } from "./policy.js";
import type { Principles } from "./principles.js";
import { buildRecap } from "./recap.js";
import { phraseRecap, type PhraseFn } from "./recapPrompt.js";
import { firing, nudgeText, windowThresholds } from "./rules.js";
import { ConversationWindow, type Analysis, type RuleEvidence, type WinLine } from "./window.js";
import type { Wrist } from "./wrist.js";

export const DRILL_RECENT_MS = 5 * 60_000; // a card opened this recently counts as drilling
// Observed 2026-10-16: Bee sends update-conversation (state PROCESSING, end_time set) when the
// recording stops and, for a conversation it discards, delete-conversation about 0.4 s later. The
// end is held this long (story ms, scaled by the pace) so a deleted conversation never gets a recap,
// and so Bee's last lines, which lag the stop by 4.3 to 14.7 s (observed), still land in this window
// and its recap instead of opening a phantom second window for the same conversation.
export const BEE_DELETE_GRACE_MS = 20_000;
const KEEP_EVENTS = 200;
const KEEP_RECAPS = 200;

export interface EngineOptions {
  hub: CoachHub;
  publish: (topic: SequencedTopic, data: Record<string, unknown>) => unknown;
  pace: number;
  demo: boolean;
  stateDir: string | null;
  wrist: Wrist;
  principles: Principles;
  baselineWpm: number | null;
  log?: (event: string, data?: Record<string, unknown>) => void;
  phrase?: PhraseFn | null; // optional model phrasing of recaps (null: template only)
  loadState?: boolean; // live: reload earlier recaps from disk
}

let idN = 0;
const newId = (p: string, now: number) => `${p}_${now.toString(36)}${(idN++ % 1296).toString(36).padStart(2, "0")}`;
const f1 = (x: number) => x.toFixed(1);

export class LiveEngine {
  readonly policy: LivePolicy;
  private win: ConversationWindow | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pendingEnd: { uuid: string; timer: NodeJS.Timeout; endMs: number | null } | null = null;
  private deleted = new Set<string>(); // Bee deleted these conversations: no recap, ever
  private expiryTimer: NodeJS.Timeout | null = null;
  private recapChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private baseline: Baseline;
  private baselineAt = 0;
  recaps: Recap[] = [];
  nudges: Nudge[] = [];
  skips: NudgeSkipped[] = [];
  readonly counters = { lines: 0, wearerLines: 0, conversations: 0, nudges: 0, skips: 0, recaps: 0, recapsSkipped: 0, llmAccepted: 0, llmRejected: 0 };

  constructor(private o: EngineOptions) {
    const th = o.principles.thresholds;
    this.policy = new LivePolicy({ pace: o.pace, tz: o.hub.tz, fastRate: th.rate.fastRateNudge });
    this.baseline = computeBaseline(o.hub, { wpm: o.baselineWpm, synthetic: o.demo });
    this.baselineAt = o.hub.clock();
    if (o.loadState && o.stateDir) this.load();
    o.wrist.onCircuitOpen = () => {
      const m = this.policy.turnOff("wrist-down", this.now());
      if (m) this.publish("live.mode", { mode: m });
    };
  }

  private now() {
    return this.o.hub.clock();
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.o.log?.(event, data);
  }
  private publish(topic: SequencedTopic, data: Record<string, unknown>) {
    if (!this.stopped) this.o.publish(topic, data);
  }
  private get th() {
    return this.o.principles.thresholds;
  }
  private get dir() {
    return this.o.stateDir ? join(this.o.stateDir, "live") : null;
  }

  // Persistence

  private load() {
    const d = this.dir!;
    try {
      if (existsSync(join(d, "recaps.json"))) this.recaps = (JSON.parse(readFileSync(join(d, "recaps.json"), "utf8")) as { recaps?: Recap[] }).recaps ?? [];
      if (existsSync(join(d, "nudges.json"))) {
        const n = JSON.parse(readFileSync(join(d, "nudges.json"), "utf8")) as { nudges?: Nudge[]; skips?: NudgeSkipped[] };
        this.nudges = n.nudges ?? [];
        this.skips = n.skips ?? [];
      }
    } catch (e) {
      this.log("live.load.failed", { error: (e as Error).message });
    }
  }
  private write(file: string, data: unknown) {
    const d = this.dir;
    if (!d) return;
    mkdirSync(d, { recursive: true });
    const p = join(d, file);
    writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 1) + "\n");
    renameSync(`${p}.tmp`, p);
  }
  private saveRecaps() {
    this.recaps = this.recaps.slice(-KEEP_RECAPS);
    this.write("recaps.json", { dataLabel: this.o.hub.dataLabel, note: "live-coaching recaps: wearer metrics and one short wearer moment each; never other speakers' words", recaps: this.recaps });
  }
  private saveEvents() {
    this.nudges = this.nudges.slice(-KEEP_EVENTS);
    this.skips = this.skips.slice(-KEEP_EVENTS);
    this.write("nudges.json", { dataLabel: this.o.hub.dataLabel, nudges: this.nudges, skips: this.skips });
  }

  // Baseline (refreshed at most every 10 min, at conversation start)

  private freshBaseline(): Baseline {
    if (this.now() - this.baselineAt > 10 * 60_000) {
      this.baseline = computeBaseline(this.o.hub, { wpm: this.o.baselineWpm, synthetic: this.o.demo });
      this.baselineAt = this.now();
    }
    return this.baseline;
  }

  get phrasing(): "template" | "llm" {
    return this.o.phrase ? "llm" : "template";
  }
  setPhrase(p: PhraseFn | null) {
    this.o.phrase = p;
  }

  // Mode

  setMode(req: LiveModeRequest): LiveModeResponse {
    const mode = this.policy.set(req, this.now());
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (mode.enabled && mode.expiresAt != null) {
      this.expiryTimer = setTimeout(() => this.checkExpiry(), Math.max(0, mode.expiresAt - this.now()) + 5);
      this.expiryTimer.unref?.();
    }
    this.publish("live.mode", { mode });
    this.log("live.mode", { enabled: mode.enabled, by: mode.by, expiresAt: mode.expiresAt });
    return { mode, narration: modeNarration(mode, this.o.hub.tz) };
  }

  private checkExpiry() {
    const m = this.policy.expireIfDue(this.now());
    if (m) {
      this.publish("live.mode", { mode: m });
      this.log("live.mode", { enabled: false, reason: "expired" });
    }
  }

  // Bee input

  onConversation(c: BeeConversationEvent) {
    if (this.stopped) return;
    const uuid = c.uuid ?? `bee-${c.id}`;
    if (c.type === "new-conversation") {
      if (this.win && this.win.conversationId !== uuid) this.end("new-conversation");
      if (!this.win) {
        this.win = new ConversationWindow(uuid, c.startMs ?? c.receivedAt, this.o.demo, this.o.pace);
        this.armIdle();
      }
      return;
    }
    if (c.type === "delete-conversation") return this.onDeleted(uuid, c.endMs);
    // update-conversation: the recording stopped when the state leaves CAPTURING or end_time is set.
    const leaving = (c.state != null && c.state !== "CAPTURING") || c.endMs != null;
    if (!leaving || this.win?.conversationId !== uuid || this.pendingEnd?.uuid === uuid) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const timer = setTimeout(() => {
      this.pendingEnd = null;
      if (this.win?.conversationId === uuid) this.end("bee-state", c.endMs);
    }, BEE_DELETE_GRACE_MS * this.o.pace);
    timer.unref?.();
    this.pendingEnd = { uuid, timer, endMs: c.endMs };
  }

  // Bee deleted a conversation: drop its window without a recap, cancel a queued recap, and
  // retract a recap already made (memory and disk). Events already published stay published.
  private onDeleted(uuid: string, endMs: number | null) {
    this.deleted.add(uuid);
    if (this.deleted.size > 500) this.deleted.delete(this.deleted.values().next().value!);
    if (this.pendingEnd?.uuid === uuid) {
      clearTimeout(this.pendingEnd.timer);
      this.pendingEnd = null;
    }
    if (this.win?.conversationId === uuid) this.end("bee-state", endMs, { deleted: true });
    const before = this.recaps.length;
    this.recaps = this.recaps.filter((r) => r.conversationId !== uuid);
    if (this.recaps.length !== before) {
      this.saveRecaps();
      this.log("live.recap.retracted", { conversationId: uuid, recaps: before - this.recaps.length });
    }
  }

  onTodoDeleted(t: { id: string }) {
    this.o.wrist.reconcileDeleted?.(t.id);
  }

  onLine(l: BeeLine) {
    if (this.stopped) return;
    this.counters.lines++;
    const uuid = l.conversationUuid ?? "bee-unknown";
    if (this.deleted.has(uuid)) return;
    if (this.win && this.win.conversationId !== uuid) this.end("new-conversation");
    if (!this.win) this.win = new ConversationWindow(uuid, l.spokenAt, this.o.demo, this.o.pace);
    const w = this.win;
    const line = w.upsert(l);
    if (this.pendingEnd?.uuid !== uuid) this.armIdle();
    if (!line || line.speaker !== "wearer") {
      if (w.started) this.pushWindow(w);
      return;
    }
    this.counters.wearerLines++;
    if (!w.started) {
      w.started = true;
      this.counters.conversations++;
      this.freshBaseline();
      this.publish("conversation.started", { conversationId: w.conversationId, startedAt: w.startedAt, replay: w.replay });
      this.log("live.conversation.started", { conversationId: w.conversationId });
    }
    const a = w.analyze(this.now(), windowThresholds(this.th), this.baseline);
    if (line.lang === "en") for (const e of firing(a.evidence, (r) => this.policy.ruleEnabled(r))) this.act(w, e, a, line);
    this.o.hub.publishLiveWindow(a.window);
  }

  private pushWindow(w: ConversationWindow) {
    this.o.hub.publishLiveWindow(w.analyze(this.now(), windowThresholds(this.th), this.baseline).window);
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end("idle"), this.th.recap.idleEndMs * this.o.pace);
    this.idleTimer.unref?.();
  }

  // Rules -> policy -> wrist

  private act(w: ConversationWindow, e: RuleEvidence, a: Analysis, line: WinLine) {
    w.consume(e.rule, a);
    // A rule that fires after the mode's end but before its timer ran: turn it off and say so now.
    this.checkExpiry();
    const now = this.now();
    const first = Math.min(...[...w.lines.values()].map((x) => x.ctStart));
    const d = this.policy.decide({ rule: e.rule, now, conversationMs: line.ctEnd - first, drillActive: this.o.hub.drillActive(DRILL_RECENT_MS * this.o.pace), wristDownUntil: this.o.wrist.circuitOpenUntil() });
    const evidence = { rule: e.rule, value: e.value, threshold: e.threshold, unit: e.unit, over: e.over, windowMs: e.windowMs, expected: e.expected };
    if (!d.allow) {
      const skip: NudgeSkipped = { id: newId("skp", now), conversationId: w.conversationId, rule: e.rule, reason: d.reason, detail: d.detail, at: now, retryAfterMs: d.retryAfterMs, evidence, replay: w.replay };
      w.nudges.skipped++;
      this.counters.skips++;
      this.skips.push(skip);
      this.saveEvents();
      this.publish("nudge.skipped", { skip });
      this.log("live.nudge.skipped", { id: skip.id, rule: e.rule, reason: d.reason });
      return;
    }
    this.policy.recordSent(e.rule, now);
    w.nudges.sent++;
    const id = newId("ndg", now);
    const text = nudgeText(e);
    const hops = { spokenAt: Math.round(line.endAt), beeAt: line.beeAt, detectedAt: now };
    void this.o.wrist.send({ kind: "nudge", refId: id, text }).then((r) => {
      if (this.stopped) return;
      const nudge: Nudge = {
        id,
        conversationId: w.conversationId,
        rule: e.rule,
        text,
        evidence,
        hops: { ...hops, todoAt: r.todoAt, alarmAt: r.alarmAt },
        latencyMs: { bee: hops.beeAt - hops.spokenAt, detect: hops.detectedAt - hops.beeAt, todo: r.todoAt == null ? null : r.todoAt - hops.detectedAt, total: r.alarmAt == null ? null : r.alarmAt - hops.spokenAt },
        wrist: { channel: r.channel, status: r.status, todoId: r.todoId, leadMs: r.leadMs, error: r.error },
        replay: w.replay,
      };
      this.counters.nudges++;
      this.nudges.push(nudge);
      this.saveEvents();
      this.publish("nudge.sent", { nudge });
      this.log("live.nudge.sent", { id, rule: e.rule, wrist: r.status, todoId: r.todoId });
    }).catch((err) => this.log("live.nudge.failed", { id, rule: e.rule, error: String((err as Error)?.message ?? err) })); // a full disk must not crash the hub
  }

  // End of conversation -> recap

  private end(reason: ConversationEnded["reason"], beeEndMs?: number | null, opts: { deleted?: boolean } = {}) {
    const w = this.win;
    if (!w) return;
    this.win = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.pendingEnd) {
      clearTimeout(this.pendingEnd.timer);
      this.pendingEnd = null;
    }
    if (!w.started) return; // no counted wearer line: nothing was announced
    this.o.hub.cancelLiveWindow(w.conversationId);
    const now = this.now();
    const a = w.analyze(now, windowThresholds(this.th), this.baseline);
    const lastEnd = Math.max(...[...w.lines.values()].map((l) => l.endAt));
    const endedAt = Math.round(reason === "bee-state" && beeEndMs != null ? beeEndMs : Number.isFinite(lastEnd) ? Math.min(lastEnd, now) : now);
    const words = a.window.wearer.words;
    // A conversation Bee deleted gets no recap. The contract has no "deleted" status yet, so it is
    // reported as skipped-short (docs/live.md, contract change requests).
    const recap: ConversationEnded["recap"] = opts.deleted || words < this.th.recap.minWearerWords ? "skipped-short" : a.englishWords < this.th.recap.minWearerWords ? "skipped-french" : "pending";
    const ended: ConversationEnded = { conversationId: w.conversationId, startedAt: w.startedAt, endedAt, reason, wearerWords: words, otherLines: a.window.others.lines, recap, replay: w.replay };
    this.publish("conversation.ended", { ...ended });
    this.log("live.conversation.ended", { conversationId: w.conversationId, reason, recap });
    if (recap !== "pending") {
      this.counters.recapsSkipped++;
      return;
    }
    this.recapChain = this.recapChain.then(() => this.makeRecap(w, a, endedAt)).catch((e) => this.log("live.recap.failed", { error: (e as Error).message }));
  }

  private async makeRecap(w: ConversationWindow, a: Analysis, endedAt: number) {
    if (this.stopped || this.deleted.has(w.conversationId)) return;
    const on = this.policy.isEnabled();
    const recap = buildRecap({
      id: newId("rcp", this.now()),
      win: w,
      a,
      baseline: this.baseline,
      endedAt,
      createdAt: this.now(),
      pace: this.o.pace,
      dataLabel: this.o.hub.dataLabel,
      synthetic: this.o.demo,
      delivery: { wrist: on ? (this.o.wrist.channel === "replay" ? "replay" : "scheduled") : "off", todoId: null },
      momentMaxWords: this.th.recap.momentMaxWords,
      monologueMs: this.th.monologue.nudgeMs,
    });
    if (this.o.phrase) {
      const p = await phraseRecap(recap, this.o.principles, this.o.phrase);
      if (p) (Object.assign(recap, p), (recap.phrasing = "llm"), this.counters.llmAccepted++);
      else this.counters.llmRejected++;
      recap.createdAt = this.now();
    }
    if (this.stopped || this.deleted.has(w.conversationId)) return;
    this.recaps.push(recap);
    this.counters.recaps++;
    this.publish("recap.ready", { recap });
    this.log("live.recap.ready", { id: recap.id, conversationId: recap.conversationId, phrasing: recap.phrasing });
    if (on && this.policy.isEnabled()) {
      const r = await this.o.wrist.send({ kind: "recap", refId: recap.id, text: recap.wristText });
      recap.delivery = { wrist: r.status, todoId: r.todoId };
    } else if (on) recap.delivery = { wrist: "off", todoId: null };
    this.saveRecaps();
  }

  // Reads

  current(): LiveState["conversation"] {
    const w = this.win;
    return w?.started ? w.analyze(this.now(), windowThresholds(this.th), this.baseline).window : null;
  }

  drillActive(): boolean {
    return this.o.hub.drillActive(DRILL_RECENT_MS * this.o.pace);
  }

  publicBaseline(): LiveState["baseline"] {
    const { vaguePer100: _v, restartsPer100: _r, ...b } = this.baseline;
    return b;
  }

  state(): LiveState {
    this.checkExpiry();
    const now = this.now();
    return {
      dataLabel: this.o.hub.dataLabel,
      synthetic: this.o.demo,
      mode: this.policy.mode(now),
      conversation: this.current(),
      drillActive: this.drillActive(),
      baseline: this.publicBaseline(),
      wrist: this.o.wrist.status(),
      lastNudge: this.nudges[this.nudges.length - 1] ?? null,
      recentNudges: [...this.nudges].reverse().slice(0, 10),
      recentSkips: [...this.skips].reverse().slice(0, 10),
      lastRecapId: this.recaps[this.recaps.length - 1]?.id ?? null,
    };
  }

  recapList(limit: number): Recap[] {
    return [...this.recaps].reverse().slice(0, limit);
  }
  recap(id: string): Recap | null {
    return this.recaps.find((r) => r.id === id) ?? null;
  }

  // "How am I doing?": deterministic, at most 3 sentences. Leads with the live conversation, else
  // today's last recap, else the week; then the week and due drills; then live mode.
  coachNow(): CoachNow {
    this.checkExpiry();
    const hub = this.o.hub;
    const now = this.now();
    const tz = hub.tz;
    const mode = this.policy.mode(now);
    const live = this.current();
    const last = this.recaps[this.recaps.length - 1] ?? null;
    const lastToday = last && localDate(last.endedAt, tz) === localDate(now, tz) ? last : null;
    const st = hub.stats({ kind: "week" });
    const h = st.habits;
    const per100 = (n: number) => (h.words ? Math.round((n / h.words) * 10_000) / 100 : 0);
    const hero = (["hedges", "vague"] as const).map((k) => ({ key: k, per100: h[k].per100, count: h[k].count })).filter((x) => x.count >= 3).sort((a, b) => b.per100 - a.per100);
    const rest = (["fillers", "restarts"] as const).map((k) => ({ key: k, per100: h[k].per100, count: h[k].count })).filter((x) => x.count > 0).sort((a, b) => b.per100 - a.per100);
    const top = hero[0] ?? rest[0] ?? null;
    const LABEL: Record<string, string> = { hedges: "hedging", vague: "vague answers", fillers: "fillers", restarts: "restarts" };
    const NOUN: Record<string, string> = { hedges: "hedges", vague: "vague answers", fillers: "fillers", restarts: "restarts" };
    const due = hub.deckSummary().dueNow;
    const next = hub.nextCard();

    let basis: CoachNow["basis"];
    let lead: string;
    if (live && live.wearer.words >= 20) {
      basis = "live";
      lead = `You're in a conversation now: ${live.recent.hedges} ${live.recent.hedges === 1 ? "hedge" : "hedges"} in the last 2 minutes${live.wearer.wpm != null ? `, at ${live.wearer.wpm} words a minute` : ""}.`;
    } else if (lastToday) {
      basis = "recap";
      const worst = lastToday.metrics.habits.filter((x) => x.verdict === "worse")[0];
      const hd = lastToday.metrics.habits.find((x) => x.key === "hedges");
      const noun = (k: string) => (k === "hedges" ? "hedges" : k === "filler:like" ? '"like"' : k === "vague" ? "vague answers" : "restarts");
      const turn = lastToday.metrics.longestMonologueMs;
      lead = worst
        ? `Your last conversation ran high on ${noun(worst.key)}: ${worst.count}, or ${f1(worst.per100)} per 100 words against your usual ${f1(worst.baselinePer100 ?? 0)}.`
        : turn >= this.th.monologue.nudgeMs
          ? `In your last conversation, one turn ran ${(Math.round(turn / 6000) / 10).toFixed(1)} minutes without a break.`
          : hd && hd.baselinePer100 != null
          ? `Your last conversation looked typical: ${f1(hd.per100)} hedges per 100 words against your usual ${f1(hd.baselinePer100)}.`
          : `Your last conversation is recapped: ${lastToday.headline}`;
    } else {
      basis = "week";
      lead = top ? `This week your top habit is ${LABEL[top.key]}, at ${f1(top.per100)} per 100 words.` : "There is not enough of your speech this week to pick a habit yet.";
    }
    const drills = due === 0 ? "no drills are due" : due === 1 ? "1 drill is due" : `${due} drills are due`;
    const week = basis === "week" ? `${drills[0]!.toUpperCase()}${drills.slice(1)}.` : top ? `This week you are at ${f1(top.per100)} ${NOUN[top.key]} per 100 words, and ${drills}.` : `${drills[0]!.toUpperCase()}${drills.slice(1)}.`;
    const modeLine = mode.enabled && mode.expiresAt != null ? `Live coaching is on until ${clockTime(mode.expiresAt, tz)}.` : "Live coaching is off.";
    const t = hub.transfer();
    return {
      dataLabel: hub.dataLabel,
      synthetic: this.o.demo,
      generatedAt: now,
      basis,
      narration: [lead, week, modeLine].join(" "),
      mode,
      live,
      lastRecap: lastToday ? { id: lastToday.id, endedAt: lastToday.endedAt, headline: lastToday.headline } : null,
      week: { words: h.words, hedgesPer100: h.hedges.per100, likesPer100: per100(h.fillers.breakdown.like ?? 0), vaguePer100: h.vague.per100, topHabit: top ? { key: top.key, label: LABEL[top.key]!, per100: top.per100 } : null },
      drills: { dueNow: due, nextCardId: next?.id ?? null },
      transferHeadline: t?.headline ?? null,
    };
  }

  // Wait for queued recaps (tests, scripts).
  settle(): Promise<void> {
    return this.recapChain;
  }

  stop() {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.pendingEnd) clearTimeout(this.pendingEnd.timer);
    this.o.wrist.stop();
  }
}
