// English communication coaching on meeting caption transcripts (Tactiq / Google Meet .txt exports).
//
//   npm run meetings -- --wearer "<your name as the captions show it>" <file.txt> [more.txt ...]
//   npm run meetings -- --wearer "..." --no-llm <files>        # metrics only (no Bedrock)
//   npm run meetings -- --wearer "..." --glossary <terms.json> <files>   # known misheard terms
//
// Reads transcripts from wherever they are (never copy them into the repo). Only the wearer's
// lines are persisted; other speakers contribute counts only. Outputs (all gitignored):
//   real/meetings.json             wearer-only lines, text-free timelines, analysis
//   out/meetings.md                private coaching report
//   out/meetings-summary.json      aggregates only (what MEETINGS_REPORT.md is built from)
//   out/meetings-label-sample.md   labelling sheet (+ .json key); then `npm run meetings:score`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { callTool, llmLog, usage, type CallToolFn } from "../src/llm/bedrock.js";
import type { LangRates } from "../src/real/analyze.js";
import { buildLabelSample, hits, renderLabelSheet } from "../src/real/meetingLabels.js";
import { renderMeetingsReport, summarizeMeetings } from "../src/real/meetings.js";
import { analyzeCorpus } from "../src/real/pipeline.js";
import { meetingCorpus, parseTactiq } from "../src/real/tactiq.js";

const args = process.argv.slice(2);
const VALUED = new Set(["--wearer", "--glossary", "--tz", "--seed"]);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const files = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));
const wearer = opt("--wearer");
if (!wearer || !files.length) {
  console.error('usage: npm run meetings -- --wearer "<speaker name>" [--no-llm] [--no-verify] [--glossary <terms.json>] [--tz <IANA zone>] <transcript.txt> [...]');
  process.exit(1);
}
const noLlm = args.includes("--no-llm");
const glossaryPath = opt("--glossary");
const glossary: string[] = glossaryPath && existsSync(glossaryPath) ? JSON.parse(readFileSync(glossaryPath, "utf8")) : [];

const inputs = files.map((f) => ({ transcript: parseTactiq(readFileSync(f, "utf8")) }));
const { corpus, timelines, warnings } = meetingCorpus(inputs, { wearer, tz: opt("--tz") ?? process.env.BEE_TZ ?? "America/Toronto" });
for (const w of warnings) console.error(`warning: ${w}`);

// Record every LLM call (cached or not) so the run reports its full cost.
const calls: { label: string; modelId: string; cached: boolean; inputTokens: number; outputTokens: number }[] = [];
const llm: CallToolFn = async (o) => {
  const r = await callTool(o);
  calls.push({ label: o.label, modelId: r.modelId, cached: r.cached, inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 });
  return r;
};
const analysis = await analyzeCorpus(corpus, new Map(), { label: "meetings", llm, noLlm, noVerify: args.includes("--no-verify"), asrGlossary: glossary });
const summary = summarizeMeetings(corpus, timelines, analysis);

// Cross-source comparison: Bee day-1 (out/real-summary.json) and class night (real/class-*.json), when present.
const load = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const bee = load("out/real-summary.json")?.rates?.en as LangRates | undefined;
const klass = load("real/class-2026-10-15.json")?.analysis?.rates?.en as LangRates | undefined;
const um = (r: LangRates) => (r.words ? Math.round((((r.fillerBreakdown["um"] ?? 0) + (r.fillerBreakdown["uh"] ?? 0)) / r.words) * 10000) / 100 : 0);
const like = (r: LangRates) => (r.words ? Math.round(((r.fillerBreakdown["like"] ?? 0) / r.words) * 10000) / 100 : 0);
const sources = [
  ...(bee ? [{ source: "Bee, day-1 conversations (EN)", r: bee }] : []),
  ...(klass ? [{ source: "Bee, class night (EN lines)", r: klass }] : []),
  { source: "Meet captions, 3 stand-ups (pooled)", r: summary.pooled.en },
];
const comparison = [
  "| Source | Words | Fillers /100 | um+uh /100 | like /100 | Hedges /100 |",
  "|---|---|---|---|---|---|",
  ...sources.map((s) => `| ${s.source} | ${s.r.words} | ${s.r.fillersPer100} | ${um(s.r)} | ${like(s.r)} | ${s.r.hedgesPer100} |`),
];

