// Pure helpers for the phone page: the join URL, practice-take frames and the take summary in the
// contract's shapes (src/hub/contract.ts). No DOM, so test/phone-take.test.ts can run them against
// the hub's own sanitizer.
import { WS_PROTOCOL, WS_TOKEN_PREFIX, type CardView, type GradeResult, type PracticeMeters, type PracticeSummary, type SessionSummary } from "../../../src/hub/contract.js";
import { gradeFailure, plainReason } from "../../../tv/web/src/mirror/format.js";
import type { MeterCore, SummaryCore } from "./prosody.js";

export interface Join {
  code: string | null; // 4-character room code from /p/<code>
  k: string | null; // the pair token from #k= (or the older ?k=), needed through a tunnel (kept in memory only)
  debug: boolean;
}

// /p/HJ3H#k=abc -> { code: "HJ3H", k: "abc" }. The token rides in the fragment, which the browser
// never sends to a server (so it stays out of tunnel logs); ?k= from an older QR code still works.
export function parseJoin(pathname: string, search: string, hash = ""): Join {
  const m = /\/p\/([A-Za-z0-9]{4})(?:\/|$)/.exec(pathname);
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  const k = h.get("k") ?? q.get("k");
  return { code: m ? m[1]!.toUpperCase() : null, k: k && k.trim() ? k.trim() : null, debug: q.has("debug") };
}

// The bridge URL for this page: same host, wss on https. The pair token is not in it: it rides in
// the WebSocket subprotocols (wsProtocols), which proxy and tunnel access logs do not record.
export function wsUrl(protocol: string, host: string): string {
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}

// The subprotocols that carry the pair token: [WS_PROTOCOL, "k.<base64url(token)>"] (base64url keeps
// any token inside the characters a subprotocol allows). None without a token.
export function wsProtocols(k: string | null): string[] | undefined {
  if (!k) return undefined;
  return [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${base64url(k)}`];
}

// The header that carries the pair token on the Progress tab's reads (GET /api/stats, /api/transfer,
// /api/recaps; src/hub/gate.ts PAIR_HEADER), base64url like the subprotocol. Never in the URL. None
// without a token: a trusted LAN phone (the hub runs with --lan) reads without one.
export const PAIR_HEADER = "x-pair-token";
export function pairHeaders(k: string | null | undefined): Record<string, string> {
  return k ? { [PAIR_HEADER]: base64url(k) } : {};
}

function base64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newTakeId = (now: number, rand = Math.random): string => `take_${now.toString(36)}${Math.floor(rand() * 1296).toString(36).padStart(2, "0")}`;

// Interim words for the caption: the last `maxWords` words, or null.
export function captionOf(text: string | null | undefined, maxWords = 10): string | null {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(-maxWords).join(" ") : null;
}

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export function meterFrame(core: MeterCore, takeId: string, at: number, caption: string | null): PracticeMeters {
  return { takeId, ...core, at: Math.round(at), caption };
}

export function takeSummary(core: SummaryCore, o: { takeId: string; room: string; from: string; startedAt: number; endedAt: number; words: number | null }): PracticeSummary {
  return { takeId: o.takeId, room: o.room, from: o.from, startedAt: Math.round(o.startedAt), endedAt: Math.round(o.endedAt), words: o.words, provisional: true, ...core };
}

// Mic check verdict for one order of starting speech recognition and the mic stream.
export interface MicPhase {
  order: "mic-then-speech" | "speech-then-mic";
  speechStarted: boolean;
  speechResults: number; // interim + final results while both ran
  speechError: string | null;
  micBlocks: number; // audio blocks received while both ran
  levelSpanDb: number; // loudest minus quietest 100 ms level while both ran
  peakDbfs: number;
  trackLive: boolean; // the mic track was still live and unmuted at the end
}
export interface MicVerdict {
  pass: boolean;
  reasons: string[]; // why it failed (empty on a pass)
}

export function judgePhase(p: MicPhase): MicVerdict {
  const reasons: string[] = [];
  if (!p.speechStarted) reasons.push(`speech recognition did not start${p.speechError ? ` (${p.speechError})` : ""}`);
  else if (p.speechResults === 0) reasons.push(`speech recognition heard nothing while the mic stream ran${p.speechError ? ` (${p.speechError})` : ""}`);
  if (p.micBlocks === 0) reasons.push("the mic stream delivered no audio while speech recognition ran");
  else if (p.levelSpanDb < 6 || p.peakDbfs < -55) reasons.push(`the mic stream went flat while speech recognition ran (peak ${p.peakDbfs.toFixed(0)} dBFS, span ${p.levelSpanDb.toFixed(0)} dB)`);
  if (!p.trackLive) reasons.push("the mic track was muted or ended by the time the check finished");
  return { pass: reasons.length === 0, reasons };
}

// The line the phone shows when a drill session ends (the TV's wording).
export function sessionOverLine(s: Partial<SessionSummary> | null | undefined): string {
  if (!s) return "Session over.";
  return `Session over: ${s.passed ?? 0} passed, ${s.failed ?? 0} failed, ${s.unverified ?? 0} unverified${s.pending ? `, ${s.pending} still with Bee` : ""}${s.beeOverrules ? `, Bee overruled ${s.beeOverrules}` : ""}.`;
}

// The dictation language for a drill card: French cards in French, everything else in US English.
export const speechLang = (card: Pick<CardView, "lang"> | null | undefined): string => (card?.lang === "fr" ? "fr-FR" : "en-US");

/**
 * The grader's first failed rule in the TV's own words (tv/web/src/mirror/format.ts, as Alexa says
 * it), from the grade's structured fields: the words really missing, never the ASR slips Bee
 * accepted, and a habit's word once, not the quotes in its label. Null on a pass or with no grade.
 */
export function failLine(g: Partial<GradeResult> | null | undefined): string | null {
  return plainReason(gradeFailure(g));
}
