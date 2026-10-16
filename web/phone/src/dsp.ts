// Pure signal processing for practice meters: RMS level in dBFS, YIN pitch, the syllable-rate
// envelope counter and pause segmentation. No DOM and no Web Audio, so the same code runs on the
// phone (web/phone/src/prosody.ts), in the hub's synthetic demo take (src/hub/mirror.ts) and in
// the unit tests (test/phone-dsp.test.ts).

export const DBFS_FLOOR = -100;

// RMS of x[start, end) in dBFS (a full-scale sine is -3.01 dBFS), floored at DBFS_FLOOR.
export function rmsDbfs(x: ArrayLike<number>, start = 0, end = x.length): number {
  const n = end - start;
  if (n <= 0) return DBFS_FLOOR;
  let s = 0;
  for (let i = start; i < end; i++) s += x[i]! * x[i]!;
  return powerToDbfs(s / n);
}

// Mean square power to dBFS.
export function powerToDbfs(meanSquare: number): number {
  if (!(meanSquare > 0)) return DBFS_FLOOR;
  return Math.max(DBFS_FLOOR, 10 * Math.log10(meanSquare));
}

export interface YinOptions {
  minHz?: number; // 70
  maxHz?: number; // 400
  threshold?: number; // cumulative mean normalized difference threshold, 0.15
  maxAperiodicity?: number; // above this the frame is unvoiced, 0.35
}
export interface YinResult {
  hz: number | null;
  aperiodicity: number; // the CMND value at the chosen lag (0 = perfectly periodic)
}

// The number of samples YIN needs for a given rate and floor (two periods of minHz).
export const yinWindow = (sampleRate: number, minHz = 70): number => 2 * Math.ceil(sampleRate / minHz) + 2;

// YIN (de Cheveigne and Kawahara 2002): difference function, cumulative mean normalization,
// absolute threshold, then parabolic interpolation around the chosen lag.
export function yin(x: ArrayLike<number>, sampleRate: number, o: YinOptions = {}): YinResult {
  const minHz = o.minHz ?? 70;
  const maxHz = o.maxHz ?? 400;
  const th = o.threshold ?? 0.15;
  const maxAp = o.maxAperiodicity ?? 0.35;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.ceil(sampleRate / minHz), Math.floor(x.length / 2) - 1);
  if (tauMax <= tauMin + 2) return { hz: null, aperiodicity: 1 };
  const w = x.length - tauMax - 1;
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = x[j]! - x[j + tau]!;
      s += v * v;
    }
    d[tau] = s;
  }
  const cmnd = new Float64Array(tauMax + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau]!;
    cmnd[tau] = running > 0 ? (d[tau]! * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau]! < th) {
      while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    best = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) if (cmnd[tau]! < cmnd[best]!) best = tau;
  }
  const ap = cmnd[best]!;
  if (ap > maxAp) return { hz: null, aperiodicity: ap };
  let refined = best;
  if (best > 1 && best < tauMax + 1) {
    const a = cmnd[best - 1]!;
    const b = cmnd[best]!;
    const c = cmnd[best + 1]!;
    const den = a - 2 * b + c;
    if (den !== 0) refined = best + (0.5 * (a - c)) / den;
  }
  const hz = sampleRate / refined;
  if (hz < minHz * 0.97 || hz > maxHz * 1.03) return { hz: null, aperiodicity: ap };
  return { hz, aperiodicity: ap };
}

export const semitones = (hz: number, refHz: number): number => 12 * Math.log2(hz / refHz);

// The p-th percentile (0..1) of an ascending array, linear interpolation.
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

// Pitch range in semitones from the 10th to the 90th percentile (robust to one-off octave
// errors). Fewer than 3 voiced samples: 0.
export function pitchRangeSt(hzs: readonly number[]): number {
  if (hzs.length < 3) return 0;
  const s = [...hzs].sort((a, b) => a - b);
  return Math.max(0, semitones(percentile(s, 0.9), percentile(s, 0.1)));
}

