// Mic check: can Web Speech recognition and getUserMedia run at the same time on this phone?
// (iPhone Safari is the open question: practice mode wants the mic stream for the meters and
// speech recognition for the captions, both at once.)
//
// Each part starts from its own tap (Safari may require a user gesture to start recognition):
//   part 1  speech, then mic   (the order practice mode uses)
//   part 2  mic, then speech
// While both run for 6 s the check counts recognition results, mic blocks and the level span, and
// at the end it checks that the mic track is still live and unmuted. Nothing is sent anywhere.
import { startCapture, captureSupported, type Capture } from "./audio.js";
import { rmsDbfs } from "./dsp.js";
import { listen, speechCtor, type Listener } from "./speech.js";
import { judgePhase, type MicPhase, type MicVerdict } from "./take.js";

export const BOTH_MS = 6000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EnvReport {
  secure: boolean;
  getUserMedia: boolean;
  speech: boolean;
  why: string | null;
}

export function envReport(): EnvReport {
  const cap = captureSupported();
  const speech = !!speechCtor();
  return { secure: window.isSecureContext, getUserMedia: cap.ok, speech, why: cap.ok ? (speech ? null : "this browser has no Web Speech recognition") : cap.why };
}

// Run one part. `onTick` reports seconds left while both run.
export async function runPhase(order: MicPhase["order"], onTick: (msg: string) => void): Promise<MicPhase & MicVerdict> {
  const p: MicPhase = { order, speechStarted: false, speechResults: 0, speechError: null, micBlocks: 0, levelSpanDb: 0, peakDbfs: -100, trackLive: false };
  let both = false;
  const levels: number[] = [];
  let cap: Capture | null = null;
  let lis: Listener | null = null;
  const startSpeech = () => {
    try {
      lis = listen({
        onText: () => {
          p.speechStarted = true;
          if (both) p.speechResults++;
        },
        onError: (e) => (p.speechError = p.speechError ?? e),
        onStart: () => (p.speechStarted = true),
      });
      if (!lis) p.speechError = "no Web Speech recognition";
    } catch (err) {
      p.speechError = (err as Error).message || "start failed";
    }
  };
  const startMic = async () => {
    try {
      cap = await startCapture((b) => {
        if (!both) return;
        p.micBlocks++;
        levels.push(rmsDbfs(b));
      });
    } catch (err) {
      p.speechError = p.speechError ?? null;
      throw new Error(`getUserMedia failed: ${(err as Error).name || (err as Error).message}`);
    }
  };
  try {
    if (order === "speech-then-mic") {
      startSpeech();
      await sleep(600);
      await startMic();
    } else {
      await startMic();
      await sleep(600);
      startSpeech();
    }
    both = true;
    for (let s = BOTH_MS / 1000; s > 0; s--) {
      onTick(`Keep talking (count out loud)… ${s}`);
      await sleep(1000);
    }
    both = false;
    const c = cap as Capture | null;
    p.trackLive = !!c && c.track.readyState === "live" && !c.track.muted;
  } catch (err) {
    p.speechError = p.speechError ?? (err as Error).message;
  } finally {
    (lis as Listener | null)?.stop();
    (cap as Capture | null)?.stop();
  }
  if (levels.length) {
    p.peakDbfs = Math.max(...levels);
    p.levelSpanDb = p.peakDbfs - Math.min(...levels);
  }
  await sleep(400);
  return { ...p, ...judgePhase(p) };
}

export function reportText(env: EnvReport, parts: (MicPhase & MicVerdict)[]): string {
  const lines = [`Speaking Mirror mic check, ${new Date().toISOString()}`, `UA: ${navigator.userAgent}`, `secure ${env.secure} · getUserMedia ${env.getUserMedia} · speech ${env.speech}${env.why ? ` · ${env.why}` : ""}`];
  for (const p of parts) lines.push(`${p.order}: ${p.pass ? "PASS" : "FAIL"} · speech results ${p.speechResults}${p.speechError ? ` (error ${p.speechError})` : ""} · mic blocks ${p.micBlocks} · peak ${p.peakDbfs.toFixed(0)} dBFS · span ${p.levelSpanDb.toFixed(0)} dB · track ${p.trackLive ? "live" : "muted/ended"}${p.reasons.length ? ` · ${p.reasons.join("; ")}` : ""}`);
  return lines.join("\n");
}
