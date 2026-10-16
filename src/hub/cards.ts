// Hub cards: the Leitner deck cards (src/real/deck.ts) plus the habit each one targets and the
// words a re-say must contain. Real cards get both derived deterministically; demo cards state them.
import type { Card } from "../real/deck.js";
import { FILLER_RE, HEDGE_RE, listRe } from "../real/text.js";
import { FUNCTION_WORDS, normTokens } from "./fuzzy.js";
import { vagueMatches, type Habit } from "./habits.js";

export interface HubCard extends Card {
  habit?: Habit;
  mustSay?: string[];
  synthetic?: boolean; // demo fixture card (invented text)
  lastAttemptAt?: number;
  passes?: number;
  fails?: number;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

// The habit a card targets, from its kind/type and its own "said" excerpt.
export function deriveHabit(c: Card): Habit {
  if (c.kind === "filler") {
    const fs = uniq(listRe(c.said, FILLER_RE[c.lang]).map((m) => m.replace(/(.)\1+$/, "$1")));
    return { kind: "filler", targets: fs, label: fs.length ? `fillers: ${fs.map((f) => `"${f}"`).join(", ")}` : "fillers" };
  }
  if (c.kind === "vocab") return { kind: "vocab", targets: [c.said.toLowerCase()], label: `say "${c.fix}" in French, not "${c.said}"` };
  switch (c.type) {
    case "EN_HEDGE_STACK": {
      const hs = uniq(listRe(c.said, HEDGE_RE.en));
      return { kind: "hedge", targets: hs, label: hs.length ? `hedges: ${hs.map((h) => `"${h}"`).join(", ")}` : "hedges" };
    }
    case "EN_VAGUE_REFERENT":
    case "EN_VAGUE_STATUS": {
      const vs = uniq([...vagueMatches(c.said), c.said.toLowerCase().trim()]);
      return { kind: "vague", targets: vs, label: `vague: "${c.said}"` };
    }
    case "EN_FALSE_START":
      return { kind: "restart", targets: [], label: "restarts" };
    default:
      return { kind: "error", targets: [c.said.toLowerCase()], label: `${c.type}: "${c.said}"` };
  }
}

// Words the fix introduces (not in "said", not function words) that the re-say sentence also
// contains: saying the card means saying these, e.g. the concrete name that replaces "that thing".
export function deriveMustSay(c: Card): string[] {
  const said = new Set(normTokens(c.said, c.lang));
  const resay = new Set(normTokens(c.resay, c.lang));
  return uniq(normTokens(c.fix, c.lang).filter((w) => !said.has(w) && !FUNCTION_WORDS.has(w) && resay.has(w) && w.length > 1));
}

export const habitOf = (c: HubCard): Habit => c.habit ?? deriveHabit(c);
export const mustSayOf = (c: HubCard): string[] => c.mustSay ?? deriveMustSay(c);

// What surfaces see. No full source line or ranking score.
export interface CardView {
  id: string;
  kind: Card["kind"];
  lang: Card["lang"];
  type: string;
  habit: Habit;
  said: string; // what you said (excerpt of your own line)
  fix: string;
  resay: string; // the target sentence to say aloud
  why: string;
  mustSay: string[];
  box: number;
  due: string;
  dueNow: boolean;
  passes: number;
  fails: number;
  source: { session: string; key: string };
  synthetic: boolean;
}

export function cardView(c: HubCard, today: string): CardView {
  return {
    id: c.id,
    kind: c.kind,
    lang: c.lang,
    type: c.type,
    habit: habitOf(c),
    said: c.said,
    fix: c.fix,
    resay: c.resay,
    why: c.why,
    mustSay: mustSayOf(c),
    box: c.box,
    due: c.due,
    dueNow: c.due <= today,
    passes: c.passes ?? 0,
    fails: c.fails ?? 0,
    source: { session: c.session, key: c.key },
    synthetic: !!c.synthetic,
  };
}
