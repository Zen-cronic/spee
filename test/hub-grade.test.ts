// The deterministic grader: fuzzy matching for ASR slips, one rule per habit kind, and negative
// controls. All inputs are invented.
import { describe, expect, it } from "vitest";
import { align, attemptSpan, fuzzyEq, normTokens, similarity } from "../src/hub/fuzzy.js";
import { CONTENT_THRESHOLD, grade, type GradeCard } from "../src/hub/grade.js";
import { deriveHabit, deriveMustSay } from "../src/hub/cards.js";
import type { Card } from "../src/real/deck.js";

const en = (resay: string, kind: GradeCard["habit"]["kind"], targets: string[] = [], mustSay?: string[]): GradeCard => ({ lang: "en", resay, habit: { kind, targets, label: kind }, mustSay });

describe("fuzzy matching", () => {
  it("accepts the ASR slips seen live on Bee", () => {
    expect(fuzzyEq("car", "card")).toBe(true);
    expect(fuzzyEq("rec", "rack")).toBe(true);
    expect(fuzzyEq("kard", "card")).toBe(true); // phonetic key: k ~ hard c
    expect(align(normTokens("open the drill card on the rack board"), normTokens("open the drill car on the rec board")).score).toBe(1);
  });
  it("joins and splits compounds", () => {
    expect(align(normTokens("the rack board screen"), normTokens("the rackboard screen")).score).toBe(1);
    expect(align(normTokens("our standup notes"), normTokens("our stand up notes")).score).toBe(1);
  });
  it("normalizes contractions, hyphens, digits and French elisions", () => {
    expect(normTokens("It's done, we'll ship 2 follow-ups")).toEqual(["it", "is", "done", "we", "will", "ship", "two", "follow", "ups"]);
    expect(normTokens("j'ai fini", "fr")).toEqual(["j", "ai", "fini"]);
  });
  it("rejects different words", () => {
    expect(fuzzyEq("cat", "cow")).toBe(false);
    expect(fuzzyEq("a", "i")).toBe(false); // 1-2 letters must be exact
    expect(fuzzyEq("blocked", "unblocked")).toBe(false); // first letter differs
    expect(fuzzyEq("monday", "friday")).toBe(false);
  });
  it("similarity is symmetric and 1 for identical text", () => {
    expect(similarity("the export is ready", "the export is ready")).toBe(1);
    expect(similarity("a b c d", "the export is ready")).toBe(similarity("the export is ready", "a b c d"));
  });
});

