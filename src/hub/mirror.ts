// Mirror plugin (packet B): the practice meters, the practice summary and the mirror's focus.
//
//   app practice.meters  (mic)   relayed to the screens of the mic's room only, via
//                                ctx.broadcastToScreens (<= 20 Hz per room). No seq, never SSE,
//                                never /api/events/recent, never persisted, never to a mic. The
//                                frame is rebuilt from the contract fields (anything else is
//                                dropped) and stamped `from` = the mic's clientId.
//   app practice.summary (mic)   published as `practice.summary` (sequenced); the hub stamps
//                                room, from and provisional: true. Intent `practice.summary`.
//   app mirror.focus     (any)   published as `mirror.focus` with by = the peer's name.
//   POST /api/demo/mirror        demo only. "practice-take" plays a synthetic take: a synthetic
//                                voice is metered by the phone's own prosody engine
//                                (web/phone/src/prosody.ts), its frames go to the screens at
//                                10 Hz (not paced), then practice.summary. "focus" publishes
//                                mirror.focus for `view`. (In fixture mode the frozen fixture
//                                router answers this route before the plugins.)
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppMsg, PeerInfo } from "@rackboard/tv-voice-bridge";
import type { IntentResult, Room } from "@rackboard/tv-voice-bridge/hub";
import { PRACTICE_METERS_HZ, ROOM_RELAY_MAX_HZ, type DemoMirrorResponse, type MirrorView, type PracticeFlag, type PracticeMeters, type PracticeSummary, type VolumeBand } from "./contract.js";
import { matchRoute, type HubPlugin, type PluginCtx } from "./plugin.js";
import { ProsodyEngine, synthVoice } from "../../web/phone/src/prosody.js";

export const MIRROR_PREFIXES = ["/api/demo/mirror"];
export const MIRROR_ROUTES = ["POST /api/demo/mirror"];
export const MIRROR_TOPICS = ["practice.meters", "practice.summary", "mirror.focus"];

export const MIRROR_VIEWS: readonly MirrorView[] = ["week", "transfer", "drill", "live", "practice", "recap"];
const BANDS: readonly VolumeBand[] = ["quiet", "ok", "loud"];
const FLAGS: readonly PracticeFlag[] = ["quiet", "loud", "monotone", "fast", "slow", "few-pauses"];
export const CAPTION_MAX = 200; // characters of interim words relayed per frame
const ID_RE = /^[\w.:-]{1,64}$/;

export interface MirrorOptions {
  demoTakeMs?: number; // length of the demo practice take, 6000
}

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const nullableNum = (v: unknown, lo: number, hi: number): number | null | undefined => (v === null ? null : (num(v, lo, hi) ?? undefined));

// Rebuild a meter frame from the contract fields only; null when it is malformed.
export function sanitizeMeters(p: unknown, from: string): PracticeMeters | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const pause = (o.pause ?? {}) as Record<string, unknown>;
  const takeId = typeof o.takeId === "string" && ID_RE.test(o.takeId) ? o.takeId : null;
  const frame = num(o.frame, 0, 1e7);
  const t = num(o.t, 0, 1e9);
  const at = num(o.at, 0, 1e14);
  const rmsDbfs = num(o.rmsDbfs, -200, 0);
  const pitchHz = nullableNum(o.pitchHz, 0, 2000);
  const pitchRangeSt = num(o.pitchRangeSt, 0, 96);
  const wpm = nullableNum(o.wpm, 0, 1000);
  const currentMs = num(pause.currentMs, 0, 1e9);
  const count = num(pause.count, 0, 1e6);
  if (takeId === null || frame === null || t === null || at === null || rmsDbfs === null || pitchHz === undefined || pitchRangeSt === null || wpm === undefined || currentMs === null || count === null) return null;
  if (!BANDS.includes(o.band as VolumeBand) || typeof o.voiced !== "boolean" || typeof o.monotone !== "boolean" || typeof pause.active !== "boolean") return null;
  if (o.caption !== null && o.caption !== undefined && typeof o.caption !== "string") return null;
  const caption = typeof o.caption === "string" && o.caption.trim() ? o.caption.slice(-CAPTION_MAX) : null;
  return { takeId, frame, t, at, rmsDbfs, band: o.band as VolumeBand, voiced: o.voiced, pitchHz, pitchRangeSt, monotone: o.monotone, wpm, pause: { active: pause.active, currentMs, count }, caption, from };
}

