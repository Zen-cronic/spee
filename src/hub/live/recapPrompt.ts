// Optional model phrasing for a recap (off by default; COACH_RECAP_LLM=1 turns it on in live mode).
//
// The model only rewords the template recap: the numbers, the verdicts and the moment are decided
// by code (live/recap.ts) and passed in. The model never writes a number: it writes named slots
// ({hedges_rate}, {minutes}, {longest_turn_min}) from the list it is given, and code fills in the
// values. acceptPhrasing refuses a digit or a number word outside the slots, an unknown slot, a
// slot the template states that the phrasing dropped, a slot in a sentence that does not name its
// subject (a habit's slots name the habit, {longest_turn_min} says "turn"), and a usual value that
// is not the one "usual" points at. It runs off the request path, one call at a time, with a 6 s
// timeout; on any failure or failed check the template phrasing stays. Model: Claude Haiku 4.5
// on Bedrock (profile hackathon-1, via src/llm/bedrock.ts callTool). Tests inject a fake.
//
// The rubric (the operator's principles) is injected into the system prompt at runtime only; this
// module never logs it. A phrasing that shares a 5-word shingle with the principles is rejected.
import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { WRIST_TEXT_MAX, type Recap } from "../contract.js";
import type { Principles } from "./principles.js";
import { fold } from "./principles.js";
import { fillSlots, type RecapSlots } from "./recap.js";

export const RECAP_LLM_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const RECAP_LLM_TIMEOUT_MS = 6000;

export type PhraseFn = (opts: { system: string; user: string; tool: Tool; label: string; chain?: string[]; sanitize?: (input: unknown) => unknown | null }) => Promise<{ input: unknown; modelId: string }>;

export const RECAP_TOOL: Tool = {
  toolSpec: {
    name: "recap_phrasing",
    description: "The spoken recap of one conversation, reworded for a watch and a voice assistant.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          headline: { type: "string", description: "One line for a TV screen, at most 140 characters once the slots are filled. Numbers only as {slot} names." },
          narration: { type: "string", description: "At most 3 sentences, spoken aloud. Numbers only as {slot} names; keep every slot the template uses. Quote only the given moment or rephrase, word for word." },
          wristText: { type: "string", description: `Starts with "[coach] ", at most ${WRIST_TEXT_MAX} characters once filled, no quotes.` },
        },
        required: ["headline", "narration", "wristText"],
      },
    },
  },
};

export function recapPrompt(recap: Recap, slots: RecapSlots, principles: Principles): { system: string; user: string } {
  const system = [
    "You reword a short recap of one conversation for a personal speaking coach.",
    "The wearer reads it on a watch and hears it from a voice assistant. Be warm, direct and brief.",
    "Use only the facts given. Never write a number, in digits or in words (one, once, twice, half...): write the slot instead, in braces, exactly as named in `slots`, e.g. {hedges_rate}. The only number you may write is the unit \"per 100 words\".",
    "Keep every slot the template uses. Each sentence with a slot names what it is about: a habit's slots with that habit (hedges, \"like\", vague answers, restarts), {longest_turn_min} with the word \"turn\", {minutes} with the conversation, {wpm} and {usual_wpm} with the pace or words a minute. Put \"usual\" or \"usually\" right next to each *_usual slot and never next to another slot.",
    "Do not invent quotes: quote only the given moment or its rephrase, word for word.",
    "Follow these coaching principles, but never quote or closely paraphrase them:",
    "<principles>",
    principles.rubric,
    "</principles>",
  ].join("\n");
  const facts = {
    slots: slots.values,
    moment: recap.moment ? { said: recap.moment.text, rephrase: recap.moment.rephrase, habit: recap.moment.habit } : null,
    template: slots.template,
  };
  return { system, user: `Reword this recap.\n${JSON.stringify(facts)}` };
}

const sentences = (s: string) => s.replace(/"[^"]*"/g, '""').split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;

// Number words a phrasing may not write outside a slot (digits are refused outright).
export const NUMBER_WORDS = new Set(
  ("zero none nil once twice thrice one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen " +
    "twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million dozen half quarter couple single double triple").split(" "),
);
const SLOT_RE = /\{([a-z_]+)\}/g;
const UNIT = /\bper 100 words?\b/gi;
export const slotsIn = (t: string) => [...t.matchAll(SLOT_RE)].map((m) => m[1]!);

// What a sentence must name for each slot in it.
const HABIT_SUBJECT: Record<string, RegExp> = { hedges: /hedg/i, like: /\blikes?\b/i, vague: /\bvague/i, restarts: /\brestart/i };
function subjectOf(slot: string): RegExp | null {
  const m = /^(\w+?)_(count|rate|usual)$/.exec(slot);
  if (m && HABIT_SUBJECT[m[1]!]) return HABIT_SUBJECT[m[1]!]!;
  if (slot === "longest_turn_min") return /\bturns?\b/i;
  if (slot === "minutes") return /\b(conversation|talk|chat)\b/i;
  if (slot === "wpm" || slot === "usual_wpm") return /\bwords? (a|per) minute\b|\bpace\b|\bwpm\b/i;
  if (slot === "words") return /\bwords?\b/i;
  if (slot === "check_in_seconds") return /\bsecond/i;
  return null;
}
const isUsual = (slot: string) => slot.endsWith("_usual") || slot === "usual_wpm";

