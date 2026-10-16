// Recaps (src/hub/live/recap.ts), the principles loader (principles.ts) and the optional model
// phrasing (recapPrompt.ts): template first, the moment in the wearer's own words, the model's
// output rejected for the template on a timeout, a bad shape or a shingle shared with the private
// principles. Bedrock is never called: the phrasing function is a fake.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BeeLine } from "../src/hub/bee.js";
import { RECAP_MOMENT_MAX_WORDS, WRIST_TEXT_MAX } from "../src/hub/contract.js";
import type { Baseline } from "../src/hub/live/baseline.js";
import { DEFAULT_THRESHOLDS, loadPrinciples, parseThresholds, principlesFromText } from "../src/hub/live/principles.js";
import { buildRecap, verdictOf } from "../src/hub/live/recap.js";
import { acceptPhrasing, phraseRecap, recapPrompt, RECAP_LLM_MODEL, type PhraseFn } from "../src/hub/live/recapPrompt.js";
import { windowThresholds } from "../src/hub/live/rules.js";
import { ConversationWindow } from "../src/hub/live/window.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const BASE: Baseline = { source: "test", words: 1400, hedgesPer100: 1.43, likesPer100: 1.79, fillersPer100: 2.43, wpm: 140, vaguePer100: 0.64, restartsPer100: 0.86 };
let uid = 1;
const line = (speaker: BeeLine["speaker"], text: string, startS: number, endS: number): BeeLine => ({ utteranceId: uid++, conversationUuid: "c", speaker, ...(speaker === "wearer" ? { text } : {}), words: text.split(/\s+/).length, spokenAt: T0 + startS * 1000, durMs: (endS - startS) * 1000, startS, endS, receivedAt: T0 + endS * 1000 + 5400, resolvedAt: T0 + endS * 1000 + 5900, score: 0.8, drill: false });

function conversation() {
  const w = new ConversationWindow("c", T0, true);
  const ada = [
    "The billing export finished on Monday and the totals match the ledger.",
    "I guess we could maybe ship the export on Friday.",
    "I think the retry logic is kind of ready, but not fully, because the alerting still needs one more review from the team.",
    "We moved the release of the mobile build to Friday afternoon.",
    "Probably the alerting is the last piece, and I think it is small.",
    "The search page loads in two seconds on the staging server.",
  ];
  let t = 0;
  for (const s of ada) {
    const d = (s.split(" ").length / 140) * 60;
    w.upsert(line("wearer", s, t, t + d));
    t += d + 1;
    w.upsert(line("other", "the zebra orchid passcode is 4417", t, t + 2));
    t += 3;
  }
  return w;
}
const recapOf = (w: ConversationWindow, baseline: Baseline | null = BASE) => {
  const a = w.analyze(T0 + 300_000, windowThresholds(DEFAULT_THRESHOLDS), baseline);
  return buildRecap({ id: "rcp_t", win: w, a, baseline, endedAt: T0 + 120_000, createdAt: T0 + 121_000, pace: 1, dataLabel: "SYNTHETIC", synthetic: true, delivery: { wrist: "replay", todoId: null } });
};

describe("recap template", () => {
  it("metrics against the baseline, a short wearer moment with its rephrase, generated wrist text", () => {
    const r = recapOf(conversation());
    expect(r.metrics.habits.map((h) => [h.key, h.count, h.verdict])).toEqual([
      ["hedges", 6, "worse"],
      ["filler:like", 0, "better"],
      ["vague", 0, "typical"],
      ["restart", 0, "typical"],
    ]);
    expect(r.metrics.wpm).toBe(140);
    expect(r.metrics.baselineWpm).toBe(140);
    expect(r.moment).toEqual({ text: "I guess we could maybe ship the export on Friday.", at: expect.any(Number), habit: "hedges", rephrase: "We could ship the export on Friday." });
    expect(r.moment!.text.split(/\s+/).length).toBeLessThanOrEqual(RECAP_MOMENT_MAX_WORDS);
    expect(r.headline).toMatch(/^Hedges ran high: \d\.\d per 100 words against your usual 1\.4\. "Like" was down\.$/);
    expect(r.narration).toMatch(/^That conversation ran about 2 minutes\. You hedged 6 times, .* and your pace held at 140 words a minute\. Try it without the hedges: "We could ship the export on Friday\."$/);
    expect(r.wristText).toBe("[coach] Recap: hedges high, pace steady");
    expect(r.wristText.length).toBeLessThanOrEqual(WRIST_TEXT_MAX);
    expect(r.phrasing).toBe("template");
    expect(JSON.stringify(r)).not.toMatch(/zebra|4417/);
  });
  it("verdicts are a Poisson z of the count against the baseline; no baseline says so", () => {
    expect(verdictOf(11, 520, 1.43)).toBe("worse");
    expect(verdictOf(6, 520, 1.79)).toBe("better");
    expect(verdictOf(3, 520, 0.86)).toBe("typical");
    expect(verdictOf(3, 520, null)).toBe("no-baseline");
    expect(recapOf(conversation(), null).metrics.habits.every((h) => h.verdict === "no-baseline")).toBe(true);
  });
});

