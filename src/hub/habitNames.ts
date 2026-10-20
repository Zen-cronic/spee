// The habits' display names: the one place the words a person sees or hears for each habit live
// (hub narration, Alexa speech, MCP narration, wrist and recap text). Keyed by the stable habit
// keys (stats, recap and pre-registration keys), which never change. The TV keeps the same map
// in tv/web/src/mirror/format.ts (HABIT_NAME); test/habit-names.test.ts keeps the two in step.
export const HABIT_NAME: Record<string, string> = {
  hedges: "unsure words",
  "filler:like": 'filler "like"',
  fillers: "filler words",
  vague: "vague answers",
  restart: "starting over",
  restarts: "starting over",
  trailing: "trailing off",
  "yeah-tic": '"and yeah" endings',
};

/** A habit key's prose name ("unsure words"); the key itself when it has none. */
export const habitNameOf = (key: string): string => HABIT_NAME[key] ?? key;

/** A habit key's name as a label ("Unsure words", 'Filler "like"'). */
export function habitTitle(key: string): string {
  const s = habitNameOf(key);
  const i = s.search(/[a-z]/i);
  return i < 0 ? s : s.slice(0, i) + s[i]!.toUpperCase() + s.slice(i + 1);
}

/** The plain gloss for a rate, said once where "per 100 words" first appears. */
export const PER_100_GLOSS = "out of every 100 words you said";
