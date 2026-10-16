// Shared real-data pipeline: corpus -> metrics, LLM items, code-switch vocab, drills, baseline.
import { z } from "zod";
import { callTool as bedrockCallTool, type CallToolFn } from "../llm/bedrock.js";
import { applyGlossary, buildDrills, coachable, extractCodeSwitches, extractRealItems, rates, usableItem, verifyItems, type CodeSwitch, type Drill, type LangRates, type RealItem } from "./analyze.js";
import type { RealCorpus, TransientContext, WearerLine } from "./corpus.js";

export interface Analysis {
  rates: Record<"fr" | "en", LangRates>;
  ratesAllWearerLabelled: Record<"fr" | "en", LangRates>; // incl. uncertain lines, for comparison
  items: RealItem[];
  rejected: number;
  vocab: CodeSwitch[];
  drills: Drill[];
  models: Record<string, number>;
}

export async function analyzeCorpus(corpus: RealCorpus, ctx: TransientContext, opts: { label: string; llm?: CallToolFn; noLlm?: boolean; noVerify?: boolean; asrGlossary?: string[] }): Promise<Analysis> {
  const lines = corpus.lines;
  const ok = lines.filter(coachable);
  const models: Record<string, number> = {};
  let items: RealItem[] = [];
  let rejected = 0;
  let vocab: CodeSwitch[] = [];
  if (!opts.noLlm) {
    // Sequential on purpose: the account throttles.
    const r = await extractRealItems(ok, { label: opts.label, llm: opts.llm });
    items = r.items;
    rejected = r.rejected;
    for (const m of r.models) models[m] = (models[m] ?? 0) + 1;
    if (!opts.noVerify) for (const m of (await verifyItems(items, { label: opts.label, llm: opts.llm })).models) models[m] = (models[m] ?? 0) + 1;
    // After verification, so the report can show how many verifier-kept items carried a known mishearing.
    if (opts.asrGlossary?.length) applyGlossary(items, opts.asrGlossary);
    const v = await extractCodeSwitches(ok, ctx, { label: opts.label, llm: opts.llm });
    vocab = v.moments;
    for (const m of v.models) models[m] = (models[m] ?? 0) + 1;
  }
  return { rates: rates(ok), ratesAllWearerLabelled: rates(lines), items, rejected, vocab, drills: buildDrills(items, vocab, ok), models };
}

// Generic comparator: Bee "Daily Insights"-style coaching from the same wearer lines.
export async function genericBaseline(lines: WearerLine[], lang: "fr" | "en", opts: { label: string; llm?: CallToolFn }) {
  const llm = opts.llm ?? bedrockCallTool;
  const ls = lines.filter((l) => coachable(l) && l.dom === lang);
  const system =
    "You are the AI assistant inside a wearable that records the user's day. Write today's Daily Insights about how the user communicates, like a supportive personal coach. Give 3 to 5 insights, each with a short suggestion.";
  const user = [`Today's transcripts of the user's own speech. Language: ${lang === "en" ? "English" : "French (the user is learning French)"}.`, ...ls.map((l) => l.text)].join("\n");
  const tool = {
    toolSpec: {
      name: "daily_insights",
      description: "Return today's communication insights.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            insights: { type: "array", items: { type: "object", properties: { title: { type: "string" }, insight: { type: "string" }, suggestion: { type: "string" } }, required: ["title", "insight", "suggestion"] } },
          },
          required: ["insights"],
        },
      },
    },
  } as Parameters<CallToolFn>[0]["tool"];
  const res = await llm({ system, user, tool, label: `${opts.label}:baseline:${lang}` });
  const p = z.object({ insights: z.array(z.object({ title: z.string(), insight: z.string(), suggestion: z.string() })) }).safeParse(res.input);
  return { insights: p.success ? p.data.insights : [], modelId: res.modelId };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();
export function quotes4gram(text: string, lines: WearerLine[]): boolean {
  const ls = lines.map((l) => norm(l.text));
  const t = norm(text).split(" ");
  for (let i = 0; i + 4 <= t.length; i++) {
    const g = t.slice(i, i + 4).join(" ");
    if (ls.some((l) => l.includes(g))) return true;
  }
  return false;
}

// A baseline insight "names a concrete correction" if it pairs a quoted wrong form with a right one.
export function namesCorrection(text: string): boolean {
  return /(["«“'][^"»”']{2,40}["»”'])[^.]{0,40}(→|->|instead of|plutôt que|au lieu de|should be|rather than|say )/i.test(text);
}

export function specificity(analysis: Analysis, baselines: { lang: string; insights: { title: string; insight: string; suggestion: string }[] }[], lines: WearerLine[]) {
  const drills = analysis.drills;
  const errDrills = drills.filter((d) => d.kind !== "filler");
  const keys = new Set(lines.map((l) => l.key));
  const ins = baselines.flatMap((b) => b.insights.map((i) => `${i.title}. ${i.insight} ${i.suggestion}`));
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  return {
    drills: errDrills.length,
    drillsCiteRealId: pct(errDrills.filter((d) => keys.has(d.key)).length, errDrills.length),
    drillsExcerptVerbatim: pct(errDrills.filter((d) => norm(d.line).includes(norm(d.said))).length, errDrills.length),
    drillsWithCorrection: pct(errDrills.filter((d) => d.fix && norm(d.fix) !== norm(d.said)).length, errDrills.length),
    baselineInsights: ins.length,
    baselineQuote4gram: pct(ins.filter((t) => quotes4gram(t, lines)).length, ins.length),
    baselineNamesCorrection: pct(ins.filter(namesCorrection).length, ins.length),
    baselineCiteLine: 0, // by construction: insights carry no line id
    usableItems: analysis.items.filter(usableItem).length,
  };
}