describe("grader rules", () => {
  const hedge = en("The billing export is ready for review today.", "hedge", ["i guess"]);
  it("passes a clean re-say and states every rule", () => {
    const g = grade(hedge, "The billing export is ready for review today");
    expect(g.pass).toBe(true);
    expect(g.checks.map((c) => c.rule)).toEqual(["nonempty", "habit", "fillers", "content"]);
    expect(g.reasons.every((r) => r.startsWith("ok "))).toBe(true);
    expect(g.contentMatch).toBe(1);
  });
  it("negative control: an attempt that keeps the hedge fails on the habit rule", () => {
    const g = grade(hedge, "I guess the billing export is ready for review today");
    expect(g.pass).toBe(false);
    expect(g.habit).toMatchObject({ hits: 1, found: ["i guess"] });
    expect(g.reasons[0]).toMatch(/^FAIL habit: kept the habit/);
    expect(g.hedgeCount).toBe(1);
  });
  it("a hedge stack card fails on any of its hedges, but other hedges only get reported", () => {
    const stack = en("The release is blocked on the API key from finance.", "hedge", ["kind of", "maybe"]);
    expect(grade(stack, "The release is maybe blocked on the API key from finance").pass).toBe(false);
    const g = grade(stack, "I think the release is blocked on the API key from finance");
    expect(g.pass).toBe(true); // "I think" is not this card's habit (content still >= 80%)
    expect(g.hedges).toEqual(["i think"]);
  });
  it("vague referent: fails on 'that thing', and must name the concrete thing", () => {
    const vague = en("I fixed the invoice retry job this morning.", "vague", ["that thing"], ["invoice", "retry", "job"]);
    expect(grade(vague, "I fixed that thing this morning").pass).toBe(false);
    const missing = grade(vague, "I fixed the retry this morning, the job");
    expect(missing.checks.find((c) => c.rule === "required")).toMatchObject({ ok: false });
    expect(grade(vague, "I fixed the invoice retry job this morning").pass).toBe(true);
  });
  it("vague status: fails on 'getting there' and on lexicon tags like 'and stuff'", () => {
    const status = en("The migration is not done yet: two of the three checks pass.", "vague", ["getting there"], ["two", "three", "checks", "pass"]);
    expect(grade(status, "The migration is getting there, two of the three checks pass").pass).toBe(false);
    expect(grade(status, "The migration is not done yet, two of the three checks pass and stuff").pass).toBe(false);
    expect(grade(status, "The migration is not done yet. Two of the 3 checks pass.").pass).toBe(true);
  });
  it("filler 'like' counts only in filler position", () => {
    const like = en("The dashboard loads slowly on Mondays.", "filler", ["like"]);
    const g = grade(like, "The dashboard, like, loads slowly on Mondays");
    expect(g.pass).toBe(false);
    expect(g.fillers).toEqual(["like"]);
    const ok = en("I would like to ship the dashboard on Monday.", "filler", ["like"]);
    expect(grade(ok, "I would like to ship the dashboard on Monday").pass).toBe(true); // "like to" is not a filler
  });
  it("any filler fails (MAX_FILLERS = 0), even on a hedge card", () => {
    const g = grade(hedge, "Um, the billing export is ready for review today");
    expect(g.pass).toBe(false);
    expect(g.fillerCount).toBe(1);
    expect(g.checks.find((c) => c.rule === "habit")!.ok).toBe(true);
  });
  it("a habit word the target itself needs is not counted", () => {
    const maybe = en("Maybe is not an answer: the deploy is Friday.", "hedge", ["maybe"]);
    expect(grade(maybe, "Maybe is not an answer, the deploy is Friday").pass).toBe(true);
    expect(grade(maybe, "Maybe is not an answer, the deploy is maybe Friday").pass).toBe(false);
  });
  it("restart card fails on an immediate repetition (um/uh ignored)", () => {
    const r = en("We moved the release to Friday afternoon.", "restart");
    expect(grade(r, "We we moved the release to Friday afternoon").pass).toBe(false);
    expect(grade(r, "We moved the, the release to Friday afternoon").habit.hits).toBe(1);
    expect(grade(r, "We moved the release to Friday afternoon").pass).toBe(true);
  });
  it("content below the threshold fails, with the missing words listed", () => {
    const g = grade(hedge, "the export is ready");
    expect(g.contentMatch).toBeLessThan(CONTENT_THRESHOLD);
    expect(g.pass).toBe(false);
    expect(g.missing).toEqual(expect.arrayContaining(["billing", "review", "today"]));
  });
  it("passes through ASR slips and reports them", () => {
    const card = en("Open the drill card on the Rack Board screen.", "filler", ["like"], ["drill", "card"]);
    const g = grade(card, "open the drill car on the rec board screen");
    expect(g.pass).toBe(true);
    expect(g.fuzzy).toEqual([{ target: "card", heard: "car" }, { target: "rack", heard: "rec" }]);
    expect(g.required).toEqual([{ word: "drill", ok: true }, { word: "card", ok: true }]);
  });
  it("curly apostrophes count like straight ones in every habit rule (review M1)", () => {
    const hedgeCard = en("The billing export is ready for review today.", "hedge");
    for (const t of ["I don’t know, the billing export is ready for review today.", "I don't know, the billing export is ready for review today.", "I donʼt know, the billing export is ready for review today."])
      expect(grade(hedgeCard, t).pass, t).toBe(false);
  });
  it("a required word is not satisfied by a different day, month, number or a two-edit word (review H15)", () => {
    const card = (resay: string, must: string[]) => en(resay, "hedge", [], must);
    expect(grade(card("The fix ships on Thursday.", ["thursday"]), "The fix ships on Tuesday.").required).toEqual([{ word: "thursday", ok: false }]);
    expect(grade(card("We ship the release in March.", ["march"]), "We ship the release in match.").required).toEqual([{ word: "march", ok: false }]);
    expect(grade(card("The new release goes out tonight.", ["release"]), "The new relapse goes out tonight.").required).toEqual([{ word: "release", ok: false }]);
    expect(grade(card("Send the invoice to finance today.", ["invoice"]), "Send the invite to finance today.").required).toEqual([{ word: "invoice", ok: false }]);
    expect(grade(card("We need three reviewers.", ["three"]), "We need tree reviewers.").required).toEqual([{ word: "three", ok: false }]);
    expect(grade(card("The fix ships on Thursday.", ["thursday"]), "The fix ships on Thursday.").required).toEqual([{ word: "thursday", ok: true }]);
  });
  it("an empty attempt fails", () => {
    const g = grade(hedge, "   ");
    expect(g.pass).toBe(false);
    expect(g.reasons[0]).toMatch(/FAIL nonempty/);
  });
  it("French error and vocab cards fail when the error or the English word is said again", () => {
    const fr: GradeCard = { lang: "fr", resay: "La maison est grande.", habit: { kind: "error", targets: ["le maison"], label: "FR_GENDER" } };
    expect(grade(fr, "Le maison est grande").pass).toBe(false);
    expect(grade(fr, "La maison est grande").pass).toBe(true);
    const voc: GradeCard = { lang: "fr", resay: "La date limite, c'est vendredi.", habit: { kind: "vocab", targets: ["deadline"], label: "vocab" }, mustSay: ["date", "limite"] };
    expect(grade(voc, "La deadline, c'est vendredi").pass).toBe(false);
    expect(grade(voc, "La date limite c'est vendredi").pass).toBe(true);
    expect(grade(voc, "Euh, la date limite c'est vendredi").fillers).toEqual(["euh"]);
  });
  it("is deterministic: the same card and attempt give the same verdict", () => {
    const a = grade(hedge, "I guess the billing export is ready for review today");
    for (let i = 0; i < 20; i++) expect(grade(hedge, "I guess the billing export is ready for review today")).toEqual(a);
  });
});