// Each sentence: every slot's subject is named, and each "usual" word points at its nearest slot
// (a tie goes to the later one), which must be a usual slot; every usual slot is pointed at.
function slotsOnTheirFacts(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const toks = [...sentence.matchAll(/\{[a-z_]+\}|\p{L}+/gu)].map((m) => m[0]);
    const slotAt = toks.map((t, i) => (t.startsWith("{") ? i : -1)).filter((i) => i >= 0);
    for (const i of slotAt) {
      const re = subjectOf(toks[i]!.slice(1, -1));
      if (!re || !re.test(sentence.replace(SLOT_RE, " "))) return false;
    }
    const marked = new Set<number>();
    toks.forEach((t, i) => {
      if (!/^(usual|usually|normally|typically)$/i.test(t) || !slotAt.length) return;
      const near = slotAt.reduce((best, j) => (Math.abs(j - i) < Math.abs(best - i) || (Math.abs(j - i) === Math.abs(best - i) && j > best) ? j : best));
      marked.add(near);
    });
    for (const i of slotAt) if (isUsual(toks[i]!.slice(1, -1)) !== marked.has(i)) return false;
  }
  return true;
}

// Text with its quotes removed: the quote rule below checks them, and a quoted moment may hold
// numbers of its own (only quotes in `allowed` are removed; anything else is still checked).
const unquoted = (s: string, allowed: string[]) => s.replace(/"([^"]*)"/g, (q, inner: string) => (allowed.includes(fold(inner)) ? " " : q));

// The model output is accepted only when every check passes; else null (keep the template). On
// success the slots are filled in.
export function acceptPhrasing(out: unknown, recap: Recap, slots: RecapSlots, principles: Principles): Pick<Recap, "headline" | "narration" | "wristText"> | null {
  const o = out as Record<string, unknown>;
  if (!o || typeof o.headline !== "string" || typeof o.narration !== "string" || typeof o.wristText !== "string") return null;
  const raw = { headline: o.headline.trim(), narration: o.narration.trim(), wristText: o.wristText.trim() };
  const allowed = recap.moment ? [fold(recap.moment.text), fold(recap.moment.rephrase)] : [];
  // Slots: only known names, every one the template states kept, none written as a number.
  for (const t of Object.values(raw)) {
    if (slotsIn(t).some((n) => !(n in slots.values))) return null;
    const bare = unquoted(t, allowed).replace(SLOT_RE, " ").replace(UNIT, " ");
    if (/[{}\d]/.test(bare)) return null;
    if ((bare.toLowerCase().match(/\p{L}+/gu) ?? []).some((w) => NUMBER_WORDS.has(w))) return null;
    if (!slotsOnTheirFacts(unquoted(t, allowed))) return null;
  }
  const said = new Set([...slotsIn(raw.headline), ...slotsIn(raw.narration)]);
  if ([...slotsIn(slots.template.headline), ...slotsIn(slots.template.narration)].some((n) => !said.has(n))) return null;
  const headline = fillSlots(raw.headline, slots.values);
  const narration = fillSlots(raw.narration, slots.values);
  const wristText = fillSlots(raw.wristText, slots.values);
  if (!headline || headline.length > 140 || !narration || narration.length > 420 || sentences(narration) > 3) return null;
  if (!wristText.startsWith("[coach] ") || wristText.length > WRIST_TEXT_MAX || /"/.test(wristText)) return null;
  for (const t of [headline, narration, wristText]) if (principles.sharesShingle(t)) return null;
  // Quotes must be the wearer's moment or its rephrase.
  for (const m of `${headline} ${narration}`.matchAll(/"([^"]+)"/g)) {
    const q = fold(m[1]!);
    if (q.split(" ").length >= 3 && !allowed.includes(q)) return null;
  }
  return { headline, narration, wristText };
}

// Rephrase with the model, bounded by the timeout. Resolves null on any failure.
export async function phraseRecap(recap: Recap, slots: RecapSlots, principles: Principles, call: PhraseFn, timeoutMs = RECAP_LLM_TIMEOUT_MS): Promise<Pick<Recap, "headline" | "narration" | "wristText"> | null> {
  const { system, user } = recapPrompt(recap, slots, principles);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
  try {
    // sanitize: a phrasing that fails acceptPhrasing (e.g. echoes the private principles) is never cached
    const sanitize = (x: unknown) => (acceptPhrasing(x, recap, slots, principles) ? x : null);
    const res = await Promise.race([call({ system, user, tool: RECAP_TOOL, label: `recap:${recap.id}`, chain: [RECAP_LLM_MODEL], sanitize }).catch(() => null), timeout]);
    return res ? acceptPhrasing(res.input, recap, slots, principles) : null;
  } finally {
    clearTimeout(timer);
  }
}
