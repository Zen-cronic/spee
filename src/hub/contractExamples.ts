// Hand-written SYNTHETIC examples of every v2 payload (contract v2, lead-owned), type-checked
// against src/hub/contract.ts. `npm run contract:fixtures` writes them to fixtures/contract-v2/
// and refreshes the matching blocks in docs/CONTRACT.md; test/contract-v2.test.ts fails if either
// drifts. The wearer is the invented demo wearer "Ada"; the other speaker in the conversation is
// counted, never quoted. Times are on the demo clock (2026-10-20 13:30 EDT = DEMO_EPOCH).
import {
  CONTRACT_VERSION,
  MCP_TOOLS,
  type CoachNow,
  type ConversationEnded,
  type ConversationStarted,
  type DemoLiveRequest,
  type DemoLiveResponse,
  type DemoMirrorRequest,
  type DemoMirrorResponse,
  type LiveBaseline,
  type LiveMode,
  type LiveModeRequest,
  type LiveModeResponse,
  type LiveState,
  type LiveWindow,
  type MirrorFocus,
  type Nudge,
  type NudgeSkipped,
  type PracticeMeters,
  type PracticeSummary,
  type Recap,
  type RecapList,
  type RuleState,
  type SequencedTopic,
  type TopicPayloads,
  type WristStatus,
} from "./contract.js";

const LABEL = "SYNTHETIC DEMO DATA (invented; not anyone's real results)";
const E = Date.parse("2026-10-20T13:30:00-04:00"); // demo "now" (DEMO_EPOCH)
const sec = (s: number) => Math.round(s * 1000);
const CONV = "demo-0000-4000-8000-000000000101";
const C0 = E + sec(60); // the demo conversation starts at 13:31:00 EDT
const MODE_ON_AT = E + sec(30);

// Live mode

const modeBase: Omit<LiveMode, "enabled" | "since" | "expiresAt" | "changedAt" | "by" | "reason" | "sent"> = {
  rules: { "hedge-streak": true, "like-streak": true, monologue: true, "fast-rate": false },
  quietHours: { startHour: 22, endHour: 8 },
  warmupMs: 60_000,
  cooldownMs: 180_000,
  ruleCooldownMs: 600_000,
  capPerHour: 6,
  capPerDay: 20,
};
export const modeOn: LiveMode = { ...modeBase, enabled: true, since: MODE_ON_AT, expiresAt: MODE_ON_AT + 60 * 60_000, changedAt: MODE_ON_AT, by: "alexa", reason: "on", sent: { lastHour: 0, today: 0 } };
const modeOnAfterNudge: LiveMode = { ...modeOn, sent: { lastHour: 1, today: 1 } };
export const modeOff: LiveMode = { ...modeBase, enabled: false, since: null, expiresAt: null, changedAt: E + sec(1200), by: "alexa", reason: "off", sent: { lastHour: 1, today: 1 } };

export const liveModeOn: LiveModeResponse = { mode: modeOn, narration: "Live coaching is on for 60 minutes. I'll set a reminder on your wrist if a habit keeps coming up." };
export const liveModeOff: LiveModeResponse = { mode: modeOff, narration: "Live coaching is off. I'll still recap your conversations." };

// The live window

export const baseline: LiveBaseline = { source: "bee week (non-drill conversations; synthetic)", range: "week", words: 1400, hedgesPer100: 1.43, likesPer100: 1.79, fillersPer100: 2.43, wpm: 140 };

const rule = (r: RuleState["rule"], value: number, threshold: number, unit: RuleState["unit"]): RuleState => ({ rule: r, value, threshold, unit, over: value >= threshold });

function win(atS: number, o: { lines: number; words: number; talkS: number; wpm: number; oLines: number; oWords: number; mono: [number, number]; pauses: [number, number]; recent: [number, number, number, number, number]; totals: [number, number, number, number, number]; hedgeThr: number; likeThr: number }): LiveWindow {
  const [h, l, f, v, r] = o.recent;
  const [th, tl, tf, tv, tr] = o.totals;
  return {
    conversationId: CONV,
    startedAt: C0,
    updatedAt: C0 + sec(atS),
    replay: true,
    lang: "en",
    wearer: { lines: o.lines, words: o.words, talkMs: sec(o.talkS), wpm: o.wpm },
    others: { lines: o.oLines, words: o.oWords },
    talkShare: Math.round((o.words / (o.words + o.oWords)) * 100) / 100,
    monologue: { currentMs: sec(o.mono[0]), longestMs: sec(o.mono[1]) },
    pauses: { count: o.pauses[0], longestMs: sec(o.pauses[1]) },
    recent: { windowMs: 120_000, hedges: h, likes: l, fillers: f, vague: v, restarts: r },
    totals: { hedges: th, likes: tl, fillers: tf, vague: tv, restarts: tr },
    skipped: { frenchLines: 0, drillLines: 0 },
    rules: [rule("hedge-streak", h, o.hedgeThr, "count"), rule("like-streak", l, o.likeThr, "count"), rule("monologue", sec(o.mono[0]), 90_000, "ms"), rule("fast-rate", o.wpm, 175, "wpm")],
  };
}

