// The phone page uses the TV's palette (tv/web/src/theme.ts): the meaning colours (lime, coral, the
// bee colour, paper and ink) and each habit's hue on Progress. theme.ts imports react-native, so it
// is read as text here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const theme = readFileSync("tv/web/src/theme.ts", "utf8");
const css = readFileSync("web/phone/src/style.css", "utf8");
const tv = (name: string) => new RegExp(`\\b${name}: '(#[0-9a-f]{6})'`, "i").exec(theme)?.[1]?.toLowerCase();
const cssVar = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1]?.toLowerCase();
const rule = (selector: string) => new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("phone palette = the TV's", () => {
  it("meaning colours", () => {
    const root = rule(":root");
    for (const [v, c] of [["bee", "bee"], ["bee-ink", "beeInk"], ["lime", "lime"], ["lime-ink", "limeInk"], ["coral", "coral"], ["coral-ink", "coralInk"], ["paper", "paper"], ["ink", "ink"], ["bg", "bg"], ["surface", "surface"]] as const) {
      expect(tv(c), c).toMatch(/^#/);
      expect(cssVar(root, v), v).toBe(tv(c));
    }
  });
  it("each habit's hue and tint on Progress", () => {
    const hue = (key: string) => {
      const m = new RegExp(`${key}: \\{ hue: '(#[0-9a-f]{6})', tint: '(#[0-9a-f]{6})'`, "i").exec(theme);
      return m ? { hue: m[1]!.toLowerCase(), tint: m[2]!.toLowerCase() } : null;
    };
    for (const [cls, key] of [["hue-hedges", "hedges"], ["hue-fillers", "fillers"], ["hue-vague", "vague"], ["hue-restart", "restart"]] as const) {
      const want = hue(key);
      expect(want, key).not.toBeNull();
      const block = rule(`.${cls}`);
      expect({ hue: cssVar(block, "hue"), tint: cssVar(block, "tint") }, cls).toEqual(want);
    }
    // "filler:like" shares the fillers hue on the TV, and the phone uses one class for both
    expect(hue("'filler:like'")).toEqual(hue("fillers"));
  });
});
