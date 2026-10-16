// Microphone capture for practice mode and the mic check. Browser-only.
//
// getUserMedia with automatic gain control, noise suppression and echo cancellation OFF (they
// flatten exactly the level and pitch movement the meters measure). Samples reach JS through an
// AudioWorklet (a Blob-URL module, 1024-sample blocks), or a ScriptProcessor where worklets are
// missing. The node feeds a muted gain so the graph runs without playing the mic back.

export interface Capture {
  sampleRate: number;
  track: MediaStreamTrack;
  stop(): void;
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('speaking-mirror-tap', Tap);
`;

type AudioCtor = typeof AudioContext;

export function captureSupported(): { ok: boolean; why: string | null } {
  if (typeof window === "undefined") return { ok: false, why: "no browser window" };
  if (!window.isSecureContext) return { ok: false, why: "the page is not a secure context: open it over https (the tunnel link) or on localhost" };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, why: "this browser has no getUserMedia" };
  const AC = (window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }).AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!AC) return { ok: false, why: "this browser has no Web Audio" };
  return { ok: true, why: null };
}

// Start the mic. Call from a user gesture (iOS needs it to resume the AudioContext).
export async function startCapture(onBlock: (samples: Float32Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
  const AC = (window as unknown as { AudioContext?: AudioCtor }).AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const src = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  let node: AudioNode;
  let workletUrl: string | null = null;
  try {
    if (!ctx.audioWorklet) throw new Error("no worklet");
    workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
    const w = new AudioWorkletNode(ctx, "speaking-mirror-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    w.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
    node = w;
  } catch {
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0).slice(0));
    node = sp;
  }
  src.connect(node);
  node.connect(mute);
  const track = stream.getAudioTracks()[0]!;
  return {
    sampleRate: ctx.sampleRate,
    track,
    stop() {
      try {
        src.disconnect();
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => undefined);
      if (workletUrl) URL.revokeObjectURL(workletUrl);
    },
  };
}
