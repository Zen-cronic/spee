// Web Speech recognition (Chrome, and Safari as webkitSpeechRecognition). Browser-only. The text
// stays on the phone except as a drill attempt (sendFinal) or a practice caption (meters, never
// persisted by the hub).

export interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
}
export type Ctor = new () => SpeechRec;

export function speechCtor(): Ctor | null {
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Listener {
  stop(): void;
  text(): string; // everything final so far plus the current interim words
}

// Continuous recognition with interim results; restarts itself if the browser ends it early,
// until stop() is called.
// Errors after which restarting recognition can only fail again (permission or device problems).
export const FATAL_SPEECH_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar"]);
// At most this many restarts within RESTART_WINDOW_MS: a start, end, start loop stops itself.
const MAX_RESTARTS = 8;
const RESTART_WINDOW_MS = 10_000;

export function listen(o: { lang?: string; onText: (text: string, final: boolean) => void; onError?: (err: string) => void; onStart?: () => void }): Listener | null {
  const SR = speechCtor();
  if (!SR) return null;
  let finals = "";
  let interim = "";
  let stopped = false;
  let fatal: string | null = null;
  const restarts: number[] = [];
  let rec: SpeechRec | null = null;
  const begin = () => {
    rec = new SR();
    rec.lang = o.lang ?? "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onstart = () => o.onStart?.();
    rec.onresult = (e) => {
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) {
          finals = `${finals} ${t}`.trim();
          o.onText(finals, true);
        } else interim += t;
      }
      if (interim) o.onText(`${finals} ${interim}`.trim(), false);
    };
    rec.onerror = (e) => {
      if (FATAL_SPEECH_ERRORS.has(e.error)) fatal = e.error;
      o.onError?.(e.error);
    };
    rec.onend = () => {
      if (stopped || fatal) return; // a fatal error was surfaced through onError: no restart loop
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > RESTART_WINDOW_MS) restarts.shift();
      if (restarts.length >= MAX_RESTARTS) {
        fatal = "restart-loop";
        o.onError?.("restart-loop");
        return;
      }
      restarts.push(now);
      try {
        begin();
      } catch {
        /* the browser refused a restart */
      }
    };
    rec.start();
  };
  begin();
  return {
    stop() {
      stopped = true;
      try {
        rec?.stop();
      } catch {
        /* not running */
      }
    },
    text: () => `${finals} ${interim}`.trim(),
  };
}

// One-shot dictation for a drill attempt: a tap starts it, the next tap stops it. A recognizer that
// refuses to start (start() throws, for example while the browser still holds the last one) is
// dropped at once and reported, so the next tap starts a fresh one instead of stopping a recognizer
// that never ran.
export interface Dictation {
  toggle(): void;
  active(): boolean;
}
export function dictation(
  SR: Ctor,
  o: { lang: () => string; onListening: () => void; onIdle: () => void; onError: (error: string) => void; onSpeechEnd: () => void; onResult: NonNullable<SpeechRec["onresult"]> },
): Dictation {
  let rec: SpeechRec | null = null;
  return {
    active: () => rec !== null,
    toggle() {
      if (rec) {
        try {
          rec.stop();
        } catch {
          /* already ending */
        }
        return;
      }
      const r = new SR();
      r.lang = o.lang();
      r.interimResults = true;
      r.continuous = false;
      r.onspeechend = () => o.onSpeechEnd();
      r.onresult = o.onResult;
      r.onerror = (e) => o.onError(e.error);
      r.onend = () => {
        if (rec === r) rec = null;
        o.onIdle();
      };
      rec = r;
      o.onListening();
      try {
        r.start();
      } catch (err) {
        rec = null;
        o.onError((err as Error)?.name || (err as Error)?.message || "start failed");
      }
    },
  };
}