export const window1 = win(30, { lines: 3, words: 52, talkS: 22, wpm: 142, oLines: 2, oWords: 31, mono: [9, 14], pauses: [1, 1.2], recent: [1, 1, 1, 0, 0], totals: [1, 1, 1, 0, 0], hedgeThr: 3, likeThr: 4 });
export const window2 = win(95, { lines: 8, words: 141, talkS: 60, wpm: 141, oLines: 6, oWords: 98, mono: [0, 31], pauses: [4, 2.1], recent: [3, 2, 2, 1, 0], totals: [3, 2, 2, 1, 0], hedgeThr: 4.04, likeThr: 5.05 });
export const window3 = win(150, { lines: 12, words: 214, talkS: 91, wpm: 141, oLines: 9, oWords: 152, mono: [21, 48], pauses: [7, 2.6], recent: [5, 2, 3, 1, 1], totals: [5, 3, 4, 1, 1], hedgeThr: 4.72, likeThr: 5.91 });
export const window4 = win(215, { lines: 17, words: 318, talkS: 136, wpm: 140, oLines: 13, oWords: 221, mono: [0, 48], pauses: [11, 2.6], recent: [3, 1, 2, 0, 1], totals: [7, 4, 5, 1, 2], hedgeThr: 4.29, likeThr: 5.37 });
export const window5 = win(262, { lines: 21, words: 391, talkS: 168, wpm: 139, oLines: 15, oWords: 262, mono: [33, 48], pauses: [14, 3.1], recent: [5, 2, 3, 0, 1], totals: [9, 5, 6, 1, 2], hedgeThr: 4.58, likeThr: 5.73 });
export const window6 = win(318, { lines: 26, words: 520, talkS: 226, wpm: 138, oLines: 17, oWords: 392, mono: [74, 74], pauses: [19, 3.1], recent: [4, 2, 3, 0, 1], totals: [11, 6, 7, 1, 3], hedgeThr: 5.23, likeThr: 6.55 });

// Nudges

const spokenAt = C0 + sec(144.1); // the line that made it 5 unsure words (hedges) in 2 minutes ended here
const beeAt = spokenAt + 5900; // Bee's wearer tag arrived (new-utterance +5.4 s, tag +0.5 s)
const detectedAt = beeAt + 40;
const todoAt = detectedAt + 1450; // `bee todos create` returned
const alarmAt = todoAt + 10_000; // 10 s alarm lead: the Watch buzzes here
export const nudge: Nudge = {
  id: "ndg_demo_0001",
  conversationId: CONV,
  rule: "hedge-streak",
  text: "[coach] 5 unsure words in 2 minutes. Say it plainly.",
  evidence: { ...rule("hedge-streak", 5, 4.72, "count"), windowMs: 120_000, expected: 2.36 },
  hops: { spokenAt, beeAt, detectedAt, todoAt, alarmAt },
  latencyMs: { bee: beeAt - spokenAt, detect: detectedAt - beeAt, todo: todoAt - detectedAt, total: alarmAt - spokenAt },
  wrist: { channel: "replay", status: "replay", todoId: null, leadMs: 10_000, error: null },
  replay: true,
};
const skipAt = C0 + sec(262) + 40;
export const skip: NudgeSkipped = {
  id: "skp_demo_0001",
  conversationId: CONV,
  rule: "hedge-streak",
  reason: "cooldown",
  detail: "a nudge went out 1 min 52 s ago; nudges are at least 3 min apart",
  at: skipAt,
  retryAfterMs: detectedAt + 180_000 - skipAt,
  evidence: { ...rule("hedge-streak", 5, 4.58, "count"), windowMs: 120_000, expected: 2.29 },
  replay: true,
};

export const wristStatus: WristStatus = { channel: "replay", healthy: true, failures: 0, circuitOpenUntil: null, leadMs: 10_000, pendingTodos: 1 };

// Conversation start and end

