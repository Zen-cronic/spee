// Pure helpers for the phone page: the join URL, practice-take frames and the take summary in the
// contract's shapes (src/hub/contract.ts). No DOM, so test/phone-take.test.ts can run them against
// the hub's own sanitizer.
import type { PracticeMeters, PracticeSummary } from "../../../src/hub/contract.js";
import type { MeterCore, SummaryCore } from "./prosody.js";

export interface Join {
  code: string | null; // 4-character room code from /p/<code>
  k: string | null; // the pair token from ?k=, needed through a tunnel (kept in memory only)
  debug: boolean;
}

// /p/HJ3H?k=abc -> { code: "HJ3H", k: "abc" }
export function parseJoin(pathname: string, search: string): Join {
  const m = /\/p\/([A-Za-z0-9]{4})(?:\/|$)/.exec(pathname);
  const q = new URLSearchParams(search);
  const k = q.get("k");
  return { code: m ? m[1]!.toUpperCase() : null, k: k && k.trim() ? k.trim() : null, debug: q.has("debug") };
}

// The bridge URL for this page: same host, wss on https, ?k= when the page has it.
export function wsUrl(protocol: string, host: string, k: string | null): string {
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws${k ? `?k=${encodeURIComponent(k)}` : ""}`;
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
