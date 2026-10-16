// Meeting-transcript (Tactiq / Meet captions) ingest, talk-habit metrics, glossary guard, the
// labelling sheet and the meetings privacy contract. Synthetic inputs only (invented names and
// text); no LLM (stub), no files read.
import { describe, expect, it } from "vitest";
import type { CallToolFn } from "../src/llm/bedrock.js";
import { applyGlossary, usableItem, type RealItem } from "../src/real/analyze.js";
import { buildLabelSample, hits, parseMarks, renderLabelSheet, scoreMarks } from "../src/real/meetingLabels.js";
import { renderMeetingsReport, summarizeMeetings } from "../src/real/meetings.js";
import { analyzeCorpus } from "../src/real/pipeline.js";
import { meetingCorpus, parseTactiq, zonedToEpoch } from "../src/real/tactiq.js";
import { endsOnTail, rateCi95, sentenceKind, talkMetrics, VAGUE_RE_EN, YEAH_TIC_RE } from "../src/real/talk.js";
import { countRe, stripFillers } from "../src/real/text.js";

const SECRET = "OTHERSPEAKERSECRET";
const FIXTURE = `# Weekly Lighthouse huddle

  Meeting started: 9/22/2026, 11:58:00 AM
  Duration: 12 minutes
  Participants: Grace Hopper, Ada Mae Lovelace, Alan Turing

  [View original transcript](https://example.invalid/t?o=txt)

    ## Highlights

    > 00:05 Grace Hopper: Morning all, ${SECRET} quick round today.
> 00:40 Ada Mae Lovelace: Um, the export, the export is kind of done I guess, and stuff.

  ## Transcript

  00:05 Grace Hopper: Morning all, ${SECRET} quick round today.
00:20 Alan Turing: Yes. ${SECRET} the parser shipped: two fixes left.
00:40 Ada Mae Lovelace: Um, the export, the export is kind of done I guess, and stuff.
00:55 Ada Mae Lovelace: Like, the main gap is the, uh, the retry. Can someone review it? And yeah.
continued caption line after a wrap
01:30 Grace Hopper: Thanks ${SECRET}.
01:31 ada mae  lovelace: Yeah.
1:02:03 Alan Turing: Late note ${SECRET}.
`;

describe("Tactiq transcript parser", () => {
  const t = parseTactiq(FIXTURE);
  it("reads the header and the transcript section only (Highlights are not double-counted)", () => {
    expect(t.durationMin).toBe(12);
    expect(t.participants).toHaveLength(3);
    expect(t.startedLocal).toEqual({ y: 2026, mo: 9, d: 22, h: 11, mi: 58, s: 0 });
    expect(t.source).toBe("transcript-section");
    expect(t.highlightLines).toBe(2);
    expect(t.lines).toHaveLength(7);
    expect(t.lines.filter((l) => l.speaker === "Ada Mae Lovelace")).toHaveLength(2);
  });
  it("parses hh:mm:ss, keeps colons inside the text and joins wrapped caption lines", () => {
    expect(t.lines.at(-1)).toMatchObject({ sec: 3723, speaker: "Alan Turing" });
    expect(t.lines[1]!.text).toContain("shipped: two fixes left");
    expect(t.lines[3]!.text).toMatch(/And yeah\. continued caption line after a wrap$/);
  });
  it("without a Transcript section, drops highlight repeats (including truncated ones)", () => {
    const noSection = FIXTURE.replace("  ## Transcript\n", "").replace("> 00:40 Ada Mae Lovelace: Um, the export, the export is kind of done I guess, and stuff.", "> 00:40 Ada Mae Lovelace: Um, the export, the export");
    const p = parseTactiq(noSection);
    expect(p.source).toBe("deduped-all");
    expect(p.lines).toHaveLength(7);
    expect(p.lines.find((l) => l.sec === 40)!.text).toMatch(/and stuff\.$/); // the longer version wins
  });
  it("converts the local start time in the configured zone (EDT here)", () => {
    expect(new Date(zonedToEpoch(t.startedLocal!, "America/Toronto")).toISOString()).toBe("2026-09-22T15:58:00.000Z");
    expect(new Date(zonedToEpoch({ y: 2026, mo: 12, d: 1, h: 9, mi: 0, s: 0 }, "America/Toronto")).toISOString()).toBe("2026-12-01T14:00:00.000Z"); // EST
  });
});

