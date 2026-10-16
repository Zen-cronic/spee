// Precision of the meetings coaching from the operator's marks in out/meetings-label-sample.md.
//   npm run meetings:score
import { readFileSync, writeFileSync } from "node:fs";
import { parseMarks, scoreMarks, type GroupScore, type LabelEntry } from "../src/real/meetingLabels.js";

const md = readFileSync("out/meetings-label-sample.md", "utf8");
const entries = JSON.parse(readFileSync("out/meetings-label-sample.json", "utf8")) as Pick<LabelEntry, "id" | "group" | "type">[];
const s = scoreMarks(entries, parseMarks(md));
const line = (name: string, g: GroupScore) =>
  `${name.padEnd(22)} labelled ${g.labelled}/${g.entries}  R ${g.R}  T ${g.T}  N ${g.N}  precision ${g.precision ?? "n/a"}%  transcription artifacts ${g.artifactRate ?? "n/a"}%`;
console.log(line("Drills (kept)", s.drills));
for (const [t, g] of Object.entries(s.drillsByType)) console.log(line(`  ${t}`, g));
console.log(line("Filler hits (sample)", s.fillers));
console.log(line("Hedge hits (sample)", s.hedges));
console.log(line("All", s.all));
console.log("Precision = R / (R + T + N). T = the captioner misheard; N = real but not worth coaching.");
writeFileSync("out/meetings-label-score.json", JSON.stringify({ scoredAt: new Date().toISOString(), ...s }, null, 1) + "\n");
console.log("Wrote out/meetings-label-score.json");
