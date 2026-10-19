// Alexa routing, request checks and speech helpers (packet C): the catch-all rescue, the skill id
// and timestamp window, and the 2-sentence SSML-safe speech.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyUtterance, normalize, parseMinutes, routeRequest } from "../src/alexa/route.js";
import { clip, escapeSsml, failReason, line, sentences, ssml } from "../src/alexa/speech.js";
import type { AlexaRequestEnvelope } from "../src/alexa/types.js";
import { isAlexaApiEndpoint, readSkillConfig, resolveSkillId, verifyAlexaRequest } from "../src/alexa/verify.js";
import type { GradeResult } from "../src/hub/contract.js";

const fx = (name: string): AlexaRequestEnvelope => JSON.parse(readFileSync(new URL(`../alexa/fixtures/${name}.json`, import.meta.url), "utf8")).request;
const catchAll = (value: string): AlexaRequestEnvelope => {
  const e = fx("attempt");
  e.request.intent!.slots!.attempt!.value = value;
  return e;
};
const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const NOW = Date.parse("2026-10-20T17:30:10.000Z");

describe("intent rescue from the catch-all slot", () => {
  it.each([
    ["how did I do", "HowDidIDoIntent"],
    ["How did I do?", "HowDidIDoIntent"],
    ["um how did I do on that", "HowDidIDoIntent"],
    ["did I pass", "HowDidIDoIntent"],
    ["how am I doing", "HowAmIDoingIntent"],
    ["Alexa, how am I doing?", "HowAmIDoingIntent"],
    ["next", "AMAZON.NextIntent"],
    ["skip this one", "AMAZON.NextIntent"],
    ["stop", "AMAZON.StopIntent"],
    ["I'm done", "AMAZON.StopIntent"],
    ["turn on live coaching", "LiveCoachOnIntent"],
    ["turn live coaching off", "LiveCoachOffIntent"],
    ["stop live coaching", "LiveCoachOffIntent"],
    ["did it transfer", "DidItTransferIntent"],
    ["quiz me", "StartDrillIntent"],
  ])("%s -> %s", (said, want) => {
    const r = routeRequest(catchAll(said));
    expect(r.intent).toBe(want);
    expect(r.rescuedFrom).toBe("AttemptIntent");
    expect(r.text).toBeNull();
  });
  it("a drill sentence that contains a command word stays an attempt", () => {
    for (const s of ["The next release ships on Friday.", "We stop the export at noon.", "I did the review and how it works is clear"]) {
      const r = routeRequest(catchAll(s));
      expect(r.intent, s).toBe("AttemptIntent");
      expect(r.text).toBe(s);
      expect(r.rescuedFrom).toBeNull();
    }
  });
  it("a sentence with 'how did I do' run on is graded without the tail", () => {
    const r = routeRequest(catchAll("The report is ready for review how did I do"));
    expect(r).toMatchObject({ intent: "AttemptIntent", text: "The report is ready for review" }); // the user's own words, tail cut
  });
  it("live coaching minutes, from the slot or the words", () => {
    expect(classifyUtterance("turn on live coaching for 30 minutes")).toMatchObject({ intent: "LiveCoachOnIntent", minutes: 30 });
    expect(classifyUtterance("start live coaching for an hour")).toMatchObject({ intent: "LiveCoachOnIntent", minutes: 60 });
    expect(routeRequest(fx("live-coach-on"))).toMatchObject({ intent: "LiveCoachOnIntent", minutes: 30 });
    expect(parseMinutes("ninety")).toBe(90);
    expect(parseMinutes("banana")).toBeNull();
  });
  it("an empty catch-all is a fallback; built-ins and requests pass through", () => {
    expect(routeRequest(catchAll("  ")).intent).toBe("AMAZON.FallbackIntent");
    expect(routeRequest(fx("launch")).intent).toBe("LaunchRequest");
    expect(routeRequest(fx("session-ended")).intent).toBe("SessionEndedRequest");
    expect(routeRequest(fx("next")).intent).toBe("AMAZON.NextIntent");
    const nav = fx("next");
    nav.request.intent!.name = "AMAZON.NavigateHomeIntent";
    expect(routeRequest(nav)).toMatchObject({ intent: "AMAZON.StopIntent", rescuedFrom: "AMAZON.NavigateHomeIntent" });
    nav.request.intent!.name = "SomethingElse";
    expect(routeRequest(nav).intent).toBe("Unknown");
  });
  it("normalize drops punctuation and lead-ins", () => {
    expect(normalize("  Okay, so: HOW did I do?! ")).toBe("how did i do");
  });
});