describe("card habit derivation (real deck cards)", () => {
  const base = { id: "x", key: "u:1", session: "1", line: "", score: 1, box: 1, due: "2026-10-16", added: "2026-10-15", relapses: 0, lastSeenSession: "1" };
  it("derives hedges, vague phrases, fillers and must-say words", () => {
    const h: Card = { ...base, kind: "error", lang: "en", type: "EN_HEDGE_STACK", said: "I guess it's kind of done", fix: "It's done", resay: "It's done.", why: "" };
    expect(deriveHabit(h)).toMatchObject({ kind: "hedge", targets: ["i guess", "kind of"] });
    const v: Card = { ...base, kind: "error", lang: "en", type: "EN_VAGUE_REFERENT", said: "that thing", fix: "the export job", resay: "I restarted the export job.", why: "" };
    expect(deriveHabit(v)).toMatchObject({ kind: "vague", targets: ["that thing"] });
    expect(deriveMustSay(v)).toEqual(["export", "job"]);
    const f: Card = { ...base, kind: "filler", lang: "en", type: "EN_FILLERS", said: "So, like, um, the build, like, failed", fix: "The build failed", resay: "The build failed.", why: "" };
    expect(deriveHabit(f)).toMatchObject({ kind: "filler", targets: ["like", "um"] });
  });
});

describe("attempt span (Bee merged the attempt with other speech)", () => {
  const T = "The release is blocked on the API key from finance.";
  it("cuts whole sentences with no word of the target", () => {
    expect(attemptSpan(T, "The release is blocked on the API key from finance. How did I do?")).toMatchObject({ graded: "The release is blocked on the API key from finance.", extra: "How did I do?" });
    expect(attemptSpan(T, "Okay, ready. The release is blocked on the API key from finance.")).toMatchObject({ graded: "The release is blocked on the API key from finance.", extra: "Okay, ready." });
  });
  it("a hedge or filler said as its own sentence still fails the habit rule (review H14)", () => {
    const card = { lang: "en" as const, resay: "The deploy finished this morning.", habit: { kind: "hedge" as const, targets: [], label: "hedges" } };
    for (const bee of ["The deploy finished this morning. I guess.", "Maybe. The deploy finished this morning.", "The deploy finished this morning. I guess. How did I do?"]) {
      const span = attemptSpan(card.resay, bee);
      const g = grade(card, span.graded, span.habitText);
      expect(g.pass, bee).toBe(false);
      expect(g.checks.find((c) => c.rule === "habit")!.ok, bee).toBe(false);
      expect(g.contentMatch, bee).toBe(1); // the content rule still reads only the span
    }
    const filler = { lang: "en" as const, resay: "The deploy finished this morning.", habit: { kind: "filler" as const, targets: [], label: "fillers" } };
    const um = attemptSpan(filler.resay, "Um. The deploy finished this morning.");
    expect(grade(filler, um.graded, um.habitText).fillers).toEqual(["um"]);
    // a merged question after the attempt is not a habit
    const ok = attemptSpan(card.resay, "The deploy finished this morning. How did I do?");
    expect(grade(card, ok.graded, ok.habitText).pass).toBe(true);
  });
  it("keeps a habit inside the attempt's own sentence, and keeps unpunctuated text whole", () => {
    expect(attemptSpan(T, "Um, the release is kind of blocked on the API key from finance. How did I do?").graded).toBe("Um, the release is kind of blocked on the API key from finance.");
    expect(attemptSpan(T, "The release is blocked on the API key from finance how did I do").extra).toBe("");
  });
});
