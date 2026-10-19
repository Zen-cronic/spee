// Phone page helpers (web/phone/src/take.ts): the join URL, and frames and summaries built from
// the real prosody engine that the hub's own sanitizer (src/hub/mirror.ts) accepts unchanged.
import { describe, expect, it } from "vitest";
import { sanitizeMeters, sanitizeSummary } from "../src/hub/mirror.js";
import { ProsodyEngine, synthVoice } from "../web/phone/src/prosody.js";
import { captionOf, countWords, judgePhase, meterFrame, newTakeId, parseJoin, sessionOverLine, speechLang, takeSummary, wsUrl, type MicPhase } from "../web/phone/src/take.js";

describe("join URL", () => {
  it("reads the room code and the pair token from /p/<code>?k=...", () => {
    expect(parseJoin("/p/hj3h", "?k=abc123")).toEqual({ code: "HJ3H", k: "abc123", debug: false });
    expect(parseJoin("/p/hj3h", "", "#k=frag456")).toEqual({ code: "HJ3H", k: "frag456", debug: false }); // the fragment form (review M13)
    expect(parseJoin("/p/hj3h", "?k=old", "#k=new")).toMatchObject({ k: "new" });
    expect(parseJoin("/p/HJ3H/", "?debug=1")).toEqual({ code: "HJ3H", k: null, debug: true });
    expect(parseJoin("/p/", "")).toEqual({ code: null, k: null, debug: false });
    expect(parseJoin("/p/TOOLONG", "").code).toBeNull();
  });
  it("connects wss on https with ?k=, ws on the LAN without it", () => {
    expect(wsUrl("https:", "abc.ngrok.app", "t o k")).toBe("wss://abc.ngrok.app/ws?k=t%20o%20k");
    expect(wsUrl("http:", "192.168.1.20:8791", null)).toBe("ws://192.168.1.20:8791/ws");
  });
});

describe("practice frames and the take summary", () => {
  const sr = 48000;
  const eng = new ProsodyEngine({ sampleRate: sr });
  const voice = synthVoice({ sampleRate: sr, seconds: 4, pauses: [{ atMs: 2000, ms: 400 }] });
  const cores: ReturnType<ProsodyEngine["push"]> = [];
  for (let i = 0; i < voice.length; i += 128) cores.push(...eng.push(voice.subarray(i, i + 128))); // AudioWorklet-sized blocks
  it("emits one frame per 100 ms of audio whatever the block size", () => {
    expect(cores).toHaveLength(40);
  });
  it("every frame passes the hub's sanitizer unchanged (plus from)", () => {
    const takeId = newTakeId(1792518000000, () => 0.5);
    expect(takeId).toMatch(/^take_[a-z0-9]+$/);
    for (const c of cores) {
      const f = meterFrame(c, takeId, 1792518000000 + c.t, captionOf("so the export is ready for review on friday"));
      expect(sanitizeMeters(f, "phone-1")).toEqual({ ...f, from: "phone-1" });
    }
  });
  it("the summary passes the hub's sanitizer, which stamps room and from", () => {
    const s = takeSummary(eng.summary(), { takeId: "take_x1", room: "HJ3H", from: "phone-1", startedAt: 1792518000000, endedAt: 1792518004000, words: countWords("one two three") });
    expect(sanitizeSummary(s, "HJ3H", "phone-1")).toEqual(s);
    expect(sanitizeSummary(s, "ZZZZ", "phone-9")).toMatchObject({ room: "ZZZZ", from: "phone-9", provisional: true });
    expect(s.words).toBe(3);
  });
  it("captions keep the last words only", () => {
    expect(captionOf("a b c d e f g h i j k l", 10)).toBe("c d e f g h i j k l");
    expect(captionOf("  ")).toBeNull();
    expect(captionOf(null)).toBeNull();
  });
});

describe("mic check verdict", () => {
  const ok: MicPhase = { order: "speech-then-mic", speechStarted: true, speechResults: 4, speechError: null, micBlocks: 280, levelSpanDb: 32, peakDbfs: -14, trackLive: true };
  it("passes when speech results, a moving mic level and a live track coexist", () => {
    expect(judgePhase(ok)).toEqual({ pass: true, reasons: [] });
  });
  it("names each failure", () => {
    expect(judgePhase({ ...ok, speechResults: 0, speechError: "audio-capture" }).reasons).toEqual(["speech recognition heard nothing while the mic stream ran (audio-capture)"]);
    expect(judgePhase({ ...ok, micBlocks: 0 }).reasons[0]).toMatch(/no audio/);
    expect(judgePhase({ ...ok, levelSpanDb: 1, peakDbfs: -90 }).reasons[0]).toMatch(/went flat/);
    expect(judgePhase({ ...ok, trackLive: false }).reasons[0]).toMatch(/muted or ended/);
    expect(judgePhase({ ...ok, speechStarted: false, speechResults: 0, speechError: "not-allowed" }).reasons[0]).toBe("speech recognition did not start (not-allowed)");
  });
});

describe("sessionOverLine (review M20)", () => {
  it("matches the TV's session summary wording", () => {
    expect(sessionOverLine({ passed: 2, failed: 1, unverified: 0, beeOverrules: 1 })).toBe("Session over: 2 passed, 1 failed, 0 unverified, Bee overruled 1.");
    expect(sessionOverLine(null)).toBe("Session over.");
    expect(sessionOverLine({ passed: 0, failed: 0, unverified: 0, pending: 1 })).toBe("Session over: 0 passed, 0 failed, 0 unverified, 1 still with Bee.");
  });
});

describe("speechLang (review L47)", () => {
  it("dictates a card in its own language", () => {
    expect(speechLang({ lang: "fr" } as any)).toBe("fr-FR");
    expect(speechLang({ lang: "en" } as any)).toBe("en-US");
    expect(speechLang(null)).toBe("en-US");
  });
});