describe("request checks", () => {
  it("accepts the right skill id within 150 s", () => {
    expect(verifyAlexaRequest(fx("launch"), { skillId: SKILL, now: NOW })).toEqual({ ok: true });
    expect(verifyAlexaRequest(fx("launch"), { skillId: SKILL, now: NOW + 149_000 })).toEqual({ ok: true });
    expect(verifyAlexaRequest(fx("launch"), { skillId: SKILL, now: NOW - 149_000 })).toEqual({ ok: true });
  });
  it("rejects a wrong skill id (in session or context)", () => {
    expect(verifyAlexaRequest(fx("launch"), { skillId: "amzn1.ask.skill.other", now: NOW })).toEqual({ ok: false, reason: "wrong skill id" });
    const e = fx("launch");
    e.context!.System!.application!.applicationId = "amzn1.ask.skill.other";
    expect(verifyAlexaRequest(e, { skillId: SKILL, now: NOW }).ok).toBe(false);
  });
  it("rejects a stale or future timestamp, a missing one, and non-envelopes", () => {
    expect(verifyAlexaRequest(fx("launch"), { skillId: SKILL, now: NOW + 151_000 })).toEqual({ ok: false, reason: "timestamp outside the 150 s window" });
    expect(verifyAlexaRequest(fx("launch"), { skillId: SKILL, now: NOW - 151_000 }).ok).toBe(false);
    const e = fx("launch");
    delete e.request.timestamp;
    expect(verifyAlexaRequest(e, { skillId: SKILL, now: NOW }).ok).toBe(false);
    expect(verifyAlexaRequest({}, { skillId: SKILL, now: NOW }).ok).toBe(false);
    expect(verifyAlexaRequest(null, { skillId: SKILL, now: NOW }).ok).toBe(false);
  });
  it("skill id: ALEXA_SKILL_ID, else alexa/skill-id.json (the dev skill)", () => {
    expect(readSkillConfig().skillId).toMatch(/^amzn1\.ask\.skill\.[0-9a-f-]{36}$/);
    expect(resolveSkillId({})).toBe(readSkillConfig().skillId);
    expect(resolveSkillId({ ALEXA_SKILL_ID: " amzn1.ask.skill.env " })).toBe("amzn1.ask.skill.env");
  });
  it("progressive responses only go to Alexa's API hosts", () => {
    for (const ok of ["https://api.amazonalexa.com", "https://api.eu.amazonalexa.com", "https://api.fe.amazonalexa.com/"]) expect(isAlexaApiEndpoint(ok), ok).toBe(true);
    for (const bad of ["http://api.amazonalexa.com", "https://api.amazonalexa.com.evil.test", "https://127.0.0.1:8791", "https://evil.test/?x=api.amazonalexa.com", undefined]) expect(isAlexaApiEndpoint(bad), String(bad)).toBe(false);
  });
});

describe("speech", () => {
  it("clips to 2 sentences, never splitting a quoted card or a decimal", () => {
    expect(sentences('Not yet: Bee heard a filler. Say it again: "I fixed it. Then I left." Thanks.')).toEqual(["Not yet: Bee heard a filler.", 'Say it again: "I fixed it. Then I left."', "Thanks."]);
    expect(clip("One is 2.1 per 100. Two. Three.")).toBe("One is 2.1 per 100. Two.");
    expect(clip("A. B. C.", 3)).toBe("A. B. C.");
  });
  it("line() joins parts, ends each with punctuation and keeps at most 2 sentences", () => {
    expect(line(["Got it, checking with Bee", null, "Ask me how you did in about 15 seconds"])).toBe("Got it, checking with Bee. Ask me how you did in about 15 seconds.");
    expect(line(["One", "Two", "Three"])).toBe("One. Two.");
  });
  it("SSML is escaped and markup is stripped", () => {
    expect(escapeSsml(`a & b < c > "d" 'e'`)).toBe("a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;");
    expect(ssml("Checking <audio src='x'/> with Bee & co.")).toBe("<speak>Checking audio src=&apos;x&apos;/ with Bee &amp; co.</speak>");
  });
  it("failReason names the first failing rule", () => {
    const g = (rule: string, extra: Partial<GradeResult> = {}) =>
      ({ checks: [{ rule: "nonempty", ok: true, detail: "" }, { rule, ok: false, detail: "" }], habit: { kind: "hedge", label: "", hits: 1, found: ["i guess"] }, fillers: ["um"], missing: ["invoice", "retry"], required: [{ word: "job", ok: false }], ...extra }) as unknown as GradeResult;
    expect(failReason(g("habit"))).toBe('you still said "i guess"');
    expect(failReason(g("fillers"))).toBe('Bee heard a filler, "um"');
    expect(failReason(g("content"))).toBe('some words were missing, like "invoice", "retry"');
    expect(failReason(g("required"))).toBe('you didn\'t say "job"');
  });
});
