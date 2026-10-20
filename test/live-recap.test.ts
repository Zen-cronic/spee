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
import { buildRecap, composeRecap, fillSlots, type RecapInput, type RecapSlots } from "../src/hub/live/recap.js";
import { verdictOf } from "../src/hub/live/recap.js";
import { acceptPhrasing, phraseRecap, recapPrompt, RECAP_LLM_MODEL, slotsIn, type PhraseFn } from "../src/hub/live/recapPrompt.js";
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
const inputOf = (w: ConversationWindow, baseline: Baseline | null = BASE, o: Partial<RecapInput> = {}): RecapInput => {
  const a = w.analyze(T0 + 400_000, windowThresholds(DEFAULT_THRESHOLDS), baseline);
  return { id: "rcp_t", win: w, a, baseline, endedAt: T0 + 120_000, createdAt: T0 + 121_000, pace: 1, dataLabel: "SYNTHETIC", synthetic: true, delivery: { wrist: "replay", todoId: null }, ...o };
};
const recapOf = (w: ConversationWindow, baseline: Baseline | null = BASE) => buildRecap(inputOf(w, baseline));
// One unbroken stretch from the wearer (no hedges), then a short reply: the long-turn recap.
function longTurn() {
  const w = new ConversationWindow("c", T0, true);
  const said = ["The billing export finished on Monday and the totals match the ledger.", "We moved the release of the mobile build to Friday afternoon.", "The search page loads quickly on the staging server now.", "The alerting review is booked with the platform team next week."];
  let t = 0;
  for (let k = 0; k < 4; k++)
    for (const s of said) {
      const d = (s.split(" ").length / 140) * 60;
      w.upsert(line("wearer", s, t, t + d));
      t += d + 0.3;
    }
  w.upsert(line("other", "sounds good", t, t + 2));
  return composeRecap(inputOf(w, BASE, { endedAt: T0 + 360_000, monologueMs: 60_000 }));
}

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
    expect(r.headline).toMatch(/^Unsure words ran high: \d\.\d per 100 words against your usual 1\.4\. Filler "like" was down\.$/);
    expect(r.narration).toMatch(/^That conversation ran about 2 minutes\. You used 6 unsure words, .* out of every 100 words you said .* and your pace held at 140 words a minute\. Try it without the unsure words: "We could ship the export on Friday\."$/);
    expect(r.wristText).toBe("[coach] Recap: more unsure words than usual, pace steady");
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

  it("ignores link targets: a cited URL is a public reference, not private wording", () => {
    const p = principlesFromText("Pause before the key point. [Source](https://docs.example.com/guide/pauses/before/points)", "local");
    expect(p.sharesShingle("See docs.example.com/guide/pauses/before/points for the guide.")).toBe(false);
    expect(p.sharesShingle("Always pause before the key point.")).toBe(true);
  });
  it("the committed template parses to the contract thresholds", () => {
    expect(loadPrinciples().thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("optional model phrasing: the model writes slots, code writes the numbers", () => {
  const principles = principlesFromText("Lead with the decision before the details, every single time.", "local");
  // The template: "Hedges ran high: {hedges_rate} per 100 words against your usual {hedges_usual}. ..." and
  // "That conversation ran about {minutes} minutes. You hedged {hedges_count} times, {hedges_rate} per 100
  // words against your usual {hedges_usual}, and your pace held at {wpm} words a minute. ..."
  const good = { headline: "Hedges ran high today: {hedges_rate} per 100 words, usually {hedges_usual}.", narration: 'This conversation took about {minutes} minutes at {wpm} words a minute. You hedged {hedges_count} times. Try: "We could ship the export on Friday."', wristText: "[coach] Recap: hedges high" };
  const hedgy = () => composeRecap(inputOf(conversation()));
  const filled = (o: typeof good, slots: RecapSlots) => ({ headline: fillSlots(o.headline, slots.values), narration: fillSlots(o.narration, slots.values), wristText: fillSlots(o.wristText, slots.values) });

  it("slots: the template's numbers by name, and the template itself is an accepted phrasing", () => {
    const { recap, slots } = hedgy();
    expect(slots.values).toMatchObject({ hedges_count: "6", minutes: "2", wpm: "140", hedges_usual: "1.4" });
    expect(slots.template.headline).toBe('Unsure words ran high: {hedges_rate} per 100 words against your usual {hedges_usual}. Filler "like" was down.');
    expect(fillSlots(slots.template.headline, slots.values)).toBe(recap.headline);
    expect(fillSlots(slots.template.narration, slots.values)).toBe(recap.narration);
    expect(acceptPhrasing(slots.template, recap, slots, principles)).toEqual({ headline: recap.headline, narration: recap.narration, wristText: recap.wristText });
    const lt = longTurn();
    expect(lt.recap.headline).toMatch(/^A long turn: \d\.\d minutes without a break\./);
    expect(slotsIn(lt.slots.template.narration)).toEqual(["minutes", "longest_turn_min", "wpm", "check_in_seconds"]);
    expect(acceptPhrasing(lt.slots.template, lt.recap, lt.slots, principles)).toEqual({ headline: lt.recap.headline, narration: lt.recap.narration, wristText: lt.recap.wristText });
  });
  it("injects the rubric into the system prompt only, gives the slots and the slotted template, with Haiku as the only model", async () => {
    const { recap, slots } = hedgy();
    const p = recapPrompt(recap, slots, principles);
    expect(p.system).toContain("Lead with the decision");
    expect(p.user).not.toContain("Lead with the decision");
    expect(JSON.parse(p.user.slice(p.user.indexOf("\n") + 1))).toMatchObject({ slots: slots.values, template: slots.template });
    let chain: string[] | undefined;
    const fake: PhraseFn = async (o) => ((chain = o.chain), { input: good, modelId: RECAP_LLM_MODEL });
    const out = await phraseRecap(recap, slots, principles, fake);
    expect(out).toEqual(filled(good, slots));
    expect(out!.narration).toMatch(/^This conversation took about 2 minutes at 140 words a minute\. You hedged 6 times\./);
    expect(chain).toEqual(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
  });
  it("falls back to the template: timeout, error, bad shape, long wrist text, invented quote, shared shingle", async () => {
    const { recap, slots } = hedgy();
    const never: PhraseFn = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await phraseRecap(recap, slots, principles, never, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await phraseRecap(recap, slots, principles, async () => Promise.reject(new Error("AccessDenied")))).toBeNull();
    const ok = (o: Partial<typeof good>) => acceptPhrasing({ ...good, ...o }, recap, slots, principles);
    expect(acceptPhrasing({ headline: 1 }, recap, slots, principles)).toBeNull();
    expect(ok({ wristText: `[coach] ${"x".repeat(60)}` })).toBeNull();
    expect(ok({ wristText: "Recap: no prefix" })).toBeNull();
    expect(ok({ narration: `${good.narration} You said "the vault code is secret".` })).toBeNull();
    expect(ok({ narration: `${good.narration.replace(' Try: "We could ship the export on Friday."', "")} Remember to lead with the decision before the details.` })).toBeNull();
    expect(ok({ narration: `${good.narration} Again. More.` })).toBeNull();
    expect(ok({})).toEqual(filled(good, slots));
  });
  it("refuses any number the model wrote itself, in digits or in words, and any unknown or missing slot", () => {
    const { recap, slots } = hedgy();
    const n = (narration: string, headline = good.headline) => acceptPhrasing({ ...good, headline, narration }, recap, slots, principles);
    const base = "This conversation took about {minutes} minutes at {wpm} words a minute.";
    expect(n(`${base} You hedged {hedges_count} times.`)).not.toBeNull();
    expect(n(`${base} You hedged 6 times.`)).toBeNull(); // the right count, but written by the model
    expect(n(`${base} You hedged six times.`)).toBeNull();
    expect(n(`${base} You hedged thirty-one times.`)).toBeNull();
    expect(n(`${base} You hedged {hedges_count} times, twice in one sentence.`)).toBeNull();
    expect(n(`${base} You hedged {hedges_count} times, 9.8 per 100 words.`)).toBeNull(); // an added rate
    expect(n(`${base} You hedged {hedges_total} times.`)).toBeNull(); // not a slot
    expect(n(`${base} You hedged {hedges_count times.`)).toBeNull(); // a broken slot
    expect(n(`${base} You hedged a lot.`)).toBeNull(); // {hedges_count} dropped
    expect(n(`You hedged {hedges_count} times at {wpm} words a minute.`)).toBeNull(); // {minutes} dropped
    expect(n(good.narration, "Hedges ran high: {hedges_rate} per 100 words.")).toBeNull(); // {hedges_usual} dropped
    expect(acceptPhrasing({ ...good, wristText: "[coach] Recap: 20 hedges" }, recap, slots, principles)).toBeNull();
    // "per 100 words" is the one number a phrasing may write: it is a unit, not a fact.
    expect(n(`${base} You hedged {hedges_count} times, {hedges_rate} per 100 words against your usual {hedges_usual}.`)).not.toBeNull();
  });
  it("a swapped number cannot be accepted: the conversation's minutes and the longest turn's", () => {
    const { recap, slots } = longTurn();
    expect(recap.narration).toMatch(/^That conversation ran about 6 minutes\. Your longest turn ran 1\.3 minutes/);
    const n = (narration: string) => acceptPhrasing({ headline: slots.template.headline, narration, wristText: slots.template.wristText }, recap, slots, principles);
    const rest = "and your pace held at {wpm} words a minute. Check in before the {check_in_seconds}-second mark.";
    expect(n(`That conversation ran about {minutes} minutes. Your longest turn ran {longest_turn_min} minutes, ${rest}`)).not.toBeNull();
    // The swap as numbers (what the earlier check let through), and as slots.
    expect(n(`That conversation ran about 1.3 minutes. Your longest turn ran 6 minutes, ${rest}`)).toBeNull();
    expect(n(`That conversation ran about {longest_turn_min} minutes. Your longest turn ran {minutes} minutes, ${rest}`)).toBeNull();
    // The model's sentence must name the turn for the turn's minutes, and the conversation for its own.
    expect(n(`You talked for {longest_turn_min} minutes straight in a {minutes} minute conversation, ${rest}`)).toBeNull();
  });
  it("a swapped number cannot be accepted: two habits' rates, or a rate and its usual", () => {
    // A recap whose headline is about "like" and whose narration is about hedges.
    const slots: RecapSlots = {
      values: { like_rate: "0.8", like_usual: "2.1", hedges_rate: "1.5", hedges_usual: "1.4", hedges_count: "3", like_count: "1", vague_count: "0", restarts_count: "0", minutes: "4", wpm: "138" },
      template: {
        headline: '"Like" was down: {like_rate} per 100 words against your usual {like_usual}.',
        narration: "That conversation ran about {minutes} minutes. You hedged {hedges_count} times, {hedges_rate} per 100 words against your usual {hedges_usual}, and your pace held at {wpm} words a minute.",
        wristText: "[coach] Recap: a typical talk, pace steady",
      },
    };
    const recap = { moment: null } as never;
    const n = (headline: string, narration = slots.template.narration) => acceptPhrasing({ headline, narration, wristText: slots.template.wristText }, recap, slots, principles);
    expect(n('"Like" dropped to {like_rate} per 100 words, usually {like_usual}.')).toEqual({ headline: '"Like" dropped to 0.8 per 100 words, usually 2.1.', narration: fillSlots(slots.template.narration, slots.values), wristText: slots.template.wristText });
    // The two habits' rate pairs traded: the like sentence carries the hedge slots (and the other way).
    expect(n('"Like" was down: {hedges_rate} per 100 words against your usual {hedges_usual}.', "That conversation ran about {minutes} minutes. You hedged {hedges_count} times, {like_rate} per 100 words against your usual {like_usual}, and your pace held at {wpm} words a minute.")).toBeNull();
    expect(n('"Like" was down: 1.5 per 100 words against your usual 1.4.')).toBeNull();
    // A rate and its usual traded: "usual" points at the slot next to it.
    expect(n('"Like" was down: {like_usual} per 100 words against your usual {like_rate}.')).toBeNull();
    expect(n('"Like" was down to {like_rate} per 100 words from {like_usual}.')).toBeNull(); // the usual not marked as usual
  });
  it("two subjects merged into one sentence cannot trade their slots", () => {
    const { recap, slots } = longTurn();
    const n = (narration: string) => acceptPhrasing({ headline: slots.template.headline, narration, wristText: slots.template.wristText }, recap, slots, principles);
    const tail = " Check in before the {check_in_seconds}-second mark.";
    expect(n(`The conversation ran about {minutes} minutes and your longest turn ran {longest_turn_min} minutes at {wpm} words a minute.${tail}`)).not.toBeNull();
    expect(n(`The conversation ran about {longest_turn_min} minutes and your longest turn ran {minutes} minutes at {wpm} words a minute.${tail}`)).toBeNull();
    expect(n(`Your longest turn ran {minutes} minutes in a conversation of {longest_turn_min} minutes, at {wpm} words a minute.${tail}`)).toBeNull();
    // two habits' rates in one sentence that names both
    const two: RecapSlots = { values: { hedges_rate: "1.5", like_rate: "0.8", hedges_usual: "1.4", like_usual: "2.1", minutes: "4", hedges_count: "3", like_count: "1", vague_count: "0", restarts_count: "0" }, template: { headline: "Unsure words at {hedges_rate} per 100 words, usually {hedges_usual}.", narration: 'That conversation ran about {minutes} minutes. "Like" came to {like_rate} per 100 words, usually {like_usual}.', wristText: "[coach] Recap: a typical chat" } };
    const h = (headline: string) => acceptPhrasing({ headline, narration: two.template.narration, wristText: two.template.wristText }, { moment: null } as never, two, principles);
    expect(h('Unsure words were at {hedges_rate} (usually {hedges_usual}) and "like" at {like_rate} (usually {like_usual}).')).not.toBeNull();
    expect(h('Unsure words were at {like_rate} (usually {like_usual}) and "like" at {hedges_rate} (usually {hedges_usual}).')).toBeNull();
  });
  it("the template is an accepted phrasing in every branch: worse, clean, better, typical, long turn, no baseline", () => {
    const window = (said: string[]) => {
      const w = new ConversationWindow("c", T0, true);
      let t = 0;
      for (const x of said) {
        const d = (x.split(" ").length / 140) * 60;
        w.upsert(line("wearer", x, t, t + d));
        t += d + 1;
        w.upsert(line("other", "right", t, t + 1));
        t += 2;
      }
      return w;
    };
    const plain = ["The billing export finished on Monday and the totals match the ledger.", "We moved the release of the mobile build to Friday afternoon.", "The search page loads quickly on the staging server now."];
    const cases: [string, ConversationWindow, Baseline | null][] = [
      ["worse", conversation(), BASE],
      ["clean", window(plain), BASE],
      ["clean, many words", window([...plain, ...plain, ...plain, ...plain, ...plain]), BASE],
      ["better", window([...plain, ...plain, ...plain, ...plain, ...plain]), { ...BASE, hedgesPer100: 6, likesPer100: 6 }],
      ["typical", window([...plain, "I think the alerting review is booked for next week.", ...plain]), { ...BASE, hedgesPer100: 2.5 }],
      ["no baseline", window([...plain, "I guess the alerting review is booked."]), null],
    ];
    const seen = new Set<string>();
    for (const [name, w, base] of cases) {
      const { recap, slots } = composeRecap(inputOf(w, base));
      seen.add(slots.template.narration.split(".")[1]!.trim().split(" ").slice(0, 3).join(" "));
      expect(acceptPhrasing(slots.template, recap, slots, principles), name).toEqual({ headline: recap.headline, narration: recap.narration, wristText: recap.wristText });
    }
    const lt = longTurn();
    expect(acceptPhrasing(lt.slots.template, lt.recap, lt.slots, principles)).not.toBeNull();
    expect(seen.has("You didn't use")).toBe(true); // the clean branch was exercised
  });
  it("hands callTool a sanitize hook, so a phrasing that echoes the principles is never cached (review H10)", async () => {
    const { recap, slots } = hedgy();
    let sanitize: ((x: unknown) => unknown) | undefined;
    const fake: PhraseFn = async (o) => ((sanitize = o.sanitize), { input: good, modelId: RECAP_LLM_MODEL });
    await phraseRecap(recap, slots, principles, fake);
    expect(sanitize).toBeTypeOf("function");
    expect(sanitize!(good)).toEqual(good);
    expect(sanitize!({ ...good, narration: "Remember to lead with the decision before the details." })).toBeNull();
  });
});
