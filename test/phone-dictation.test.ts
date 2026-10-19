// The phone's drill dictation (web/phone/src/speech.ts dictation): a tap starts a one-shot
// recognizer, the next tap stops it, and a recognizer whose start() throws is dropped so the mic
// button never sticks on "Listening…". A fake recognizer stands in for Web Speech.
import { describe, expect, it } from "vitest";
import { dictation, type SpeechRec } from "../web/phone/src/speech.js";

function fakeSR(throwOnStart: boolean[]) {
  const made: (SpeechRec & { started: boolean; stopped: number })[] = [];
  class Fake implements SpeechRec {
    lang = "";
    interimResults = false;
    continuous = true;
    started = false;
    stopped = 0;
    onresult: SpeechRec["onresult"] = null;
    onerror: SpeechRec["onerror"] = null;
    onend: SpeechRec["onend"] = null;
    onstart: SpeechRec["onstart"] = null;
    onspeechend: SpeechRec["onspeechend"] = null;
    constructor() {
      made.push(this);
    }
    start() {
      if (throwOnStart[made.length - 1]) throw Object.assign(new Error("recognition has already started"), { name: "InvalidStateError" });
      this.started = true;
    }
    stop() {
      this.stopped++;
      this.onend?.();
    }
    abort() {}
  }
  return { SR: Fake, made };
}

describe("drill dictation", () => {
  const hooks = () => {
    const log: string[] = [];
    return { log, o: { lang: () => "fr-FR", onListening: () => log.push("listening"), onIdle: () => log.push("idle"), onError: (e: string) => log.push(`error ${e}`), onSpeechEnd: () => log.push("speechend"), onResult: () => undefined } };
  };
  it("a start that throws is reported and dropped; the next tap starts a fresh recognizer", () => {
    const { SR, made } = fakeSR([true, false]);
    const { log, o } = hooks();
    const d = dictation(SR, o);
    d.toggle();
    expect(log).toEqual(["listening", "error InvalidStateError"]);
    expect(d.active()).toBe(false);
    d.toggle();
    expect(made).toHaveLength(2);
    expect(made[0]!.stopped).toBe(0); // never stopped: it never ran
    expect(made[1]).toMatchObject({ started: true, lang: "fr-FR", continuous: false, interimResults: true });
    expect(d.active()).toBe(true);
  });
  it("tap to start, tap to stop: the recognizer's end makes it idle again", () => {
    const { SR, made } = fakeSR([false]);
    const { log, o } = hooks();
    const d = dictation(SR, o);
    d.toggle();
    d.toggle();
    expect(made).toHaveLength(1);
    expect(made[0]!.stopped).toBe(1);
    expect(log).toEqual(["listening", "idle"]);
    expect(d.active()).toBe(false);
  });
});
