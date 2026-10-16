// Leitner review: list due drills, or mark one re-performed.
//   npm run review                     # drills due today and tomorrow
//   npm run review -- --done <cardId>  # you re-said it correctly: move it up a box
import { addDays, dueOn, loadDeck, localDate, markReviewed, saveDeck } from "../src/real/deck.js";

const path = "real/deck.json";
const deck = loadDeck(path);
const args = process.argv.slice(2);
const i = args.indexOf("--done");
if (i >= 0) {
  const c = markReviewed(deck, args[i + 1] ?? "", Date.now());
  if (!c) {
    console.error(`No card ${args[i + 1]}`);
    process.exit(1);
  }
  saveDeck(path, deck);
  console.log(`${c.id}: box ${c.box}, next due ${c.due}`);
} else {
  const today = localDate(Date.now());
  for (const [label, date] of [["today", today], ["tomorrow", addDays(today, 1)]] as const) {
    console.log(`Due ${label} (${date}):`);
    for (const c of dueOn(deck, date, 3)) console.log(`  [box ${c.box}] ${c.id}\n      ${c.resay}`);
  }
}
