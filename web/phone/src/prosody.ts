// Prosody engine: turns a stream of mono samples into practice meter frames at 10 Hz and a take
// summary. Pure (no DOM, no Web Audio): the phone feeds it microphone blocks, the hub's demo
// take feeds it a synthetic voice, and the tests feed it sines and noise.
//
//   level   RMS dBFS over the frame; band quiet / ok / loud (thresholds from the coach template)
//   pitch   YIN, 70-400 Hz, on the newest window; null when the frame is unvoiced or too quiet
//   range   10th-90th percentile of the voiced pitch over the last 5 s, in semitones
//   rate    syllable peaks of the level envelope over the last 5 s, as words per minute
//   pauses  silent runs >= 250 ms between stretches of speech
import type { PracticeFlag, PracticeMeters, PracticeSummary, VolumeBand } from "../../../src/hub/contract.js";
import { DBFS_FLOOR, findPauses, percentile, pitchRangeSt, powerToDbfs, silenceThresholdDb, syllablePeaks, wpmFromSyllableRate, yin, yinWindow } from "./dsp.js";

export interface ProsodyOptions {
  sampleRate: number;
  hz?: number; // meter frames per second, 10
  hopMs?: number; // envelope resolution, 10
  windowMs?: number; // rolling window for range, rate and the silence threshold, 5000
  quietDbfs?: number; // -35
  loudDbfs?: number; // -12
  minHz?: number; // 70
  maxHz?: number; // 400
  monotoneSemitones?: number; // 3
  minPauseMs?: number; // 250
  wpmSlow?: number; // 110
  wpmFast?: number; // 175
  voicedGateDbfs?: number; // frames quieter than this are never voiced, -50
}

// A meter frame before the caller adds takeId, at and caption.
export type MeterCore = Omit<PracticeMeters, "takeId" | "at" | "caption" | "from">;
// A summary before the caller adds takeId, room, from, the clock fields and words.
export type SummaryCore = Omit<PracticeSummary, "takeId" | "room" | "from" | "startedAt" | "endedAt" | "words" | "provisional">;

const round1 = (n: number) => Math.round(n * 10) / 10;

export class ProsodyEngine {
  readonly o: Required<ProsodyOptions>;
  private readonly hopSamples: number;
  private readonly hopsPerFrame: number;
  private readonly ring: Float32Array; // newest samples for YIN
  private ringPos = 0;
  private ringFill = 0;
  private hopSum = 0;
  private hopN = 0;
  private frameSum = 0;
  private frameN = 0;
  private hopsInFrame = 0;
  private frameNo = 0;
  readonly levels: number[] = []; // dBFS per hop, whole take
  private readonly pitchTrack: { frame: number; hz: number }[] = [];
  readonly frames: MeterCore[] = [];
  // live pause state
  private spoke = false;
  private silentHops = 0;
  private pauseCounted = false;
  private pauseCount = 0;

  constructor(opts: ProsodyOptions) {
    this.o = {
      hz: 10,
      hopMs: 10,
      windowMs: 5000,
      quietDbfs: -35,
      loudDbfs: -12,
      minHz: 70,
      maxHz: 400,
      monotoneSemitones: 3,
      minPauseMs: 250,
      wpmSlow: 110,
      wpmFast: 175,
      voicedGateDbfs: -50,
      ...opts,
    };
    this.hopSamples = Math.max(1, Math.round((this.o.sampleRate * this.o.hopMs) / 1000));
    this.hopsPerFrame = Math.max(1, Math.round(1000 / this.o.hz / this.o.hopMs));
    this.ring = new Float32Array(yinWindow(this.o.sampleRate, this.o.minHz));
  }

  get frameMs(): number {
    return this.hopsPerFrame * this.o.hopMs;
  }

  // Feed samples; returns the meter frames completed by this block (usually 0 or 1).
  push(block: ArrayLike<number>): MeterCore[] {
    const out: MeterCore[] = [];
    for (let i = 0; i < block.length; i++) {
      const v = block[i]!;
      this.ring[this.ringPos] = v;
      this.ringPos = (this.ringPos + 1) % this.ring.length;
      if (this.ringFill < this.ring.length) this.ringFill++;
      this.hopSum += v * v;
      this.hopN++;
      if (this.hopN === this.hopSamples) {
        this.endHop();
        if (this.hopsInFrame === this.hopsPerFrame) out.push(this.endFrame());
      }
    }
    return out;
  }

