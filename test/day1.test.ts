// Kill test 2 scorer against the synthetic journal fixture and edge cases.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JournalGetResponseSchema } from "../src/bee/schemas.js";
import { coachCoverage, fold, PLANTED, scoreDay1 } from "../src/real/day1.js";

const SCRIPT = readFileSync("day1/french-voice-note-script.md", "utf8").split("## Script (read this aloud)")[1]!.split("## Answer key")[0]!.trim();

describe("day-1 scorer", () => {
  it("the script itself scores 10/10 SURVIVED and 4/4 fillers", () => {
    const s = scoreDay1(SCRIPT);
    expect(s.errors.map((e) => e.status)).toEqual(Array(10).fill("SURVIVED"));
    expect(s.fillersKept).toBe(4);
    expect(s.pass).toBe(true);
  });
  it("a fully corrected transcript scores 10/10 CORRECTED and fails", () => {
    const fixed = "J'ai trente ans et j'habite à Toronto. J'étudie le français depuis deux ans. Je suis allée à mon cours. Le problème, c'est ça. Je vais faire du sport. C'est un exercice difficile. Beaucoup de légumes. Si j'avais plus de temps. J'ai hâte de passer mon examen.";
    const s = scoreDay1(fixed);
    expect(s.corrected).toBe(10);
    expect(s.pass).toBe(false);
    expect(s.fillersKept).toBe(0);
  });
  it("missing phrases are GARBLED; Bee-style um/uh count as fillers", () => {
    const s = scoreDay1("Um bonjour uh, aujourd'hui rien de spécial.");
    expect(s.garbled).toBe(10);
    expect(s.fillerTokens).toEqual(["um", "uh"]);
  });
  it("folds accents, curly apostrophes and punctuation", () => {
    expect(fold("Si J’aurais, À Toronto!")).toBe("si j'aurais a toronto");
  });
  it("the synthetic journal fixture matches the live journal schema and scores 9/10", () => {
    const j = JournalGetResponseSchema.parse(JSON.parse(readFileSync("fixtures/synthetic/day1-journal.json", "utf8")));
    const s = scoreDay1(j.text!);
    expect(s.survived).toBe(9);
    expect(s.errors.find((e) => e.id === "E2")!.status).toBe("CORRECTED");
    expect(scoreDay1(j.aiResponse!.cleanedUpText!).survived).toBe(0);
  });
  it("coach coverage matches items to planted errors by excerpt overlap", () => {
    const s = scoreDay1(SCRIPT);
    const cov = coachCoverage(s, [{ excerpt: "la problème", error_type: "FR_GENDER" }, { excerpt: "excité pour", error_type: "FR_ANGLICISM" }]);
    expect(cov.filter((c) => c.flagged).map((c) => c.id)).toEqual(["E5", "E10"]);
    expect(PLANTED).toHaveLength(10);
  });
  it("the CLI scores a saved journal offline", () => {
    const out = execFileSync("npx", ["tsx", "scripts/score-day1.ts", "--file", "fixtures/synthetic/day1-journal.json"], { encoding: "utf8" });
    expect(out).toContain("KILL TEST 2: PASS");
    expect(out).toContain("9 SURVIVED, 1 CORRECTED, 0 GARBLED");
  }, 30_000);
});
