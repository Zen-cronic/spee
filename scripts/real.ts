// Full real-data run over every Bee conversation (and voice note) the CLI returns.
//
//   npm run real                      # all conversations
//   npm run real -- --ids 11292222    # a subset
//   npm run real -- --no-llm          # metrics + mislabel only (no Bedrock)
//
// Persists wearer lines only, to gitignored paths:
//   real/corpus.json          wearer-only line store (+ per-session counts)
//   out/real-analysis.json    metrics, LLM items, vocab moments, drills, baseline, specificity
//   out/mislabel-sample.md    blind labelling sheet (+ out/mislabel-sample.json with verdicts)
//   out/real-summary.json     aggregates only (what REAL_DATA_REPORT.md is built from)
import { mkdirSync, writeFileSync } from "node:fs";
import { CliBeeSource } from "../src/bee/source.js";
import { usage, llmLog } from "../src/llm/bedrock.js";
import { usableItem } from "../src/real/analyze.js";
import { loadRealCorpus } from "../src/real/corpus.js";
import { sampleForLabelling } from "../src/real/mislabelScore.js";
import { analyzeCorpus, genericBaseline, specificity } from "../src/real/pipeline.js";
import { renderMislabelSample } from "../src/real/render.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const ids = opt("--ids")?.split(",").map(Number);
const noLlm = args.includes("--no-llm");

const src = new CliBeeSource();
const { corpus, context } = await loadRealCorpus(src, { ids });
mkdirSync("real", { recursive: true, mode: 0o700 });
mkdirSync("out", { recursive: true });
writeFileSync("real/corpus.json", JSON.stringify(corpus, null, 1) + "\n", { mode: 0o600 }); // real speech: owner only

console.log(`Wearer labels: ${corpus.wearer.labels.length} (${corpus.wearer.method})${corpus.wearer.note ? `; ${corpus.wearer.note}` : ""}`);
for (const s of corpus.sessions)
  console.log(`  ${s.kind} ${s.id} ${s.state}: ${s.wearerLines}/${s.totalLines} wearer (${Math.round(s.wearerShare * 100)}%), ${s.uncertainLines} flagged${s.skipped ? ` [skipped: ${s.skipped}]` : ""}`);

const sample = sampleForLabelling(corpus.lines.filter((l) => l.kind === "conversation"));
writeFileSync("out/mislabel-sample.md", renderMislabelSample(sample));
writeFileSync("out/mislabel-sample.json", JSON.stringify(sample.map((l) => ({ key: l.key, session: l.session, uncertain: l.uncertain, score: l.mislabelScore, reasons: l.reasons })), null, 1) + "\n");

const analysis = await analyzeCorpus(corpus, context, { label: "real", noLlm });
const baselines = [];
if (!noLlm) for (const lang of ["fr", "en"] as const) baselines.push({ lang, ...(await genericBaseline(corpus.lines, lang, { label: "real" })) });
const spec = specificity(analysis, baselines, corpus.lines);
writeFileSync("out/real-analysis.json", JSON.stringify({ corpus: { sessions: corpus.sessions, wearer: corpus.wearer }, analysis, baselines, specificity: spec }, null, 1) + "\n");

const usable = analysis.items.filter(usableItem);
const byType: Record<string, number> = {};
for (const i of usable) byType[i.error_type] = (byType[i.error_type] ?? 0) + 1;
const summary = {
  generatedAt: new Date().toISOString(),
  wearerMethod: corpus.wearer.method,
  // Label names are reduced to WEARER (summed over the wearer's labels) / other labels.
  labelCounts: Object.entries(corpus.wearer.counts).reduce<Record<string, number>>((m, [k, v]) => {
    const key = corpus.wearer.labels.includes(k) ? "WEARER" : k;
    m[key] = (m[key] ?? 0) + v;
    return m;
  }, {}),
  sessions: corpus.sessions.map((s) => ({ id: s.id, kind: s.kind, state: s.state, total: s.totalLines, wearer: s.wearerLines, flagged: s.uncertainLines, share: s.wearerShare, skipped: !!s.skipped })),
  lines: { wearer: corpus.lines.length, flagged: corpus.lines.filter((l) => l.uncertain).length, coachable: corpus.lines.filter((l) => !l.uncertain).length },
  langLines: corpus.lines.reduce<Record<string, number>>((m, l) => ((m[l.lang] = (m[l.lang] ?? 0) + 1), m), {}),
  rates: analysis.rates,
  ratesAllWearerLabelled: analysis.ratesAllWearerLabelled,
  items: { total: analysis.items.length, usable: usable.length, asrSuspect: analysis.items.filter((i) => i.asr_suspect).length, ungrounded: analysis.items.filter((i) => !i.excerpt_grounded || !i.citation_valid).length, rejected: analysis.rejected, byType },
  vocab: { total: analysis.vocab.length, grounded: analysis.vocab.filter((v) => v.grounded).length, asked: analysis.vocab.filter((v) => v.trigger === "asked").length },
  drills: analysis.drills.reduce<Record<string, number>>((m, d) => ((m[d.kind] = (m[d.kind] ?? 0) + 1), m), {}),
  specificity: spec,
  models: analysis.models,
  llmUsage: usage,
  llmErrors: llmLog.filter((e) => e.event !== "model_not_allowed_skipped").length,
};
writeFileSync("out/real-summary.json", JSON.stringify(summary, null, 1) + "\n");
console.log(JSON.stringify({ lines: summary.lines, rates: { fr: analysis.rates.fr.fillersPer100, en: analysis.rates.en.fillersPer100 }, items: summary.items, vocab: summary.vocab, drills: summary.drills, specificity: spec, models: summary.models }, null, 1));
console.log("Wrote real/corpus.json, out/real-analysis.json, out/real-summary.json, out/mislabel-sample.md");