// Rebuild a take summary; the hub stamps room, from and provisional.
export function sanitizeSummary(p: unknown, room: string, from: string): PracticeSummary | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, any>;
  const takeId = typeof o.takeId === "string" && ID_RE.test(o.takeId) ? o.takeId : null;
  const startedAt = num(o.startedAt, 0, 1e14);
  const endedAt = num(o.endedAt, 0, 1e14);
  const durationMs = num(o.durationMs, 0, 1e8);
  const frames = num(o.frames, 0, 1e7);
  const v = o.volume ?? {};
  const pi = o.pitch ?? {};
  const pa = o.pauses ?? {};
  const volume = { meanDbfs: num(v.meanDbfs, -200, 0), p10Dbfs: num(v.p10Dbfs, -200, 0), p90Dbfs: num(v.p90Dbfs, -200, 0), quietShare: num(v.quietShare, 0, 1), loudShare: num(v.loudShare, 0, 1) };
  const pitch = { medianHz: nullableNum(pi.medianHz, 0, 2000), rangeSt: num(pi.rangeSt, 0, 96), voicedShare: num(pi.voicedShare, 0, 1), monotone: typeof pi.monotone === "boolean" ? pi.monotone : null };
  const wpm = nullableNum(o.rate?.wpm, 0, 1000);
  const pauses = { count: num(pa.count, 0, 1e6), perMin: num(pa.perMin, 0, 1e4), meanMs: num(pa.meanMs, 0, 1e8), longestMs: num(pa.longestMs, 0, 1e8) };
  const words = nullableNum(o.words, 0, 1e6);
  if (takeId === null || startedAt === null || endedAt === null || durationMs === null || frames === null || wpm === undefined || words === undefined || pitch.medianHz === undefined) return null;
  if (Object.values(volume).some((x) => x === null) || pitch.rangeSt === null || pitch.voicedShare === null || pitch.monotone === null || Object.values(pauses).some((x) => x === null)) return null;
  const flags = Array.isArray(o.flags) ? [...new Set(o.flags.filter((f: unknown): f is PracticeFlag => FLAGS.includes(f as PracticeFlag)))] : [];
  return {
    takeId,
    room,
    from,
    startedAt,
    endedAt,
    durationMs,
    frames,
    volume: volume as PracticeSummary["volume"],
    pitch: pitch as PracticeSummary["pitch"],
    rate: { wpm },
    pauses: pauses as PracticeSummary["pauses"],
    words,
    flags,
    provisional: true,
  };
}

const DEMO_SR = 16000;
// Invented words for the synthetic demo speaker (wearer "Ada"); they are the take's captions.
const DEMO_CAPTION = "So the export ships on Friday. Two of the three checks pass, and the last one runs tonight.";

// A synthetic practice take metered by the phone's prosody engine (deterministic).
export function demoTake(takeMs: number, caption = DEMO_CAPTION) {
  const seconds = Math.max(1, Math.round(takeMs / 100) / 10);
  const pauses = seconds >= 4 ? [{ atMs: Math.round(seconds * 380), ms: 450 }, { atMs: Math.round(seconds * 720), ms: 650 }] : [];
  const voice = synthVoice({ sampleRate: DEMO_SR, seconds, syllablesPerSec: 4.6, contourHz: [175, 235, 165, 215, 185], pauses, seed: 42 });
  const eng = new ProsodyEngine({ sampleRate: DEMO_SR });
  const frames = [];
  for (let i = 0; i < voice.length; i += 1024) frames.push(...eng.push(voice.subarray(i, i + 1024)));
  const words = caption.split(/\s+/).filter(Boolean);
  const withCaption = frames.map((f, i) => {
    const shown = Math.min(words.length, Math.ceil(((i + 1) / frames.length) * words.length));
    return { ...f, caption: words.slice(Math.max(0, shown - 8), shown).join(" ") || null };
  });
  return { frames: withCaption, summary: eng.summary(), words: words.length };
}

