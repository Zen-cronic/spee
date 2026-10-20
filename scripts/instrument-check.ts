// Instrument check: for every meeting that Bee also heard, compare the captions' habit rates with
// Bee's, counted by the same rules. Prints aggregates only (no line text).
//
//   npm run instrument:check            # reads real/ (gitignored); prints a table
//   npm run instrument:check -- --json  # the same as JSON
import { loadRealSessions } from "../src/hub/stats.js";
import { pairMeetings, type HabitRates } from "../src/real/instruments.js";

const pairs = pairMeetings(loadRealSessions("real"));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(pairs, null, 1));
} else if (!pairs.length) {
  console.log("No meeting overlaps a Bee conversation (both need wearer lines within 45 minutes of each other).");
} else {
  const rows: [string, keyof HabitRates][] = [
    ["your words", "words"],
    ["unsure words /100", "unsure"],
    ['filler "like" /100', "like"],
    ['"you know" /100', "youKnow"],
    ['"um" / "uh" /100', "umUh"],
    ["all filler words /100", "fillers"],
  ];
  for (const p of pairs) {
    console.log(`\n${p.meeting} (captions) vs Bee conversation ${p.bee}`);
    for (const [label, k] of rows) console.log(`  ${label.padEnd(24)} captions ${String(p.captions[k]).padStart(6)}   Bee ${String(p.beeRates[k]).padStart(6)}`);
  }
}
