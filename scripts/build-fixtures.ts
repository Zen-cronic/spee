// Regenerates fixtures. Without prereg/*-split.json only pre-cutover sessions are built
// (coaching cannot affect speech before the split exists); `npm run poc` does the full sequence.
import { existsSync, readFileSync } from "node:fs";
import { buildWorld, type Split } from "../src/sim/world.js";
import { writeWorld } from "../src/sim/write.js";

const splits: Partial<Record<"en" | "fr", Split>> = {};
for (const lang of ["en", "fr"] as const) {
  const f = `prereg/${lang}-split.json`;
  if (existsSync(f)) {
    const p = JSON.parse(readFileSync(f, "utf8"));
    splits[lang] = { lang, drilled: p.drilled, control: p.control };
  }
}
const full = Object.keys(splits).length === 2;
writeWorld(buildWorld(splits, { includePost: full }));
console.log(full ? "wrote full fixtures (pre + post, conditioned on prereg split)" : "wrote pre-cutover fixtures only (no prereg split yet)");
