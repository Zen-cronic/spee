// Deterministic hedge and filler cards from the wearer's own real sentences (no model): the card
// is the sentence as said, and the target is the same sentence with the habit removed. Used to
// make the pre-registered habits drillable in live mode. Vague-answer cards need a concrete name
// for the vague phrase, so they come from the LLM pipeline (EN_VAGUE_REFERENT / EN_VAGUE_STATUS).
import { splitSentences } from "../analyze/segment.js";
import { FILLER_RE, HEDGE_RE, listRe, stripFillers, wordCount } from "../real/text.js";
import type { HubCard } from "./cards.js";
import { deriveMustSay } from "./cards.js";
import { countHabitKey } from "./habits.js";
import { fromSource, type SourceSel, type StatSession } from "./stats.js";

const tidy = (s: string) => {
  const t = s.replace(/\s+([,.?!])/g, "$1").replace(/,(\s*,)+/g, ",").replace(/^[\s,]+/, "").replace(/\s{2,}/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};
export const stripHedges = (s: string, hedges: string[]) => tidy(hedges.reduce((t, h) => t.replace(new RegExp(`\\b${h.replace(/ /g, "\\s+")}\\b,?\\s*`, "gi"), ""), s));

export function habitCards(sessions: StatSession[], opts: { source?: SourceSel; perHabit?: number; today: string }): HubCard[] {
  const n = opts.perHabit ?? 3;
  const sents = fromSource(sessions, opts.source ?? "bee")
    .flatMap((s) => s.lines.filter((l) => !l.uncertain && l.dom === "en").flatMap((l) => splitSentences(l.text).map((text, i) => ({ s, l, i, text }))))
    .filter((x) => wordCount(x.text) >= 6 && wordCount(x.text) <= 25);
  const make = (x: (typeof sents)[number], kind: "hedge" | "filler", targets: string[], fix: string): HubCard => {
    const base = { id: `${kind === "hedge" ? "HEDGE" : "FILLER_LIKE"}:${x.l.key}:${x.i}`, kind: kind === "hedge" ? ("error" as const) : ("filler" as const), lang: "en" as const, type: kind === "hedge" ? "EN_HEDGE_STACK" : "EN_FILLERS", key: x.l.key, session: x.s.id, said: x.text, fix, resay: fix, line: x.l.text };
    return {
      ...base,
      why: kind === "hedge" ? `Unsure words (${targets.map((t) => `"${t}"`).join(", ")}). Say it plainly, as a statement.` : `"Like" ${countHabitKey("filler:like", x.text)} times. Pause instead.`,
      score: kind === "hedge" ? 4 : 3,
      box: 1,
      due: opts.today,
      added: opts.today,
      relapses: 0,
      lastSeenSession: x.s.id,
      habit: { kind, targets, label: kind === "hedge" ? `unsure words (${targets.map((t) => `"${t}"`).join(", ")})` : `filler "like"` },
      mustSay: deriveMustSay({ ...base, why: "", score: 0, box: 1, due: "", added: "", relapses: 0, lastSeenSession: "" }),
    };
  };
  const out: HubCard[] = [];
  // "I guess" first (pre-registered), then other hedges, then the filler "like".
  const guess = sents.filter((x) => countHabitKey("hedge:i guess", x.text) > 0);
  for (const x of guess.slice(0, n)) out.push(make(x, "hedge", ["i guess"], stripHedges(x.text, ["i guess"])));
  const other = sents.filter((x) => !guess.includes(x) && listRe(x.text, HEDGE_RE.en).length > 0).sort((a, b) => listRe(b.text, HEDGE_RE.en).length - listRe(a.text, HEDGE_RE.en).length);
  for (const x of other.slice(0, n)) {
    const hs = [...new Set(listRe(x.text, HEDGE_RE.en))];
    out.push(make(x, "hedge", hs, stripHedges(x.text, hs)));
  }
  const like = sents.filter((x) => countHabitKey("filler:like", x.text) > 0).sort((a, b) => countHabitKey("filler:like", b.text) - countHabitKey("filler:like", a.text));
  for (const x of like.slice(0, n)) out.push(make(x, "filler", ["like"], tidy(stripFillers(x.text.replace(/,\s*(?:like|um+|uh+|you know)\s*,/gi, ""), "en"))));
  return out.filter((c) => c.fix && wordCount(c.fix) >= 4 && listRe(c.fix, FILLER_RE.en).length === 0);
}