describe("meeting corpus (privacy boundary)", () => {
  const { corpus, timelines, warnings } = meetingCorpus([{ transcript: parseTactiq(FIXTURE) }], { wearer: "Ada Mae Lovelace" });
  it("keeps the configured speaker's lines only (case/space-insensitive), with neutral ids", () => {
    expect(corpus.lines.map((l) => l.key)).toEqual(["m:meet-2026-09-22:2", "m:meet-2026-09-22:3", "m:meet-2026-09-22:5"]);
    expect(corpus.lines.every((l) => l.kind === "meeting" && !l.uncertain && l.dom === "en")).toBe(true);
    expect(corpus.lines[0]).toMatchObject({ start: 40, end: 55 });
    expect(corpus.sessions[0]).toMatchObject({ id: "meet-2026-09-22", kind: "meeting", totalLines: 7, wearerLines: 3 });
    expect(warnings).toEqual([]);
  });
  it("persists no other speaker's text or name, no title and no participant list", () => {
    const blob = JSON.stringify({ corpus, timelines });
    for (const s of [SECRET, "Grace", "Hopper", "Turing", "Lighthouse"]) expect(blob).not.toContain(s);
    expect(corpus.wearer.counts).toEqual({ WEARER: 3, OTHER: 4 });
    expect(timelines[0]).toMatchObject({ speakers: 3, highlightLinesSkipped: 2 });
  });
  it("warns when the configured speaker never speaks", () => {
    expect(meetingCorpus([{ transcript: parseTactiq(FIXTURE) }], { wearer: "Nobody Here" }).warnings[0]).toMatch(/no lines from the configured speaker/);
  });
});

describe("talk-habit metrics", () => {
  const { corpus, timelines } = meetingCorpus([{ transcript: parseTactiq(FIXTURE) }], { wearer: "Ada Mae Lovelace" });
  const m = talkMetrics(timelines, corpus.lines);
  it("merges consecutive wearer lines into turns and computes talk share", () => {
    expect(m.turns).toBe(2);
    expect(m.substantiveTurns).toBe(1);
    expect(m.backchannels).toBe(1);
    expect(m.longestTurnWords).toBe(m.wearerWords - 1);
    expect(m.longestTurnSec).toBe(90 - 40);
    expect(m.totalWords - m.wearerWords).toBe(6 + 8 + 2 + 3); // other speakers: counts only
    expect(m.talkShareWords).toBe(Math.round((m.wearerWords / m.totalWords) * 1000) / 10);
    expect(m.questions).toBe(1);
    expect(m.yeahTics).toBe(1);
    expect(m.vague).toBe(1); // "and stuff"
    expect(m.restarts).toBeGreaterThanOrEqual(2); // "the export, the export" and "the, uh, the"
  });
  it("classifies sentences and turn endings", () => {
    expect(sentenceKind("So, can you share the numbers?")).toBe("question");
    expect(sentenceKind("That's a product change, right?")).toBe("tag");
    expect(sentenceKind("The survey features?")).toBe("uptalk");
    expect(sentenceKind("Then the build went to.")).toBe("trailing");
    expect(sentenceKind("We shipped it.")).toBe("statement");
    expect(endsOnTail("We shipped the export today, and yeah.")).toBe(true);
    expect(endsOnTail("We shipped the export today.")).toBe(false);
    expect(countRe("So yeah, and yeah but yeah", YEAH_TIC_RE)).toBe(3);
    expect(countRe("tokens and stuff, or something like that, stuff like that", VAGUE_RE_EN)).toBe(3);
  });
  it("gives a 95% interval around a per-100 rate", () => {
    const [lo, hi] = rateCi95(10, 200);
    expect(lo).toBeLessThan(5);
    expect(hi).toBeGreaterThan(5);
    expect(rateCi95(0, 100)[0]).toBe(0);
  });
});

