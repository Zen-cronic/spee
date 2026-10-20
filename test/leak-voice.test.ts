// The product-voice ledger (scripts/leak-voice.ts): only a phrase the product itself says can be
// approved (another copy file's literal, or this file's own literals from before the recording;
// never the file as it is now, and never demo data or fixtures), the approval is pinned to the file's
// exact content, and the ledger holds hashes only. Synthetic text only.
import { describe, expect, it } from "vitest";
import { classifyVoice, commitBefore, copyPhrasesByOrigin, formatVoiceLedger, isCopyEvidence, literalTexts, parseFileCommits, parseVoiceLedger, phraseHash, productPhrases, productVoice, voiceOrigin } from "../scripts/leak-voice.js";

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
    expect(["web/sim/src/router.ts", "src/alexa/speech.ts", "src/hub/habitNames.ts", "src/hub/live/recap.ts", "tv/vega/src/views/LiveView.tsx"].every(isCopyEvidence)).toBe(true);
    expect(["src/hub/demoData.ts", "src/hub/live/demoScripts.ts", "src/hub/contractExamples.ts", "fixtures/demo/sessions.json", "alexa/fixtures/x.json", "test/x.test.ts", "docs/x.md", "src/hub/stats.ts"].some(isCopyEvidence)).toBe(false);
    expect(voiceOrigin("tv/vega/src/mirror/format.ts")).toBe(voiceOrigin("tv/web/src/mirror/format.ts"));
  });
});

describe("what counts as the product's own copy", () => {
  // another speaker's (synthetic) line pasted into a demo-data string literal
  const PASTED = 'const LINES = ["the zebra orchid passcode is 4417 today"];';
  const hits = ["the zebra orchid passcode is", "zebra orchid passcode is 4417"];
  it("a phrase pasted into a literal never vouches for itself, in its own file or in its synced copy", () => {
    const copy = copyPhrasesByOrigin([{ path: "src/alexa/skill.ts", text: SKILL }], words);
    const own = productVoice("src/hub/demoData.ts", copy, () => null);
    expect(classifyVoice("sha  src/hub/demoData.ts", hits, new Map(), own)).toEqual({ approved: [], approvable: [], other: hits });
    // pasted into a copy file: its own literal is not evidence, nor the tv-sync twin of it
    const twin = copyPhrasesByOrigin([{ path: "tv/web/src/views/LiveView.tsx", text: PASTED }, { path: "tv/vega/src/views/LiveView.tsx", text: PASTED }], words);
    expect(classifyVoice("sha  tv/web/src/views/LiveView.tsx", hits, new Map(), productVoice("tv/web/src/views/LiveView.tsx", twin, () => null)).other).toEqual(hits);
    // demo data is never evidence for another file either (isCopyEvidence filters it before copyPhrasesByOrigin)
    expect(isCopyEvidence("src/hub/demoData.ts")).toBe(false);
  });
  it("the synthetic Bee world (invented other-speaker lines) is never the product's voice; the dialog simulator is", () => {
    expect(["src/sim/templates.ts", "src/sim/world.ts", "src/sim/x/y.ts"].some(isCopyEvidence)).toBe(false);
    expect(["web/sim/src/router.ts", "web/sim/index.html"].every(isCopyEvidence)).toBe(true);
  });
  it("another copy file's literal, or this file's literals from before the recording, is evidence", () => {
    const copy = copyPhrasesByOrigin([{ path: "src/alexa/skill.ts", text: SKILL }], words);
    expect(productVoice("src/hub/live/engine.ts", copy, () => null)("you can also ask how")).toBe(true);
    expect(productVoice("src/alexa/skill.ts", copy, () => null)("you can also ask how")).toBe(false); // only itself says it
    const before = productPhrases([{ path: "src/alexa/skill.ts", text: SKILL }], words);
    expect(productVoice("src/alexa/skill.ts", copy, () => before)("you can also ask how")).toBe(true);
  });
});

describe("the ledger", () => {
  const sha = "a".repeat(64);
  const key = `${sha}  src/alexa/skill.ts`;
  const phrases = productPhrases([{ path: "src/alexa/skill.ts", text: SKILL }], words);
  const said = (g: string) => phrases.has(g);
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
    expect(classifyVoice(key, ["you can also ask how"], ledger, () => false).other).toEqual(["you can also ask how"]);
  });
  it("ignores comments, blank and malformed lines", () => {
    expect(parseVoiceLedger("# note\n\nnot a line\nabc  x  y\n").size).toBe(0);
  });
});

describe("a file's commit before a recording", () => {
  it("is picked from one listing of the file's commits, as git log -1 --before would", () => {
    const log = `${"c".repeat(40)}\u00001760900000\n${"b".repeat(40)}\u00001760800000\n${"a".repeat(40)}\u00001760700000\n\n`;
    const commits = parseFileCommits(log);
    expect(commits.map((c) => c.hash[0])).toEqual(["c", "b", "a"]);
    expect(commitBefore(commits, 1760850000_000)).toBe("b".repeat(40));
    expect(commitBefore(commits, 1760900000_000)).toBe("c".repeat(40)); // at the commit's own second
    expect(commitBefore(commits, 1760999999_000)).toBe("c".repeat(40));
    expect(commitBefore(commits, 1760600000_000)).toBeNull(); // before the file's first commit
    expect(parseFileCommits("not a line\n")).toEqual([]);
  });
});