const ENDED_AT = C0 + sec(408); // the last wearer line ended at +318 s; 90 s idle ends it
export const started: ConversationStarted = { conversationId: CONV, startedAt: C0, replay: true };
export const ended: ConversationEnded = { conversationId: CONV, startedAt: C0, endedAt: ENDED_AT, reason: "idle", wearerWords: 520, otherLines: 17, recap: "pending", replay: true };

// Recap

export const recap: Recap = {
  dataLabel: LABEL,
  synthetic: true,
  id: "rcp_demo_0001",
  conversationId: CONV,
  startedAt: C0,
  endedAt: ENDED_AT,
  durationMs: ENDED_AT - C0,
  createdAt: ENDED_AT + 300,
  replay: true,
  metrics: {
    wearerWords: 520,
    wpm: 138,
    baselineWpm: 140,
    talkShare: 0.57,
    longestMonologueMs: 74_000,
    pauses: { count: 19, longestMs: 3100 },
    habits: [
      { key: "hedges", label: "unsure words (I guess, I think, maybe, kind of...)", count: 11, per100: 2.12, baselinePer100: 1.43, verdict: "worse" },
      { key: "filler:like", label: "filler \"like\"", count: 6, per100: 1.15, baselinePer100: 1.79, verdict: "better" },
      { key: "vague", label: "vague answers", count: 1, per100: 0.19, baselinePer100: 0.64, verdict: "better" },
      { key: "restart", label: "starting over (the the, I I)", count: 3, per100: 0.58, baselinePer100: 0.86, verdict: "typical" },
    ],
  },
  headline: "Unsure words ran high: 2.1 per 100 words against your usual 1.4. Filler \"like\" was down.",
  moment: { text: "I guess we could maybe ship the export on Friday.", at: C0 + sec(141), habit: "hedges", rephrase: "We could ship the export on Friday." },
  narration: "That conversation ran about 7 minutes. You used 11 unsure words, 2.1 out of every 100 words you said against your usual 1.4, and your pace held at 138 words a minute. Try it without the unsure words: \"We could ship the export on Friday.\"",
  wristText: "[coach] Recap: more unsure words than usual, pace steady",
  phrasing: "template",
  nudges: { sent: 1, skipped: 1 },
  delivery: { wrist: "replay", todoId: null },
};
export const recaps: RecapList = { dataLabel: LABEL, synthetic: true, recaps: [recap] };

// GET /api/live (a snapshot mid-conversation, just after the nudge)

export const liveState: LiveState = {
  dataLabel: LABEL,
  synthetic: true,
  mode: modeOnAfterNudge,
  conversation: window4,
  drillActive: false,
  baseline,
  wrist: wristStatus,
  lastNudge: nudge,
  recentNudges: [nudge],
  recentSkips: [],
  lastRecapId: null,
};

// GET /api/coach/now (after the conversation; leads with the recap)

export const coachNow: CoachNow = {
  dataLabel: LABEL,
  synthetic: true,
  generatedAt: ENDED_AT + sec(45),
  basis: "recap",
  narration: 'Your last conversation ran high on unsure words: 11, or 2.1 out of every 100 words you said, against your usual 1.4. First signal, from one conversation and not proof: in your next conversation after practising, unsure words went from 2.6 to 0.8 and filler "like" from 3.2 to 0.8 per 100 words. This week, unsure words are at 1.4 per 100 words, and 2 lines are ready to practise. Live coaching is on until 2:30 PM.',
  mode: modeOnAfterNudge,
  live: null,
  lastRecap: { id: recap.id, endedAt: recap.endedAt, headline: recap.headline },
  week: { words: 1400, hedgesPer100: 1.43, likesPer100: 1.79, vaguePer100: 0.64, topHabit: { key: "hedges", label: "unsure words", per100: 1.43 } },
  drills: { dueNow: 2, nextCardId: "demo:hedge-i-guess" },
  transferHeadline: "Unsure words and filler \"like\" dropped in your real conversations since you started practising; the one you didn't practise stayed the same",
};

// POST /api/demo/live and the events it produces (pace 1; atMs after the call)