describe("glossary guard, filler cleanup", () => {
  it("quarantines items whose excerpt or correction carries a known misheard term", () => {
    const base = { key: "m:x:1", session: "x", kind: "meeting" as const, lang: "en" as const, error_type: "EN_VAGUE_STATUS", resay_prompt: "", explanation: "", asr_suspect: false, citation_valid: true, excerpt_grounded: true, line: "", verified: true };
    const items: RealItem[] = [
      { ...base, excerpt: "we tried Blorp on it", correction: "we tried <tool> on it" },
      { ...base, excerpt: "it is kind of done", correction: "it is done" },
    ];
    expect(applyGlossary(items, ["blorp", "zz top"])).toBe(1);
    expect(items.map(usableItem)).toEqual([false, true]);
  });
  it("leaves no punctuation debris where fillers were removed", () => {
    expect(stripFillers("We paused. Uh, a sprint. It goes, like, uh, straight through", "en")).toBe("We paused. a sprint. It goes, straight through");
  });
});

describe("meetings pipeline and labelling sheet (stub LLM)", () => {
  const { corpus, timelines } = meetingCorpus([{ transcript: parseTactiq(FIXTURE) }], { wearer: "Ada Mae Lovelace" });
  const prompts: string[] = [];
  const stub: CallToolFn = async (o) => {
    prompts.push(o.system + o.user);
    const name = o.tool.toolSpec!.name;
    if (name === "report_errors")
      return { modelId: "stub", cached: false, input: { asr_suspects: [], items: [{ utterance_id: "m:meet-2026-09-22:2", error_type: "EN_HEDGE_STACK", excerpt: "the export is kind of done I guess", correction: "the export is done", resay_prompt: "The export is done.", explanation: "two hedges", asr_suspect: false }] } };
    if (name === "audit_items") return { modelId: "stub", cached: false, input: { verdicts: [{ index: 0, verdict: "real_error", reason: "ok" }] } };
    return { modelId: "stub", cached: false, input: { moments: [] } };
  };
  it("runs the English funnel, labels and scores, with no other-speaker text anywhere", async () => {
    const a = await analyzeCorpus(corpus, new Map(), { label: "t", llm: stub });
    expect(prompts.join("\n")).toContain("video meeting");
    for (const p of prompts) expect(p).not.toContain(SECRET);
    const s = summarizeMeetings(corpus, timelines, a);
    expect(s.pooled.funnel).toMatchObject({ candidates: 1, passedGuard: 1, verifierKept: 1, kept: 1 });
    expect(s.meetings[0]!.en.fillerBreakdown).toEqual({ um: 1, like: 1, uh: 1 });
    expect(s.trend.find((t) => t.metric.startsWith("Fillers"))!.note).toMatch(/no trend claim/);
    const entries = buildLabelSample(a.drills, corpus.lines);
    expect(entries.filter((e) => e.group === "drill")).toHaveLength(1);
    expect(entries.filter((e) => e.group !== "drill")).toHaveLength(hits(corpus.lines).length); // fewer hits than the sample size
    const sheet = renderLabelSheet(entries, { meetings: ["meet-2026-09-22"], hitsTotal: { filler: 3, hedge: 2 } });
    const md = renderMeetingsReport(s, corpus, timelines, a);
    for (const out of [sheet, md, JSON.stringify(s), JSON.stringify(a)]) for (const x of [SECRET, "Grace", "Turing", "Lighthouse"]) expect(out).not.toContain(x);
    expect(sheet).toContain("«the export is kind of done I guess»");
    const marked = sheet.replace("- Mark: [ ]", "- Mark: [R]").replace("- Mark: [ ]", "- Mark: [t]").replace("- Mark: [ ]", "- Mark: [N]");
    const sc = scoreMarks(entries, parseMarks(marked));
    expect(sc.drills).toMatchObject({ labelled: 1, R: 1, precision: 100 });
    expect(sc.all).toMatchObject({ labelled: 3, R: 1, T: 1, N: 1, precision: 33.3, artifactRate: 33.3 });
  });
  it("samples hits deterministically and caps them at 10 fillers + 5 hedges", () => {
    const many = corpus.lines.map((l, i) => ({ ...l, key: `m:z:${i}`, text: "um uh like, I think maybe um uh um uh I guess probably um uh" }));
    const a1 = buildLabelSample([], many);
    expect(a1.filter((e) => e.group === "filler")).toHaveLength(10);
    expect(a1.filter((e) => e.group === "hedge")).toHaveLength(5);
    expect(buildLabelSample([], many).map((e) => `${e.key}${e.context}`)).toEqual(a1.map((e) => `${e.key}${e.context}`));
  });
});
