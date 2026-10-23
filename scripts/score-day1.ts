// Kill test 2: score the Day-1 French voice note against fixtures/day1/french-voice-note-script.md.
//
//   npx tsx scripts/score-day1.ts                 # newest journal (voice note) via the bee CLI
//   npx tsx scripts/score-day1.ts --id <id>       # a given journal
//   npx tsx scripts/score-day1.ts --wait          # poll until the newest note is READY (10 min max)
//   npx tsx scripts/score-day1.ts --analyze       # also run the coach (Bedrock) and check it flags survivors
//   npx tsx scripts/score-day1.ts --file <json>   # a saved `bee journals get --json` payload (offline)
//
// Writes out/day1-score.json and saves the raw journal to fixtures/day1/bee-fr-note.json (both gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { JournalGetResponseSchema, type Journal } from "../src/bee/schemas.js";
import { CliBeeSource, epochMs } from "../src/bee/source.js";
import { splitSentences } from "../src/analyze/segment.js";
import { coachCoverage, scoreDay1 } from "../src/real/day1.js";
import { extractRealItems, usableItem } from "../src/real/analyze.js";
import { dominantLang, lineLang } from "../src/real/text.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJournal(): Promise<Journal | null> {
  const file = opt("--file");
  if (file) return JournalGetResponseSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const src = new CliBeeSource();
  const id = opt("--id");
  const deadline = Date.now() + (flag("--wait") ? 10 * 60_000 : 0);
  for (;;) {
    let j: Journal | null = null;
    if (id) j = await src.journal(id);
    else {
      const all = await src.journalsAll();
      const newest = all.at(-1);
      if (newest) j = (await src.journal(newest.id)) ?? newest;
    }
    if (j && j.state === "READY" && j.text) {
      mkdirSync("day1", { recursive: true });
      writeFileSync("fixtures/day1/bee-fr-note.json", JSON.stringify(j, null, 2) + "\n");
      return j;
    }
    if (Date.now() >= deadline) return j;
    console.error(j ? `journal ${j.id} is ${j.state}; waiting...` : "no journal yet; waiting...");
    await sleep(15_000);
  }
}

const j = await fetchJournal();
if (!j) {
  console.error("No journal (voice note) found. Record the Day-1 note on the Watch, then rerun (or pass --wait).");
  process.exit(2);
}
if (!j.text) {
  console.error(`Journal ${j.id} has no text yet (state ${j.state}). Rerun with --wait.`);
  process.exit(2);
}
if (j.state !== "READY") console.error(`warning: journal ${j.id} state is ${j.state}; scoring the text present now.`);

// Score the RAW transcript text. aiResponse.cleanedUpText, when present, is scored separately to
// show what Bee's AI clean-up would do to the errors.
const score = scoreDay1(j.text);
const cleaned = (j as { aiResponse?: { cleanedUpText?: string | null } | null }).aiResponse?.cleanedUpText;
const cleanedScore = cleaned ? scoreDay1(cleaned) : null;

console.log(`Journal ${j.id} (${new Date(epochMs(j.created_at)).toISOString()}), ${score.words} words, state ${j.state}`);
console.log("");
for (const e of score.errors) console.log(`${e.id.padEnd(4)} ${e.status.padEnd(9)} planted "${e.planted}"${e.evidence ? `  -> "${e.evidence}"` : ""}`);
console.log("");
console.log(`Errors: ${score.survived} SURVIVED, ${score.corrected} CORRECTED, ${score.garbled} GARBLED`);
console.log(`Fillers kept: ${score.fillersKept} of 4 (tokens: ${score.fillerTokens.join(", ") || "none"})`);
console.log(`KILL TEST 2: ${score.pass ? "PASS" : "FAIL"} (pass = >= 7 of 10 survived)`);
if (cleanedScore) console.log(`aiResponse.cleanedUpText: ${cleanedScore.survived}/10 survive the AI clean-up (never analyzed; shown for reference).`);
if (score.garbled >= 2) console.log("Note: GARBLED means neither form was found. Check those lines by eye: ASR may have split or misheard a word.");

let coverage: ReturnType<typeof coachCoverage> | null = null;
let coachItems: unknown[] = [];
if (flag("--analyze")) {
  const dom = dominantLang(j.text, "fr");
  const lines = splitSentences(j.text).map((t, i) => ({
    key: `v:${j.id}:${i}`, session: j.id, kind: "voice_note" as const, start: null, end: null, spokenAt: epochMs(j.created_at),
    text: t, lang: lineLang(t), dom: dominantLang(t, dom), uncertain: false, mislabelScore: 0, reasons: [],
  }));
  const { items, models } = await extractRealItems(lines, { label: "day1" });
  const usable = items.filter(usableItem);
  coachItems = items;
  coverage = coachCoverage(score, usable);
  const surv = coverage.filter((c) => c.status === "SURVIVED");
  console.log("");
  console.log(`Coach (${[...new Set(models)].join(", ")}): ${usable.length} usable items; flags ${surv.filter((c) => c.flagged).length}/${surv.length} surviving errors.`);
  for (const c of coverage) console.log(`  ${c.id.padEnd(4)} ${c.status.padEnd(9)} ${c.flagged ? (c.byType ? "flagged (same type)" : "flagged (other type)") : c.status === "SURVIVED" ? "MISSED" : "-"}`);
}

mkdirSync("out", { recursive: true });
writeFileSync(
  "out/day1-score.json",
  JSON.stringify({ journal_id: j.id, created_at: j.created_at, state: j.state, scored_at: new Date().toISOString(), score, cleanedScore, coverage, coachItems }, null, 2) + "\n",
);
console.log("\nWrote out/day1-score.json" + (existsSync("fixtures/day1/bee-fr-note.json") && !opt("--file") ? " and fixtures/day1/bee-fr-note.json" : ""));