const PRICE: Record<string, [number, number]> = {
  // USD per million input / output tokens (Bedrock on-demand, us-east-1)
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": [1, 5],
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": [3, 15],
  "openai.gpt-oss-120b-1:0": [0.15, 0.6],
};
const cost = (cs: typeof calls) => Math.round(cs.reduce((n, c) => n + ((PRICE[c.modelId]?.[0] ?? 0) * c.inputTokens + (PRICE[c.modelId]?.[1] ?? 0) * c.outputTokens) / 1e6, 0) * 10000) / 10000;
const llmReport = {
  calls: calls.length,
  newCalls: calls.filter((c) => !c.cached).length,
  cacheHits: calls.filter((c) => c.cached).length,
  byModel: calls.reduce<Record<string, number>>((m, c) => ((m[c.modelId] = (m[c.modelId] ?? 0) + 1), m), {}),
  inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
  outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0),
  costUsdAllCalls: cost(calls), // what the benchmark costs from a cold cache
  costUsdThisRun: cost(calls.filter((c) => !c.cached)),
  bedrockAttempts: usage.calls,
  errors: llmLog.filter((e) => e.event !== "model_not_allowed_skipped").length,
  glossaryTerms: glossary.length,
};

const entries = buildLabelSample(analysis.drills, corpus.lines, { seed: opt("--seed") });
const allHits = hits(corpus.lines);
mkdirSync("out", { recursive: true });
mkdirSync("real", { recursive: true });
writeFileSync("real/meetings.json", JSON.stringify({ corpus, timelines, analysis }, null, 1) + "\n");
writeFileSync("out/meetings.md", renderMeetingsReport(summary, corpus, timelines, analysis, { comparison, warnings }));
writeFileSync("out/meetings-summary.json", JSON.stringify({ ...summary, comparison: sources.map((s) => ({ source: s.source, words: s.r.words, fillersPer100: s.r.fillersPer100, umUhPer100: um(s.r), likePer100: like(s.r), hedgesPer100: s.r.hedgesPer100, fillerBreakdown: s.r.fillerBreakdown })), llm: llmReport }, null, 1) + "\n");
writeFileSync("out/meetings-label-sample.md", renderLabelSheet(entries, { meetings: summary.meetings.map((m) => m.id), hitsTotal: { filler: allHits.filter((x) => x.group === "filler").length, hedge: allHits.filter((x) => x.group === "hedge").length } }));
writeFileSync("out/meetings-label-sample.json", JSON.stringify(entries.map(({ id, group, type, key, session }) => ({ id, group, type, key, session })), null, 1) + "\n");

// Console: aggregates only.
const fmt = (m: (typeof summary.meetings)[0]) =>
  `${m.id.padEnd(16)} words ${String(m.en.words).padStart(4)}  fillers/100 ${String(m.en.fillersPer100).padStart(5)} [${m.fillersCi95.join("–")}]  hedges/100 ${String(m.en.hedgesPer100).padStart(4)}  talk ${m.talk.talkShareWords}%  turns ${m.talk.turns}  kept drills ${m.funnel.kept}`;
for (const m of [...summary.meetings, summary.pooled]) console.log(fmt(m));
console.log(`Funnel (pooled): ${JSON.stringify(summary.pooled.funnel)}`);
console.log(`LLM: ${JSON.stringify(llmReport)}`);
console.log(`Label sheet: ${entries.length} entries (${entries.filter((e) => e.group === "drill").length} drills, ${entries.filter((e) => e.group !== "drill").length} filler/hedge hits).`);
console.log("Wrote real/meetings.json, out/meetings.md, out/meetings-summary.json, out/meetings-label-sample.md (+ .json)");
