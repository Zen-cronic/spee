// Markdown renderers for gitignored outputs (out/class-<date>.md, out/mislabel-sample.md).
// They quote the wearer's own lines only.
import type { Drill, LangRates } from "./analyze.js";
import type { RealCorpus, WearerLine } from "./corpus.js";
import type { Card } from "./deck.js";
import type { Analysis } from "./pipeline.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const rateLine = (lang: string, r: LangRates) =>
  `| ${lang} | ${r.lines} | ${r.words} | ${r.fillersPer100} (${Object.entries(r.fillerBreakdown).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}) | ${r.hedgesPer100} (${Object.entries(r.hedgeBreakdown).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}) |`;

export function renderClass(opts: {
  date: string;
  sinceIso: string;
  corpus: RealCorpus;
  analysis: Analysis;
  tomorrow: Card[];
  tomorrowDate: string;
  relapsed: Card[];
  warnings: string[];
}): string {
  const { corpus, analysis: a } = opts;
  const top = a.drills.filter((d) => d.kind === "error").slice(0, 5);
  const vocab = a.drills.filter((d) => d.kind === "vocab");
  const conv = corpus.sessions.filter((s) => s.kind === "conversation" && !s.skipped);
  const notes = corpus.sessions.filter((s) => s.kind === "voice_note");
  const out: string[] = [];
  out.push(`# Class debrief, ${opts.date}`, "");
  out.push(`Private (gitignored). Your own lines only. Source: ${conv.length} conversation(s) and ${notes.length} voice note(s) since ${opts.sinceIso}.`, "");
  for (const w of opts.warnings) out.push(`> ⚠ ${w}`, "");
  out.push(`Wearer lines: ${corpus.lines.length} (${corpus.lines.filter((l) => l.uncertain).length} set aside as "maybe not you").`, "");
  out.push("## Your top 5 errors", "");
  if (!top.length) out.push("_No coachable errors found (or the LLM step was skipped)._", "");
  top.forEach((d, i) => {
    out.push(`${i + 1}. **${d.type}** (\`${d.key}\`)`);
    out.push(`   - You said: "${d.said}"`);
    out.push(`   - Say: "${d.fix}"`);
    out.push(`   - Re-say: ${d.resay}`);
    out.push(`   - Why: ${d.why}`);
  });
  out.push("", `## 3 drills for tomorrow (${opts.tomorrowDate})`, "");
  out.push("Say each re-say sentence aloud three times, then once in a Bee voice note so the coach can check it.", "");
  opts.tomorrow.forEach((c, i) => out.push(`${i + 1}. [box ${c.box}] **${c.type}**: ${c.resay}  _(from "${c.said}", \`${c.key}\`)_`));
  if (opts.relapsed.length) out.push("", `Relapsed tonight (back to box 1): ${opts.relapsed.map((c) => c.type).join(", ")}`);
  out.push("", "## Fillers and hedges (per 100 words, your lines only)", "");
  out.push("| Language | Lines | Words | Fillers /100 | Hedges /100 |", "|---|---|---|---|---|");
  out.push(rateLine("French", a.rates.fr), rateLine("English", a.rates.en));
  const fd = a.drills.filter((d) => d.kind === "filler").slice(0, 1);
  for (const d of fd) out.push("", `Filler drill: ${d.why}`, `- Said: "${d.said}"`, `- Clean: "${d.fix}"`);
  out.push("", "## Code-switch vocabulary (you reached for English: say it in French)", "");
  if (!vocab.length) out.push("_None tonight._");
  for (const v of vocab.slice(0, 8)) out.push(`- ${v.type === "FR_VOCAB_ASKED" ? "(you asked)" : "(inferred switch)"} "${v.said}" → **${v.fix}**. ${v.resay}`);
  out.push("");
  return out.join("\n");
}

// Mislabel labelling sheet. The detector's verdict is NOT shown, so labels are blind.
export function renderMislabelSample(sample: WearerLine[]): string {
  const out = [
    "# Mislabel sample: was this line really you?",
    "",
    "Private (gitignored). Bee labelled every line below as you. Some may be a podcast, a video or a voice assistant.",
    "For each line replace `?` after `label:` with one of:",
    "",
    "- `me`: you said it",
    "- `not`: another voice (media, assistant, another person)",
    "- `mixed`: part you, part another voice",
    "- `skip`: can't tell",
    "",
    "Then run `npm run mislabel:score`.",
    "",
  ];
  sample.forEach((l, i) => {
    out.push(`## ${i + 1}. ${l.key}`, "", `conversation ${l.session}, t=${l.start ?? "?"}-${l.end ?? "?"} s`, "", `> ${esc(l.text)}`, "", "label: ?", "");
  });
  return out.join("\n");
}

export function drillTable(ds: Drill[]): string {
  return ["| Type | Line | Said | Fix | Re-say |", "|---|---|---|---|---|", ...ds.map((d) => `| ${d.type} | \`${d.key}\` | ${esc(d.said)} | ${esc(d.fix)} | ${esc(d.resay)} |`)].join("\n");
}
