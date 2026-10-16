import { describe, expect, it } from "vitest";
import { lexical } from "../src/analyze/metrics.js";
import { splitSentences } from "../src/analyze/segment.js";
import { buildWorld, render } from "../src/sim/world.js";

describe("simulator", () => {
  it("renders fillers only in verbatim and keeps the planted excerpt in both variants", () => {
    const r = render("{um} I [[made some good progress on||finished]] the {C}.", { C: "rate limiter" });
    expect(r.verbatim).toBe("Um I made some good progress on the rate limiter.");
    expect(r.cleaned).toBe("I made some good progress on the rate limiter.");
    expect(r.corrected).toBe("I finished the rate limiter.");
    expect(r.excerpt).toBe("made some good progress on");
  });
  const split = { en: { lang: "en" as const, drilled: ["EN_HEDGE_STACK", "EN_RUN_ON"], control: ["EN_NO_ETA"] }, fr: { lang: "fr" as const, drilled: ["FR_AUX_ETRE_AVOIR"], control: ["FR_GENDER"] } };
  const w = buildWorld(split);
  it("is deterministic", () => expect(JSON.stringify(buildWorld(split).truth)).toBe(JSON.stringify(w.truth)));
  it("pre-cutover sessions do not depend on the split", () => {
    const other = buildWorld({ en: { lang: "en", drilled: ["EN_NO_ETA"], control: [] }, fr: { lang: "fr", drilled: [], control: [] } });
    const pre = (x: typeof w) => x.truth.en.instances.filter((i) => i.phase === "pre");
    expect(JSON.stringify(pre(other))).toBe(JSON.stringify(pre(w)));
  });
  it("voice-note sentences segment 1:1 with truth keys", () => {
    for (const j of w.journals.verbatim) {
      const n = splitSentences(j.text!).length;
      const keys = Object.keys({ ...w.truth.en.utterances, ...w.truth.fr.utterances }).filter((k) => k.startsWith(`v:${j.id}:`));
      expect(keys.length).toBe(n);
    }
  });
  it("cleaned text carries no fillers", () => {
    const texts = w.conversations.cleaned.flatMap((c) => c.conversation.transcriptions[0]!.utterances.map((u) => u.text));
    expect(lexical("en", texts).crossSourceFillersPer100).toBe(0);
  });
  it("plants the effect: drilled responsive types drop, stubborn and control types do not", () => {
    const t = w.truth.en;
    expect(t.planted_effect.EN_HEDGE_STACK).toBe(0.2);
    expect(t.planted_effect.EN_RUN_ON).toBe(1);
    expect(t.planted_effect.EN_NO_ETA).toBe(1);
  });
  it("plants other-speaker errors in group conversations (contamination test)", () => {
    expect(w.truth.fr.instances.some((i) => i.role === "other" && i.kind === "conversation")).toBe(true);
    expect(w.truth.fr.instances.filter((i) => i.kind === "voice_note").every((i) => i.role === "wearer")).toBe(true);
  });
  it("includes short conversations that Bee would delete", () => {
    expect(w.truth.en.sessions.some((s) => s.deleted) && w.truth.fr.sessions.some((s) => s.deleted)).toBe(true);
  });
});