// Moving average of width `k` (odd), edges use the available neighbours.
export function smooth(x: readonly number[], k = 5): number[] {
  const h = Math.floor(k / 2);
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(x.length - 1, i + h); j++) (s += x[j]!), n++;
    out[i] = s / n;
  }
  return out;
}

export interface PeakOptions {
  hopMs: number; // spacing of the envelope samples
  minDistanceMs?: number; // 100 (at most 10 syllables per second)
  minProminenceDb?: number; // 3: the dip on both sides of a peak
  floorDb?: number; // peaks below this level are ignored (silence)
  smoothHops?: number; // moving average width, 5 (50 ms at 10 ms hops)
}

// Syllable nuclei as peaks of the level envelope (in dB, one value per hop) that rise at least
// minProminenceDb above the lowest point on each side before a higher peak. Returns peak indexes.
export function syllablePeaks(levelsDb: readonly number[], o: PeakOptions): number[] {
  const env = smooth(levelsDb, o.smoothHops ?? 5);
  const prom = o.minProminenceDb ?? 3;
  const floor = o.floorDb ?? -60;
  const minDist = Math.max(1, Math.round((o.minDistanceMs ?? 100) / o.hopMs));
  const cand: number[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i]! < floor) continue;
    if (env[i]! > env[i - 1]! && env[i]! >= env[i + 1]!) {
      let left = env[i]!;
      for (let j = i - 1; j >= 0 && env[j]! <= env[i]!; j--) left = Math.min(left, env[j]!);
      let right = env[i]!;
      for (let j = i + 1; j < env.length && env[j]! <= env[i]!; j++) right = Math.min(right, env[j]!);
      if (env[i]! - Math.max(left, right) >= prom) cand.push(i);
    }
  }
  const out: number[] = [];
  for (const i of cand) {
    const last = out[out.length - 1];
    if (last !== undefined && i - last < minDist) {
      if (env[i]! > env[last]!) out[out.length - 1] = i;
    } else out.push(i);
  }
  return out;
}

// Syllables per second over the whole envelope.
export function syllablesPerSec(levelsDb: readonly number[], o: PeakOptions): number {
  const secs = (levelsDb.length * o.hopMs) / 1000;
  return secs > 0 ? syllablePeaks(levelsDb, o).length / secs : 0;
}

// Words per minute from a syllable rate (English averages about 1.5 syllables per word).
export const SYLLABLES_PER_WORD = 1.5;
export const wpmFromSyllableRate = (sps: number, perWord = SYLLABLES_PER_WORD): number => (sps * 60) / perWord;

// The silence threshold for a stretch of hop levels: 25 dB under the loud end of the speech
// (90th percentile), never below -60 dBFS.
export function silenceThresholdDb(levelsDb: readonly number[], dropDb = 25, floorDb = -60): number {
  if (levelsDb.length === 0) return floorDb;
  const s = [...levelsDb].sort((a, b) => a - b);
  return Math.max(floorDb, percentile(s, 0.9) - dropDb);
}

export interface Pause {
  start: number; // hop index of the first silent hop
  hops: number;
  ms: number;
}

// Pauses: silent runs of at least minMs between two stretches of speech (leading and trailing
// silence are not pauses).
export function findPauses(levelsDb: readonly number[], hopMs: number, thresholdDb: number, minMs = 250): Pause[] {
  const out: Pause[] = [];
  let spoke = false;
  let runStart = -1;
  for (let i = 0; i < levelsDb.length; i++) {
    const silent = levelsDb[i]! < thresholdDb;
    if (silent) {
      if (spoke && runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const hops = i - runStart;
        if (hops * hopMs >= minMs) out.push({ start: runStart, hops, ms: hops * hopMs });
        runStart = -1;
      }
      spoke = true;
    }
  }
  return out;
}