describe("principles", () => {
  it("prefer coach/principles.local.md, read its JSON block, fall back to the template, then built-in numbers", () => {
    const root = mkdtempSync(join(tmpdir(), "principles-"));
    mkdirSync(join(root, "coach"));
    expect(loadPrinciples(root).source).toBe("builtin");
    writeFileSync(join(root, "coach/principles.template.md"), "# Generic\n\nSpeak clearly.\n");
    expect(loadPrinciples(root)).toMatchObject({ source: "template", thresholdsFrom: "default" });
    const local = "# Mine\n\nLead with the decision before the details, every single time.\n\n```json\n" + JSON.stringify({ ...DEFAULT_THRESHOLDS, monologue: { nudgeMs: 60_000 } }) + "\n```\n";
    writeFileSync(join(root, "coach/principles.local.md"), local);
    const p = loadPrinciples(root);
    expect(p).toMatchObject({ source: "local", thresholdsFrom: "file" });
    expect(p.thresholds.monologue.nudgeMs).toBe(60_000);
    expect(p.rubric).not.toContain("```");
    expect(p.sharesShingle("Remember to lead with the decision before the details.")).toBe(true);
    expect(p.sharesShingle("Try it without the hedges.")).toBe(false);
    expect(parseThresholds("```json\n{\"version\":2}\n```")).toBeNull();
  });
  it("the committed template parses to the contract thresholds", () => {
    expect(loadPrinciples().thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("optional model phrasing", () => {
  const principles = principlesFromText("Lead with the decision before the details, every single time.", "local");
  const good = { headline: "Hedges ran high today: 3.1 per 100 words.", narration: 'About 2 minutes. You hedged 6 times. Try: "We could ship the export on Friday."', wristText: "[coach] Recap: hedges high" };
  it("injects the rubric into the system prompt only, with Haiku as the only model", async () => {
    const r = recapOf(conversation());
    const p = recapPrompt(r, principles);
    expect(p.system).toContain("Lead with the decision");
    expect(p.user).not.toContain("Lead with the decision");
    let chain: string[] | undefined;
    const fake: PhraseFn = async (o) => ((chain = o.chain), { input: good, modelId: RECAP_LLM_MODEL });
    expect(await phraseRecap(r, principles, fake)).toEqual(good);
    expect(chain).toEqual(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
  });
  it("falls back to the template: timeout, error, bad shape, long wrist text, invented quote, shared shingle", async () => {
    const r = recapOf(conversation());
    const never: PhraseFn = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await phraseRecap(r, principles, never, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await phraseRecap(r, principles, async () => Promise.reject(new Error("AccessDenied")))).toBeNull();
    expect(acceptPhrasing({ headline: 1 }, r, principles)).toBeNull();
    expect(acceptPhrasing({ ...good, wristText: `[coach] ${"x".repeat(60)}` }, r, principles)).toBeNull();
    expect(acceptPhrasing({ ...good, wristText: "Recap: no prefix" }, r, principles)).toBeNull();
    expect(acceptPhrasing({ ...good, narration: 'You said "the vault code is secret" twice.' }, r, principles)).toBeNull();
    expect(acceptPhrasing({ ...good, narration: "Remember to lead with the decision before the details." }, r, principles)).toBeNull();
    expect(acceptPhrasing({ ...good, narration: "One. Two. Three. Four." }, r, principles)).toBeNull();
    expect(acceptPhrasing(good, r, principles)).toEqual(good);
  });
});
