// Instrument check: for every meeting that Bee also heard, compare the captions' habit rates with
// Bee's, counted by the same rules, with 95% intervals (src/real/instruments.ts). Prints ids and
// aggregates only (no line text).
//
//   npm run instrument:check            # reads real/ (gitignored); prints a table
//   npm run instrument:check -- --json  # the same as JSON
import { habitTitle } from "../src/hub/habitNames.js";
import { loadRealSessions } from "../src/hub/stats.js";
import { instrumentCheck, instrumentCheckLines } from "../src/real/instruments.js";

const r = instrumentCheck(loadRealSessions("real"));
console.log(process.argv.includes("--json") ? JSON.stringify(r, null, 1) : instrumentCheckLines(r, habitTitle).join("\n"));