export function createMirrorPlugin(opts: MirrorOptions = {}): HubPlugin {
  const takeMs = opts.demoTakeMs ?? 6000;
  const timers = new Set<NodeJS.Timeout>();
  const stats = { relayed: 0, dropped: 0, summaries: 0, focus: 0 };
  let demoN = 0;
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, Math.max(0, ms));
    timers.add(t);
  };
  const cancelDemo = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  async function demo(req: IncomingMessage, res: ServerResponse, ctx: PluginCtx) {
    if (!ctx.demo) return ctx.json(res, 400, { error: "demo_only", message: "POST /api/demo/mirror only runs in demo mode (npm run hub -- --demo)" });
    const b = await ctx.readJson(req);
    const script = b.script ?? "practice-take";
    if (script !== "practice-take" && script !== "focus") return ctx.json(res, 400, { error: "bad_request", message: 'script must be "practice-take" or "focus"' });
    if (b.room !== undefined && b.room !== null && typeof b.room !== "string") return ctx.json(res, 400, { error: "bad_request", message: "room must be a room code" });
    const room = typeof b.room === "string" ? b.room.toUpperCase() : null;
    const rooms = room ? (ctx.bridge.rooms.has(room) ? 1 : 0) : ctx.bridge.rooms.size;
    if (script === "focus") {
      if (!MIRROR_VIEWS.includes(b.view as MirrorView)) return ctx.json(res, 400, { error: "bad_request", message: `view must be one of ${MIRROR_VIEWS.join(", ")}` });
      ctx.publish("mirror.focus", { view: b.view as MirrorView, by: "demo", reason: "demo", recapId: null, takeId: null });
      stats.focus++;
      const r: DemoMirrorResponse = { replay: true, script, takeId: null, frames: 0, hz: PRACTICE_METERS_HZ, durationMs: 0, rooms };
      return ctx.json(res, 202, r);
    }
    cancelDemo();
    const takeId = `take_demo_${String(++demoN).padStart(2, "0")}`;
    const take = demoTake(takeMs);
    const startedAt = ctx.hub.clock();
    const period = 1000 / PRACTICE_METERS_HZ;
    ctx.publish("mirror.focus", { view: "practice", by: "demo-phone", reason: "practice take started", recapId: null, takeId });
    take.frames.forEach((f, i) =>
      later(i * period, () => {
        const frame: PracticeMeters = { takeId, ...f, at: startedAt + f.t, from: "demo-phone" };
        if (ctx.broadcastToScreens(room, "practice.meters", frame) > 0) stats.relayed++;
      }),
    );
    later(take.frames.length * period + 200, () => {
      const summary: PracticeSummary = { takeId, room: room ?? "*", from: "demo-phone", startedAt, endedAt: startedAt + take.summary.durationMs, words: take.words, provisional: true, ...take.summary };
      stats.summaries++;
      ctx.publish("practice.summary", { summary });
    });
    const r: DemoMirrorResponse = { replay: true, script, takeId, frames: take.frames.length, hz: PRACTICE_METERS_HZ, durationMs: take.frames.length * period, rooms };
    ctx.log("mirror.demo", { takeId, frames: take.frames.length, rooms });
    return ctx.json(res, 202, r);
  }

  return {
    name: "mirror",
    prefixes: MIRROR_PREFIXES,
    async route(req, res, url, ctx) {
      const method = req.method ?? "GET";
      if (MIRROR_ROUTES.some((r) => matchRoute(r, method, url.pathname))) return (await demo(req, res, ctx), true);
      return false;
    },
    onApp(room: Room, msg: AppMsg, from: PeerInfo, ctx: PluginCtx): IntentResult | undefined {
      switch (msg.topic) {
        case "practice.meters": {
          if (from.role !== "mic") return (stats.dropped++, null);
          const frame = sanitizeMeters(msg.payload, from.clientId);
          if (!frame) return (stats.dropped++, null);
          if (ctx.broadcastToScreens(room, "practice.meters", frame) > 0) stats.relayed++;
          else stats.dropped++;
          return null;
        }
        case "practice.summary": {
          if (from.role !== "mic") return { name: "practice.summary", ok: false, payload: { error: "mic_only", message: "only a paired phone mic sends a practice summary" } };
          const summary = sanitizeSummary(msg.payload, room.code, from.clientId);
          if (!summary) return { name: "practice.summary", ok: false, payload: { error: "bad_request", message: "malformed practice summary" } };
          const ev = ctx.publish("practice.summary", { summary });
          stats.summaries++;
          ctx.log("mirror.summary", { takeId: summary.takeId, room: room.code, frames: summary.frames });
          return { name: "practice.summary", ok: true, payload: { takeId: summary.takeId, seq: ev.payload.seq } };
        }
        case "mirror.focus": {
          const p = (msg.payload ?? {}) as Record<string, unknown>;
          if (!MIRROR_VIEWS.includes(p.view as MirrorView)) return { name: "mirror.focus", ok: false, payload: { error: "bad_request", message: `view must be one of ${MIRROR_VIEWS.join(", ")}` } };
          const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
          const id = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : null);
          ctx.publish("mirror.focus", { view: p.view as MirrorView, by: from.name ?? from.clientId, reason: str(p.reason, 120), recapId: id(p.recapId), takeId: id(p.takeId) });
          stats.focus++;
          return { name: "mirror.focus", ok: true, payload: { view: p.view } };
        }
        default:
          return undefined;
      }
    },
    describe: () => ({
      owner: "packet B",
      status: "ready",
      routes: MIRROR_ROUTES,
      topics: MIRROR_TOPICS,
      note: `meters relayed to the room's screens only (<= ${ROOM_RELAY_MAX_HZ} Hz); relayed ${stats.relayed}, dropped ${stats.dropped}, summaries ${stats.summaries}, focus ${stats.focus}`,
    }),
    stop: cancelDemo,
  };
}