  private endHop() {
    const db = powerToDbfs(this.hopSum / this.hopN);
    this.levels.push(db);
    this.frameSum += this.hopSum;
    this.frameN += this.hopN;
    this.hopSum = 0;
    this.hopN = 0;
    this.hopsInFrame++;
    const thr = silenceThresholdDb(this.recentLevels());
    if (db < thr) {
      if (this.spoke) {
        this.silentHops++;
        if (!this.pauseCounted && this.silentHops * this.o.hopMs >= this.o.minPauseMs) {
          this.pauseCounted = true;
          this.pauseCount++;
        }
      }
    } else {
      this.spoke = true;
      this.silentHops = 0;
      this.pauseCounted = false;
    }
  }

  private recentLevels(): number[] {
    const n = Math.round(this.o.windowMs / this.o.hopMs);
    return this.levels.length <= n ? this.levels : this.levels.slice(-n);
  }

  private newestWindow(): Float32Array {
    const n = this.ringFill;
    const w = new Float32Array(n);
    const start = (this.ringPos - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) w[i] = this.ring[(start + i) % this.ring.length]!;
    return w;
  }

  private endFrame(): MeterCore {
    const frame = this.frameNo++;
    const rms = round1(powerToDbfs(this.frameSum / Math.max(1, this.frameN)));
    this.frameSum = 0;
    this.frameN = 0;
    this.hopsInFrame = 0;
    const recent = this.recentLevels();
    const thr = silenceThresholdDb(recent);
    let pitchHz: number | null = null;
    if (rms >= this.o.voicedGateDbfs && rms >= thr && this.ringFill === this.ring.length) {
      pitchHz = yin(this.newestWindow(), this.o.sampleRate, { minHz: this.o.minHz, maxHz: this.o.maxHz }).hz;
    }
    if (pitchHz !== null) this.pitchTrack.push({ frame, hz: pitchHz });
    const windowFrames = Math.round(this.o.windowMs / this.frameMs);
    const voicedRecent = this.pitchTrack.filter((p) => p.frame > frame - windowFrames).map((p) => p.hz);
    const range = round1(pitchRangeSt(voicedRecent));
    const speechHops = recent.filter((l) => l >= thr).length;
    const enough = this.levels.length * this.o.hopMs >= 2000;
    const sps = enough && speechHops > 0 ? syllablePeaks(recent, { hopMs: this.o.hopMs, floorDb: thr }).length / ((recent.length * this.o.hopMs) / 1000) : null;
    const m: MeterCore = {
      frame,
      t: (frame + 1) * this.frameMs,
      rmsDbfs: rms,
      band: this.band(rms),
      voiced: pitchHz !== null,
      pitchHz: pitchHz === null ? null : round1(pitchHz),
      pitchRangeSt: range,
      monotone: voicedRecent.length >= 10 && range < this.o.monotoneSemitones,
      wpm: sps === null ? null : Math.round(wpmFromSyllableRate(sps)),
      pause: { active: this.spoke && this.silentHops * this.o.hopMs >= this.o.minPauseMs, currentMs: this.spoke ? this.silentHops * this.o.hopMs : 0, count: this.pauseCount },
    };
    this.frames.push(m);
    return m;
  }

  band(db: number): VolumeBand {
    return db < this.o.quietDbfs ? "quiet" : db > this.o.loudDbfs ? "loud" : "ok";
  }

