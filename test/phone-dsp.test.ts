// Practice-mode DSP (web/phone/src/dsp.ts, prosody.ts) on synthetic signals: YIN pitch on pure and
// harmonic tones, RMS level, the syllable-rate counter on amplitude-modulated noise, pause
// detection, the semitone range and the 10 Hz meter engine end to end.
import { describe, expect, it } from "vitest";
import { findPauses, pitchRangeSt, rmsDbfs, semitones, silenceThresholdDb, syllablesPerSec, wpmFromSyllableRate, yin } from "../web/phone/src/dsp.js";
import { ProsodyEngine, synthVoice } from "../web/phone/src/prosody.js";

const SR = 16000;
const sine = (hz: number, secs: number, amp = 0.5, sr = SR) => Float32Array.from({ length: Math.round(secs * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
// Per-hop dBFS levels of a signal (10 ms hops).
const hopLevels = (x: Float32Array, sr = SR, hopMs = 10) => {
  const h = Math.round((sr * hopMs) / 1000);
  const out: number[] = [];
  for (let i = 0; i + h <= x.length; i += h) out.push(rmsDbfs(x, i, i + h));
  return out;
};

describe("YIN pitch (70-400 Hz)", () => {
  for (const hz of [110, 220, 330]) {
    it(`a ${hz} Hz sine reads within 2%`, () => {
      for (const sr of [16000, 44100, 48000]) {
        const r = yin(sine(hz, 0.06, 0.5, sr), sr);
        expect(r.hz).not.toBeNull();
        expect(Math.abs(r.hz! - hz) / hz).toBeLessThan(0.02);
      }
    });
  }
  it("a harmonic tone reads its fundamental, not a harmonic", () => {
    const x = Float32Array.from({ length: 1600 }, (_, i) => Math.sin((2 * Math.PI * 150 * i) / SR) + 0.8 * Math.sin((2 * Math.PI * 300 * i) / SR) + 0.6 * Math.sin((2 * Math.PI * 450 * i) / SR));
    expect(Math.abs(yin(x, SR).hz! - 150) / 150).toBeLessThan(0.02);
  });
  it("white noise is unvoiced", () => {
    const r = lcg(3);
    expect(yin(Float32Array.from({ length: 1600 }, () => r() * 0.5), SR).hz).toBeNull();
  });
});

describe("RMS level", () => {
  it("a 0.5-amplitude sine is about -9 dBFS", () => {
    expect(rmsDbfs(sine(220, 0.5))).toBeCloseTo(-9.03, 1);
  });
  it("full scale is about -3 dBFS and silence is the floor", () => {
    expect(rmsDbfs(sine(220, 0.5, 1))).toBeCloseTo(-3.01, 1);
    expect(rmsDbfs(new Float32Array(1000))).toBe(-100);
  });
});

describe("syllable rate", () => {
  it("4 Hz amplitude-modulated noise reads about 4 syllables per second", () => {
    const r = lcg(11);
    const x = Float32Array.from({ length: 5 * SR }, (_, i) => r() * 0.3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * (i / SR))));
    const sps = syllablesPerSec(hopLevels(x), { hopMs: 10 });
    expect(sps).toBeGreaterThan(3.6);
    expect(sps).toBeLessThan(4.4);
    expect(wpmFromSyllableRate(4)).toBe(160);
  });
  it("6 Hz modulation reads about 6, and steady noise reads near 0", () => {
    const r = lcg(5);
    const x6 = Float32Array.from({ length: 5 * SR }, (_, i) => r() * 0.3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 6 * (i / SR))));
    expect(syllablesPerSec(hopLevels(x6), { hopMs: 10 })).toBeGreaterThan(5.4);
    expect(syllablesPerSec(hopLevels(x6), { hopMs: 10 })).toBeLessThan(6.6);
    const steady = Float32Array.from({ length: 5 * SR }, () => r() * 0.3);
    expect(syllablesPerSec(hopLevels(steady), { hopMs: 10 })).toBeLessThan(0.5);
  });
});

