// The analyzer must never see the hidden truth key or the simulator internals.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));

describe("truth isolation", () => {
  for (const dir of ["src/analyze", "src/bee", "src/coach", "src/llm"])
    for (const f of files(dir))
      it(`${f} does not read _truth, the simulator or the evaluator`, () => {
        const s = readFileSync(f, "utf8");
        expect(s).not.toMatch(/_truth/);
        expect(s).not.toMatch(/from "\.\.\/sim\//);
        expect(s).not.toMatch(/from "\.\.\/eval\//);
      });
  it("only src/eval reads fixtures/_truth", () => {
    const readers = files("src").filter((f) => /readFileSync\([^)]*_truth/.test(readFileSync(f, "utf8")) || readFileSync(f, "utf8").includes("fixtures/_truth/${"));
    expect(readers).toEqual([join("src", "eval", "score.ts")]);
  });
});
