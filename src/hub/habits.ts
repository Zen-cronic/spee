// Habit vocabulary shared by the grader, the stats and the transfer check. Every habit here is
// counted by a deterministic rule (regex or token rule), never by a model.
//
// Hero habits: hedges ("I guess", "kind of") and the filler "like", the two drilled habits in the
// pre-registration (prereg/transfer.json). Vague answers (vague referents such as "that thing",
// vague status such as "pretty much done", vague tags such as "and stuff") and the other fillers
// ("um") are tracked. Restarts and trailing-off are tracked too; restarts are the pre-registered
// control habit.
import { splitSentences } from "../analyze/segment.js";
import { sentenceKind, VAGUE_RE_EN, YEAH_TIC_RE } from "../real/talk.js";
import { FILLER_RE, HEDGE_RE, listRe, repeats } from "../real/text.js";

export type HabitKind = "filler" | "hedge" | "vague" | "restart" | "trailing" | "yeah-tic" | "error" | "vocab";

export interface Habit {
  kind: HabitKind;
  targets: string[]; // lowercase phrases; empty = every phrase of that kind
  label: string;
}

// Vague status: a status with no concrete state. Vague referents: a placeholder where a name is
// needed. Both are English-only lexicons, deliberately short and literal.
export const VAGUE_STATUS_RE = /\b(?:making (?:good )?progress|pretty much done|kind of done|sort of done|almost done|mostly done|going well|getting there|working on it|should be fine|more or less|in progress|on track-ish)\b/gi;
export const VAGUE_REFERENT_RE = /\b(?:that thing|the thing|this thing|those things|the stuff|that stuff|this stuff|the issue from before|the one from before|you know what i mean|that one thing)\b/gi;

export const vagueMatches = (text: string): string[] => [...listRe(text, VAGUE_REFERENT_RE), ...listRe(text, VAGUE_STATUS_RE), ...listRe(text, VAGUE_RE_EN)];

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

// Phrase occurrences with word boundaries (case-insensitive).
export function countLiteral(text: string, phrase: string): number {
  const p = norm(phrase);
  if (!p) return 0;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s,]+");
  return (norm(text).match(new RegExp(`(?<![\\p{L}\\p{N}'])${esc}(?![\\p{L}\\p{N}'])`, "giu")) ?? []).length;
}

const fillersOf = (text: string, lang: "en" | "fr") => listRe(text, FILLER_RE[lang]).map((m) => m.replace(/(.)\1+$/, "$1"));
const hedgesOf = (text: string, lang: "en" | "fr") => listRe(text, HEDGE_RE[lang]);

// Matches of one habit kind in a text, as lowercase phrases. Targets narrow filler/hedge/vague.
export function habitMatches(h: Pick<Habit, "kind" | "targets">, text: string, lang: "en" | "fr" = "en"): string[] {
  const only = (xs: string[]) => (h.targets.length ? xs.filter((x) => h.targets.includes(x)) : xs);
  switch (h.kind) {
    case "filler":
      return only(fillersOf(text, lang));
    case "hedge":
      return only(hedgesOf(text, lang));
    case "vague": {
      const lex = vagueMatches(text);
      // Every vague phrase counts on a vague card (vague answers are one habit), plus the card's
      // own excerpt when it is not in the lexicon.
      const extra = h.targets.filter((t) => !lex.includes(t) && !vagueMatches(t).length).flatMap((t) => new Array<string>(countLiteral(text, t)).fill(t));
      return [...lex, ...extra];
    }
    case "restart":
      return new Array<string>(repeats(text.replace(/\b(?:um+|uh+|euh+)\b/gi, " "))).fill("restart");
    case "trailing":
      return splitSentences(text)
        .filter((s) => sentenceKind(s) === "trailing")
        .map(() => "trailing");
    case "yeah-tic":
      return listRe(text, YEAH_TIC_RE);
    case "error":
    case "vocab":
      return h.targets.flatMap((t) => new Array<string>(countLiteral(text, t)).fill(t));
  }
}

// Habit keys: the stable names used by stats, transfer and the pre-registration file.
//   fillers | filler:<word> | hedges | hedge:<phrase> | vague | restart | trailing | yeah-tic
export const HABIT_KEYS_HELP = "fillers | filler:<word> | hedges | hedge:<phrase> | vague | restart | trailing | yeah-tic";

export function parseHabitKey(key: string): Habit | null {
  const [kind, ...rest] = key.split(":");
  const target = rest.join(":").trim().toLowerCase();
  switch (kind) {
    case "fillers":
      return { kind: "filler", targets: [], label: "fillers (um, uh, like, you know)" };
    case "filler":
      return target ? { kind: "filler", targets: [target], label: `"${target}" as a filler` } : null;
    case "hedges":
      return { kind: "hedge", targets: [], label: "hedges (I guess, I think, maybe, kind of...)" };
    case "hedge":
      return target ? { kind: "hedge", targets: [target], label: `the hedge "${target}"` } : null;
    case "vague":
      return { kind: "vague", targets: [], label: "vague answers (that thing, pretty much done, and stuff)" };
    case "restart":
      return { kind: "restart", targets: [], label: "restarts (the the, I I)" };
    case "trailing":
      return { kind: "trailing", targets: [], label: "trailing off mid-sentence" };
    case "yeah-tic":
      return { kind: "yeah-tic", targets: [], label: '"and yeah" / "so yeah" endings' };
    default:
      return null;
  }
}

export function countHabitKey(key: string, text: string, lang: "en" | "fr" = "en"): number {
  const h = parseHabitKey(key);
  return h ? habitMatches(h, text, lang).length : 0;
}

// The umbrella key a specific key belongs to: "hedge:i guess" -> "hedges", "filler:like" -> "fillers".
export function umbrellaOf(key: string): string | null {
  if (key.startsWith("hedge:")) return "hedges";
  if (key.startsWith("filler:")) return "fillers";
  return null;
}

// A habit key is covered by a pre-registration when it, or its umbrella, is registered.
export function isRegistered(key: string, registered: ReadonlySet<string>): boolean {
  const u = umbrellaOf(key);
  return registered.has(key) || (u != null && registered.has(u));
}

// The habit keys a card exercises (what a drill on it counts toward in the transfer check). A
// targeted filler or hedge card also counts toward its umbrella ("fillers" / "hedges"), so a
// pre-registration of all hedges sees a drill on "I guess".
export function habitKeysOf(h: Habit): string[] {
  switch (h.kind) {
    case "filler":
      return [...h.targets.map((t) => `filler:${t}`), "fillers"];
    case "hedge":
      return [...h.targets.map((t) => `hedge:${t}`), "hedges"];
    case "vague":
      return ["vague"];
    case "restart":
    case "trailing":
    case "yeah-tic":
      return [h.kind];
    default:
      return [];
  }
}
