// Score the mislabel detector from the operator's labels in out/mislabel-sample.md.
//   npm run mislabel:score
import { readFileSync, writeFileSync } from "node:fs";
import { parseLabels, scoreLabels } from "../src/real/mislabelScore.js";

const md = readFileSync("out/mislabel-sample.md", "utf8");
const meta = JSON.parse(readFileSync("out/mislabel-sample.json", "utf8")) as { key: string; uncertain: boolean }[];
const flagged = new Set(meta.filter((m) => m.uncertain).map((m) => m.key));
const labels = parseLabels(md);
const s = scoreLabels(labels, flagged);
console.log(`Labelled ${s.labelled} of ${labels.size} (${s.unlabelled} unlabelled or skipped).`);
console.log(`Flagged lines that really were not (only) you: precision ${s.precision ?? "n/a"}% (${s.tp}/${s.tp + s.fp})`);
console.log(`Mislabelled lines the detector caught, in this sample: recall ${s.recallInSample ?? "n/a"}% (${s.tp}/${s.tp + s.fn})`);
console.log(`Unflagged lines that were not you: ${s.mislabelRateUnflagged ?? "n/a"}% (${s.fn}/${s.fn + s.tn})`);
writeFileSync("out/mislabel-score.json", JSON.stringify({ scoredAt: new Date().toISOString(), ...s }, null, 1) + "\n");
console.log("Wrote out/mislabel-score.json");