  // The take so far. Volume statistics use speech frames only (silence would drag them down).
  summary(): SummaryCore {
    const hopMs = this.o.hopMs;
    const durationMs = this.levels.length * hopMs;
    const thr = silenceThresholdDb(this.levels);
    const speech = this.frames.filter((f) => f.rmsDbfs >= thr && f.rmsDbfs > DBFS_FLOOR);
    const vol = speech.map((f) => f.rmsDbfs).sort((a, b) => a - b);
    const mean = vol.length ? powerToDbfs(vol.reduce((s, d) => s + 10 ** (d / 10), 0) / vol.length) : DBFS_FLOOR;
    const quietShare = vol.length ? vol.filter((d) => d < this.o.quietDbfs).length / vol.length : 0;
    const loudShare = vol.length ? vol.filter((d) => d > this.o.loudDbfs).length / vol.length : 0;
    const hz = this.pitchTrack.map((p) => p.hz).sort((a, b) => a - b);
    const rangeSt = round1(pitchRangeSt(hz));
    const voicedShare = speech.length ? this.pitchTrack.length / speech.length : 0;
    const peaks = syllablePeaks(this.levels, { hopMs, floorDb: thr });
    const wpm = durationMs >= 2000 && speech.length ? Math.round(wpmFromSyllableRate(peaks.length / (durationMs / 1000))) : null;
    const pauses = findPauses(this.levels, hopMs, thr, this.o.minPauseMs);
    const minutes = durationMs / 60000;
    const flags: PracticeFlag[] = [];
    if (vol.length && quietShare > 0.5) flags.push("quiet");
    if (vol.length && loudShare > 0.3) flags.push("loud");
    const monotone = hz.length >= 10 && rangeSt < this.o.monotoneSemitones;
    if (monotone) flags.push("monotone");
    if (wpm !== null && wpm > this.o.wpmFast) flags.push("fast");
    if (wpm !== null && wpm < this.o.wpmSlow) flags.push("slow");
    if (durationMs >= 20000 && pauses.length / minutes < 4) flags.push("few-pauses");
    return {
      durationMs,
      frames: this.frames.length,
      volume: { meanDbfs: round1(mean), p10Dbfs: round1(vol.length ? percentile(vol, 0.1) : DBFS_FLOOR), p90Dbfs: round1(vol.length ? percentile(vol, 0.9) : DBFS_FLOOR), quietShare: Math.round(quietShare * 100) / 100, loudShare: Math.round(loudShare * 100) / 100 },
      pitch: { medianHz: hz.length ? Math.round(percentile(hz, 0.5)) : null, rangeSt, voicedShare: Math.round(Math.min(1, voicedShare) * 100) / 100, monotone },
      rate: { wpm },
      pauses: {
        count: pauses.length,
        perMin: minutes > 0 ? Math.round((pauses.length / minutes) * 10) / 10 : 0,
        meanMs: pauses.length ? Math.round(pauses.reduce((s, p) => s + p.ms, 0) / pauses.length) : 0,
        longestMs: pauses.reduce((m, p) => Math.max(m, p.ms), 0),
      },
      flags,
    };
  }
}

// A deterministic synthetic voice for demos and tests: a harmonic tone whose pitch glides through
// `contourHz`, gated into syllables at `syllablesPerSec`, with silent pauses at the given times.
export interface SynthVoiceOptions {
  sampleRate: number;
  seconds: number;
  syllablesPerSec?: number; // 4.5
  contourHz?: number[]; // pitch targets spread across the take, [180, 230, 170, 210]
  pauses?: { atMs: number; ms: number }[];
  amplitude?: number; // peak of the syllable envelope, 0.3
  seed?: number;
}
export function synthVoice(o: SynthVoiceOptions): Float32Array {
  const sr = o.sampleRate;
  const n = Math.round(o.seconds * sr);
  const out = new Float32Array(n);
  const sps = o.syllablesPerSec ?? 4.5;
  const contour = o.contourHz ?? [180, 230, 170, 210];
  const amp = o.amplitude ?? 0.3;
  let seed = o.seed ?? 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ms = t * 1000;
    if ((o.pauses ?? []).some((p) => ms >= p.atMs && ms < p.atMs + p.ms)) {
      out[i] = rand() * 0.0005;
      continue;
    }
    const pos = (t / o.seconds) * (contour.length - 1);
    const k = Math.min(contour.length - 2, Math.floor(pos));
    const f0 = contour[k]! + (contour[k + 1]! - contour[k]!) * (pos - k);
    phase += (2 * Math.PI * f0) / sr;
    const syl = Math.max(0, Math.sin(Math.PI * ((t * sps) % 1))) ** 2;
    const voice = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
    out[i] = amp * syl * (voice / 1.75) + rand() * 0.0005;
  }
  return out;
}