type Step<T extends SequencedTopic = SequencedTopic> = { [K in T]: { atMs: number; topic: K; payload: TopicPayloads[K] } }[T];
const at = (t: number) => sec(1 + (t - C0) / 1000); // the conversation starts 1 s after the call
export const liveEvents: Step[] = [
  { atMs: at(C0), topic: "conversation.started", payload: started },
  { atMs: at(window1.updatedAt), topic: "live.window", payload: { window: window1 } },
  { atMs: at(window2.updatedAt), topic: "live.window", payload: { window: window2 } },
  { atMs: at(window3.updatedAt), topic: "live.window", payload: { window: window3 } },
  { atMs: at(todoAt), topic: "nudge.sent", payload: { nudge } },
  { atMs: at(window4.updatedAt), topic: "live.window", payload: { window: window4 } },
  { atMs: at(window5.updatedAt), topic: "live.window", payload: { window: window5 } },
  { atMs: at(skipAt), topic: "nudge.skipped", payload: { skip } },
  { atMs: at(window6.updatedAt), topic: "live.window", payload: { window: window6 } },
  { atMs: at(ENDED_AT), topic: "conversation.ended", payload: ended },
  { atMs: at(recap.createdAt), topic: "recap.ready", payload: { recap } },
];
export const demoLive: DemoLiveResponse = {
  replay: true,
  script: "story",
  conversationId: CONV,
  description: "Ada's 7-minute conversation (synthetic): 5 hedges in 2 minutes -> nudge.sent; a second streak inside the 3-minute cooldown -> nudge.skipped; 90 s idle -> conversation.ended -> recap.ready. With live coaching off, the first streak is nudge.skipped (reason off).",
  pace: 1,
  steps: liveEvents.map((s) => ({ atMs: s.atMs, what: s.topic })),
};

// Practice (phone mic, 10 Hz) and the mirror

const TAKE = "take_demo_01";
const T0 = E + sec(600);
const captions = [null, "So the", "So the", "So the export", "So the export", "So the export is", "So the export is ready", "So the export is ready", "So the export is ready for", "So the export is ready for review"];
const db = [-41.5, -30.2, -26.8, -24.1, -23.5, -25.9, -22.7, -38.4, -24.6, -23.9];
const hz = [null, 184.2, 196.8, 205.1, 189.7, 176.3, 211.4, null, 198.2, 182.6];
export const meterFrames: PracticeMeters[] = db.map((d, i) => ({
  takeId: TAKE,
  frame: 120 + i, // one second from the middle of the take (12.0-12.9 s)
  t: 12_000 + i * 100,
  at: T0 + 12_000 + i * 100,
  rmsDbfs: d,
  band: d < -35 ? "quiet" : d > -12 ? "loud" : "ok",
  voiced: hz[i] != null,
  pitchHz: hz[i] ?? null,
  pitchRangeSt: [4.2, 4.2, 4.3, 4.6, 4.6, 4.6, 4.9, 4.9, 4.9, 4.9][i]!,
  monotone: false,
  wpm: 152,
  pause: { active: hz[i] == null, currentMs: hz[i] == null ? 100 : 0, count: i < 1 ? 4 : 5 },
  caption: captions[i] ?? null,
}));
export const practiceSummary: PracticeSummary = {
  takeId: TAKE,
  room: "HJ3H",
  from: "phone-1",
  startedAt: T0,
  endedAt: T0 + 30_000,
  durationMs: 30_000,
  frames: 300,
  volume: { meanDbfs: -24.5, p10Dbfs: -31.2, p90Dbfs: -19.6, quietShare: 0.08, loudShare: 0.02 },
  pitch: { medianHz: 192, rangeSt: 5.8, voicedShare: 0.71, monotone: false },
  rate: { wpm: 178 },
  pauses: { count: 9, perMin: 18, meanMs: 520, longestMs: 1400 },
  words: 89,
  flags: ["fast"],
  provisional: true,
};
const focusPractice: MirrorFocus = { view: "practice", by: "phone-1", reason: "practice take started", recapId: null, takeId: TAKE };
export const practiceEvents: Step[] = [
  { atMs: 0, topic: "mirror.focus", payload: focusPractice },
  { atMs: 200, topic: "practice.summary", payload: { summary: practiceSummary } },
];
export const demoMirror: DemoMirrorResponse = { replay: true, script: "practice-take", takeId: TAKE, frames: meterFrames.length, hz: 10, durationMs: meterFrames.length * 100, rooms: 1 };

// Requests and client frames