describe("pauses (>= 250 ms between speech)", () => {
  it("finds the 300 ms and 600 ms gaps, ignores the 100 ms gap and the leading/trailing silence", () => {
    const parts: [boolean, number][] = [[false, 0.4], [true, 0.5], [false, 0.3], [true, 0.5], [false, 0.1], [true, 0.5], [false, 0.6], [true, 0.5], [false, 0.5]];
    const chunks = parts.map(([on, s]) => (on ? sine(200, s) : new Float32Array(Math.round(s * SR))));
    const x = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) (x.set(c, o), (o += c.length));
    const lv = hopLevels(x);
    const p = findPauses(lv, 10, silenceThresholdDb(lv));
    expect(p.map((q) => q.ms)).toEqual([300, 600]);
  });
});

describe("pitch range and monotone", () => {
  it("measures the 10th-90th percentile range in semitones", () => {
    expect(semitones(220, 110)).toBeCloseTo(12, 6);
    expect(pitchRangeSt([200, 200, 201, 199, 200])).toBeLessThan(0.3);
    const glide = Array.from({ length: 50 }, (_, i) => 150 * 2 ** (i / 49));
    expect(pitchRangeSt(glide)).toBeGreaterThan(9);
    expect(pitchRangeSt([200])).toBe(0);
  });
});

describe("ProsodyEngine: 10 Hz meter frames and a take summary", () => {
  it("meters a synthetic voice: level band, pitch in range, a varied melody, a plausible rate and the pauses", () => {
    const voice = synthVoice({ sampleRate: SR, seconds: 8, syllablesPerSec: 4.5, contourHz: [170, 240, 160, 220], pauses: [{ atMs: 2500, ms: 500 }, { atMs: 5500, ms: 700 }] });
    const eng = new ProsodyEngine({ sampleRate: SR });
    const frames = [];
    for (let i = 0; i < voice.length; i += 1024) frames.push(...eng.push(voice.subarray(i, i + 1024)));
    expect(frames).toHaveLength(80);
    expect(frames.map((f) => f.frame)).toEqual(Array.from({ length: 80 }, (_, i) => i));
    expect(frames[9]!.t).toBe(1000);
    const voiced = frames.filter((f) => f.voiced);
    expect(voiced.length).toBeGreaterThan(20);
    for (const f of voiced) expect(f.pitchHz!).toBeGreaterThanOrEqual(150), expect(f.pitchHz!).toBeLessThanOrEqual(250);
    expect(frames.at(-1)!.pause.count).toBe(2);
    expect(frames.at(-1)!.monotone).toBe(false);
    const s = eng.summary();
    expect(s.frames).toBe(80);
    expect(s.durationMs).toBe(8000);
    expect(s.pauses.count).toBe(2);
    expect(s.pauses.longestMs).toBeGreaterThanOrEqual(650);
    expect(s.pitch.rangeSt).toBeGreaterThan(3);
    expect(s.pitch.monotone).toBe(false);
    expect(s.rate.wpm).toBeGreaterThan(120);
    expect(s.rate.wpm).toBeLessThan(200);
    expect(s.flags).not.toContain("monotone");
  });
  it("flags a flat pitch as monotone and a soft voice as quiet", () => {
    const flat = synthVoice({ sampleRate: SR, seconds: 6, contourHz: [200, 202], amplitude: 0.02 });
    const eng = new ProsodyEngine({ sampleRate: SR });
    for (let i = 0; i < flat.length; i += 800) eng.push(flat.subarray(i, i + 800));
    const s = eng.summary();
    expect(s.pitch.monotone).toBe(true);
    expect(s.flags).toEqual(expect.arrayContaining(["monotone", "quiet"]));
    expect(eng.frames.at(-1)!.monotone).toBe(true);
    expect(eng.frames.at(-1)!.band).toBe("quiet");
  });
});
