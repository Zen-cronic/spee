// Class-night pipeline. Run once after class (and after the debrief voice note is READY):
//
//   npm run class -- --since 2026-10-15T18:00-04:00
//   npm run class -- --since 2026-10-15T18:00-04:00 --until 2026-10-15T21:30-04:00
//   npm run class -- --since ... --wait        # first wait (<= 30 min) for Bee to finish processing
//   npm run class -- --since ... --no-llm      # metrics only
//
// Pulls conversations and voice notes since --since, keeps the wearer's lines only (voice notes
// are wearer-only by construction), analyses them, updates the Leitner deck (real/deck.json) and
// writes out/class-<date>.md plus real/class-<date>.json. All outputs are gitignored.
import { mkdirSync, writeFileSync } from "node:fs";
import { CliBeeSource } from "../src/bee/source.js";
import { usage } from "../src/llm/bedrock.js";
import { loadRealCorpus } from "../src/real/corpus.js";
import { addDays, dueOn, loadDeck, localDate, saveDeck, updateDeck } from "../src/real/deck.js";
import { analyzeCorpus } from "../src/real/pipeline.js";
import { renderClass } from "../src/real/render.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const sinceIso = opt("--since");
if (!sinceIso || Number.isNaN(Date.parse(sinceIso))) {
  console.error("usage: npm run class -- --since <ISO time, e.g. 2026-10-15T18:00-04:00> [--until <ISO>] [--wait] [--no-llm] [--deck <path>]");
  process.exit(1);
}
const sinceMs = Date.parse(sinceIso);
const untilMs = opt("--until") ? Date.parse(opt("--until")!) : undefined;
const now = Date.now();

const src = new CliBeeSource();
// --wait: Bee adds speaker labels only once a conversation leaves CAPTURING. Poll up to 30 min.
if (args.includes("--wait")) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const pending = (await src.conversations(sinceMs)).filter((c) => c.state !== "COMPLETED" && (untilMs === undefined || c.start_time < untilMs));
    if (!pending.length || Date.now() > deadline) break;
    console.error(`waiting for ${pending.length} conversation(s) still ${pending.map((p) => p.state).join("/")}...`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
const { corpus, context } = await loadRealCorpus(src, { sinceMs, untilMs });
const warnings: string[] = [];
for (const s of corpus.sessions.filter((s) => s.skipped)) warnings.push(`Conversation ${s.id} is ${s.state}: ${s.skipped}.`);
if (!corpus.sessions.some((s) => s.kind === "voice_note")) warnings.push("No debrief voice note found since --since (record one on the Watch and rerun for a clean wearer-only channel).");
if (!corpus.wearer.labels.length) warnings.push(`No wearer speaker label found (${corpus.wearer.note}). Only voice notes were analysed.`);
if (!corpus.lines.length) warnings.push("No wearer lines in range.");

const analysis = await analyzeCorpus(corpus, context, { label: "class", noLlm: args.includes("--no-llm") });
const deckPath = opt("--deck") ?? "real/deck.json";
const deck = loadDeck(deckPath);
const { relapsed } = updateDeck(deck, analysis.drills, now);
const tomorrowDate = addDays(localDate(now), 1);
const tomorrow = dueOn(deck, tomorrowDate, 3);
saveDeck(deckPath, deck);

const date = localDate(sinceMs);
mkdirSync("out", { recursive: true });
mkdirSync("real", { recursive: true });
const md = renderClass({ date, sinceIso, corpus, analysis, tomorrow, tomorrowDate, relapsed, warnings });
writeFileSync(`out/class-${date}.md`, md);
writeFileSync(`real/class-${date}.json`, JSON.stringify({ sinceIso, corpus, analysis }, null, 1) + "\n");
for (const w of warnings) console.error(`warning: ${w}`);
console.log(`${corpus.lines.length} wearer lines from ${corpus.sessions.length} session(s); ${analysis.drills.length} drills; LLM calls ${usage.calls} (cache hits ${usage.cacheHits}).`);
console.log(`Wrote out/class-${date}.md (and real/class-${date}.json, ${deckPath}).`);