const liveModeReqOn: LiveModeRequest = { enabled: true, minutes: 60, by: "alexa" };
const liveModeReqOff: LiveModeRequest = { enabled: false, by: "alexa" };
const demoLiveReq: DemoLiveRequest = { script: "story" };
const demoMirrorReq: DemoMirrorRequest = { script: "practice-take" };
export const requests = {
  note: "SYNTHETIC request bodies and bridge frames for the v2 routes and client topics.",
  "POST /api/live/mode (on)": liveModeReqOn,
  "POST /api/live/mode (off)": liveModeReqOff,
  "POST /api/demo/live": demoLiveReq,
  "POST /api/demo/mirror": demoMirrorReq,
  "WS mic -> hub practice.meters": { type: "app", topic: "practice.meters", payload: meterFrames[3]! },
  "WS hub -> room screens practice.meters": { type: "app", topic: "practice.meters", payload: { ...meterFrames[3]!, from: "phone-1" } },
  "WS mic -> hub practice.summary": { type: "app", topic: "practice.summary", payload: practiceSummary },
  "WS any -> hub mirror.focus": { type: "app", topic: "mirror.focus", payload: { view: "week", reason: "show my week" } },
};

// Alexa (packet C): one HowAmIDoing turn, envelope trimmed to the fields the skill reads.

export const alexaHowAmIDoing = {
  note: "SYNTHETIC. The skill id, user id and request id are placeholders; the response speaks GET /api/coach/now narration.",
  request: {
    version: "1.0",
    session: { new: false, sessionId: "amzn1.echo-api.session.00000000-demo", application: { applicationId: "amzn1.ask.skill.00000000-0000-0000-0000-000000000000" }, attributes: {}, user: { userId: "amzn1.ask.account.DEMO" } },
    request: { type: "IntentRequest", requestId: "amzn1.echo-api.request.00000000-demo", timestamp: new Date(ENDED_AT + sec(45)).toISOString(), locale: "en-CA", intent: { name: "HowAmIDoingIntent", confirmationStatus: "NONE" } },
  },
  response: { version: "1.0", sessionAttributes: {}, response: { outputSpeech: { type: "PlainText", text: coachNow.narration }, reprompt: { outputSpeech: { type: "PlainText", text: "Say quiz me to practise, or turn off live coaching." } }, shouldEndSession: false } },
};

export const mcpTools = { note: "The MCP tools at /mcp (stateless Streamable HTTP). Each result is content [{type:'text', text: narration}] plus structuredContent (the route's JSON); isError when the route answers >= 400.", contractVersion: CONTRACT_VERSION, tools: MCP_TOOLS };

// Every fixture file, by name (fixtures/contract-v2/<name>).
export function contractV2Fixtures(): Record<string, unknown> {
  return {
    "live.json": liveState,
    "live-mode-on.json": liveModeOn,
    "live-mode-off.json": liveModeOff,
    "recap.json": recap,
    "recaps.json": recaps,
    "coach-now.json": coachNow,
    "demo-live.json": demoLive,
    "events-live.json": { note: "SYNTHETIC. The sequenced events POST /api/demo/live publishes (script story, pace 1). atMs is after the call; the hub adds seq and at.", events: liveEvents },
    "practice-meters.json": { note: "SYNTHETIC. One second of a practice take: 10 meter frames at 10 Hz from the phone (mic -> hub -> that room's screens only).", frames: meterFrames },
    "events-practice.json": { note: "SYNTHETIC. The sequenced events around a practice take. atMs is after the last meter frame; the hub adds seq and at.", events: practiceEvents },
    "demo-mirror.json": demoMirror,
    "requests.json": requests,
    "mcp-tools.json": mcpTools,
    "alexa-how-am-i-doing.json": alexaHowAmIDoing,
  };
}

// docs/CONTRACT.md embeds fixture excerpts between markers:
//   <!-- fixture: events-live.json#/events/4/payload -->  ```json ... ```  <!-- /fixture -->
// The part after "#" is a JSON pointer into the file (optional).
export const fixtureJson = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
export function fixturePointer(files: Record<string, unknown>, ref: string): unknown {
  const [file, ptr] = ref.split("#") as [string, string | undefined];
  if (!(file in files)) throw new Error(`unknown fixture ${file}`);
  let v: unknown = files[file];
  for (const k of (ptr ?? "").split("/").filter(Boolean)) {
    if (v == null || typeof v !== "object" || !(k in (v as Record<string, unknown>))) throw new Error(`bad pointer ${ref}`);
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
const BLOCK = /<!-- fixture: ([^ ]+) -->\n```json\n[\s\S]*?```\n<!-- \/fixture -->/g;
export function syncFixtureBlocks(doc: string, files: Record<string, unknown>): string {
  return doc.replace(BLOCK, (_m, ref: string) => `<!-- fixture: ${ref} -->\n\`\`\`json\n${fixtureJson(fixturePointer(files, ref))}\`\`\`\n<!-- /fixture -->`);
}
export const fixtureRefs = (doc: string) => [...doc.matchAll(BLOCK)].map((m) => m[1]!);
