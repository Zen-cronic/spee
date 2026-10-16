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
type Ctor = new () => SpeechRec;

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
export function listen(o: { lang?: string; onText: (text: string, final: boolean) => void; onError?: (err: string) => void; onStart?: () => void }): Listener | null {
  const SR = speechCtor();
  if (!SR) return null;
  let finals = "";
  let interim = "";
  let stopped = false;
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
    rec.onerror = (e) => o.onError?.(e.error);
    rec.onend = () => {
      if (!stopped) {
        try {
          begin();
        } catch {
          /* the browser refused a restart */
        }
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
