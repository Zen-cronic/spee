// The product-voice ledger (scripts/leak-voice.ts): only a phrase the product itself says in a string
// literal can be approved, the approval is pinned to the file's exact content, and the ledger holds
// hashes only. Synthetic text only.
import { describe, expect, it } from "vitest";
import { classifyVoice, formatVoiceLedger, literalTexts, parseVoiceLedger, phraseHash, PRODUCT_SOURCE_RE, productPhrases } from "../scripts/leak-voice.js";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(" ").filter(Boolean);
const SKILL = `export const SPEECH = { help: "You can also ask how am I doing, or say quiz me.", again: \`Say it again: \${line}. Then ask how did I do.\` };`;
const HTML = `<p class="hint">Ask how did I do after each line.</p><script>const x = "never shown";</script>`;

describe("the product's own phrases", () => {
  it("come from string literals and an HTML page's text, never across a placeholder", () => {
    expect(literalTexts(SKILL)).toEqual(["You can also ask how am I doing, or say quiz me.", "Say it again: ", ". Then ask how did I do."]);
    expect(literalTexts(HTML, true)).toContain("Ask how did I do after each line.");
    const said = productPhrases([{ path: "src/alexa/skill.ts", text: SKILL }, { path: "web/sim/index.html", text: HTML }], words);
    expect(said.has("you can also ask how")).toBe(true);
    expect(said.has("ask how did i do")).toBe(true);
    expect(said.has("again then ask how")).toBe(false); // a placeholder breaks the text
    expect(PRODUCT_SOURCE_RE.test("web/sim/src/router.ts") && PRODUCT_SOURCE_RE.test("web/hub/index.html") && !PRODUCT_SOURCE_RE.test("test/x.test.ts") && !PRODUCT_SOURCE_RE.test("docs/x.md")).toBe(true);
  });
});

describe("the ledger", () => {
  const sha = "a".repeat(64);
  const key = `${sha}  src/alexa/skill.ts`;
  const said = productPhrases([{ path: "src/alexa/skill.ts", text: SKILL }], words);
  it("approves only the product's phrases, only for that exact file content, and stores hashes only", () => {
    const hits = ["you can also ask how", "the zebra orchid is due"];
    expect(classifyVoice(key, hits, new Map(), said)).toEqual({ approved: [], approvable: ["you can also ask how"], other: ["the zebra orchid is due"] });
    const text = formatVoiceLedger([{ sha, path: "src/alexa/skill.ts", phrases: new Set([phraseHash("you can also ask how")]) }]);
    expect(text).not.toContain("you can also ask how");
    const ledger = parseVoiceLedger(text);
    expect(classifyVoice(key, ["you can also ask how"], ledger, said)).toEqual({ approved: ["you can also ask how"], approvable: [], other: [] });
    // the file changed: its sha256 differs, so the hit is flagged again
    expect(classifyVoice(`${"b".repeat(64)}  src/alexa/skill.ts`, ["you can also ask how"], ledger, said).approved).toEqual([]);
    // a phrase the product no longer says is not set aside, even if it was approved before
    expect(classifyVoice(key, ["you can also ask how"], ledger, new Set()).other).toEqual(["you can also ask how"]);
  });
  it("ignores comments, blank and malformed lines", () => {
    expect(parseVoiceLedger("# note\n\nnot a line\nabc  x  y\n").size).toBe(0);
  });
});
