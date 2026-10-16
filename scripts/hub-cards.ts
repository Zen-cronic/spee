// Adds deterministic hedge and "like" cards, built from the wearer's own real English sentences,
// to the live deck (real/deck.json, gitignored), so the pre-registered habits can be drilled.
//   npm run hub:cards                 # Bee conversations (the input of record)
//   npm run hub:cards -- --source all # also meeting captions (secondary)
//   npm run hub:cards -- --dry-run    # counts only
// Prints counts only, never sentence text.
import { localDate } from "../src/real/deck.js";
import { habitCards } from "../src/hub/realCards.js";
import { loadHubDeck, saveHubDeck } from "../src/hub/scheduler.js";
import { loadRealSessions, parseSource } from "../src/hub/stats.js";

const args = process.argv.slice(2);
const source = parseSource(args.includes("--source") ? args[args.indexOf("--source") + 1] : "bee") ?? "bee";
const path = "real/deck.json";
const deck = loadHubDeck(path);
const cards = habitCards(loadRealSessions("real"), { source, today: localDate(Date.now()) });
const have = new Set(deck.cards.map((c) => c.id));
const add = cards.filter((c) => !have.has(c.id));
const by = add.reduce<Record<string, number>>((m, c) => ((m[c.habit!.label] = (m[c.habit!.label] ?? 0) + 1), m), {});
console.log(`source ${source}: ${cards.length} candidate cards, ${add.length} new`, by);
if (!args.includes("--dry-run")) {
  deck.cards.push(...add);
  saveHubDeck(path, deck);
  console.log(`Wrote ${path} (${deck.cards.length} cards)`);
}
