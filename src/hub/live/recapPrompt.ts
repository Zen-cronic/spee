// Optional model phrasing for a recap (off by default; COACH_RECAP_LLM=1 turns it on in live mode).
//
// The model only rewords the template recap: the numbers, the verdicts and the moment are decided
// by code (live/recap.ts) and passed in, and acceptPhrasing holds it to them: every number of the
// template kept, none added, in digits or in words, and each one still about the same thing (see
// numberFacts). It runs off the request path, one call at a time, with a
// 6 s timeout; on any failure or failed check the template phrasing stays. Model: Claude Haiku 4.5
// on Bedrock (profile hackathon-1, via src/llm/bedrock.ts callTool). Tests inject a fake.
//
// The rubric (the operator's principles) is injected into the system prompt at runtime only; this
// module never logs it. A phrasing that shares a 5-word shingle with the principles is rejected.
import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { WRIST_TEXT_MAX, type Recap } from "../contract.js";
import type { Principles } from "./principles.js";
import { fold } from "./principles.js";

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
          headline: { type: "string", description: "One line for a TV screen, at most 140 characters." },
          narration: { type: "string", description: "At most 3 sentences, spoken aloud. Keep every number as given. Quote only the given moment or rephrase, word for word." },
          wristText: { type: "string", description: `Starts with "[coach] ", at most ${WRIST_TEXT_MAX} characters, no quotes.` },
        },
        required: ["headline", "narration", "wristText"],
      },
    },
  },
};

export function recapPrompt(recap: Recap, principles: Principles): { system: string; user: string } {
  const system = [
    "You reword a short recap of one conversation for a personal speaking coach.",
    "The wearer reads it on a watch and hears it from a voice assistant. Be warm, direct and brief.",
    "Use only the facts given. Keep every number exactly as given. Do not invent quotes: quote only the given moment or its rephrase, word for word.",
    "Follow these coaching principles, but never quote or closely paraphrase them:",
    "<principles>",
    principles.rubric,
    "</principles>",
  ].join("\n");
  const facts = {
    metrics: recap.metrics,
    moment: recap.moment ? { said: recap.moment.text, rephrase: recap.moment.rephrase, habit: recap.moment.habit } : null,
    template: { headline: recap.headline, narration: recap.narration, wristText: recap.wristText },
  };
  return { system, user: `Reword this recap.\n${JSON.stringify(facts)}` };
}

const sentences = (s: string) => s.replace(/"[^"]*"/g, '""').split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;

// Numbers as a reader hears them: digits ("7.5", "1,400") and number words ("six", "twice").
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, none: 0, once: 1, twice: 2, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12,
};
const numKey = (n: number) => (Math.round(n * 100) / 100).toString();
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\p{L}+/gu)) {
    const t = m[0].toLowerCase();
    if (/^\d/.test(t)) out.push(numKey(Number(t.replace(/,/g, ""))));
    else if (t in WORD_NUMBERS) out.push(numKey(WORD_NUMBERS[t]!));
  }
  return out;
}
// What a number in a recap is about, so a phrasing cannot move a number to another fact ("hedged 6
// times and said like 2 times" becoming "hedged 2 times and said like 6 times"). A number belongs to
// the nearest fact word in its clause (else in its sentence): a habit (hedge, like, vague, restart),
// minutes, words, words a minute, or a rate when "per 100 words" follows within two words.
// "usual"/"usually" marks the number nearest to it, the same way, as the baseline. The result is "kind:number" keys, e.g. "hedge:6", "rate:7.5",
// "usual-rate:1.4", "minute:2"; a number with no fact word in its sentence is "none:<n>".
type Tok = { t: string; num: string | null; kind: string | null; usual: boolean; skip: boolean; clause: number };
const HABIT_WORD: [RegExp, string][] = [[/^hedg/, "hedge"], [/^likes?$/, "like"], [/^vague/, "vague"], [/^restart/, "restart"]];
export function numberFacts(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.replace(/"(like)"/gi, "$1").split(/(?<=[.!?])\s+/)) {
    const toks: Tok[] = [];
    let clause = 0;
    for (const m of sentence.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\p{L}+|[,;:()\u2013\u2014]/gu)) {
      const t = m[0].toLowerCase();
      if (!/[\p{L}\d]/u.test(t)) {
        clause++;
        continue;
      }
      const num = /^\d/.test(t) ? numKey(Number(t.replace(/,/g, ""))) : t in WORD_NUMBERS ? numKey(WORD_NUMBERS[t]!) : null;
      toks.push({ t, num, kind: null, usual: false, skip: false, clause });
    }
    const at = (i: number) => toks[i]?.t ?? "";
    for (let i = 0; i < toks.length; i++) {
      const k = toks[i]!;
      if (k.kind) continue;
      if (k.t === "per" && toks[i + 1]?.num === "100" && /^words?$/.test(at(i + 2))) {
        for (const j of [i, i + 1, i + 2]) (toks[j]!.kind = "rate"), (toks[j]!.skip = j === i + 1);
      } else if (/^words?$/.test(k.t) && /^(a|per)$/.test(at(i + 1)) && /^minutes?$/.test(at(i + 2))) {
        for (const j of [i, i + 1, i + 2]) toks[j]!.kind = "wpm";
      } else if (k.t === "wpm") k.kind = "wpm";
      else if (/^minutes?$/.test(k.t)) k.kind = "minute";
      else if (/^words?$/.test(k.t)) k.kind = "words";
      else if (k.num === null) k.kind = HABIT_WORD.find(([re]) => re.test(k.t))?.[1] ?? null;
    }
    const nums = toks.map((k, i) => (k.num !== null && !k.skip ? i : -1)).filter((i) => i >= 0);
    // The nearest token to i that passes `ok`, in i's clause first, then anywhere in the sentence (a tie
    // goes to the later one when `later`, else the earlier one).
    const nearest = (i: number, ok: (j: number) => boolean, later: boolean) => {
      for (const same of [true, false])
        for (let d = 1; d < toks.length; d++) {
          const order = later ? [i + d, i - d] : [i - d, i + d];
          const j = order.find((j) => j >= 0 && j < toks.length && (!same || toks[j]!.clause === toks[i]!.clause) && ok(j));
          if (j !== undefined) return j;
        }
      return -1;
    };
    // Each "usual" marks the number nearest to it (a tie goes to the number after it: "usual 1.4").
    toks.forEach((k, i) => {
      if (!/^usual(ly)?$/.test(k.t)) return;
      const near = nearest(i, (j) => nums.includes(j), true);
      if (near >= 0) toks[near]!.usual = true;
    });
    for (const i of nums) {
      const rate = [i + 1, i + 2].some((j) => toks[j]?.kind === "rate" && toks[j]!.clause === toks[i]!.clause);
      const j = rate ? -1 : nearest(i, (j) => toks[j]!.kind !== null, false);
      const kind = rate ? "rate" : j >= 0 ? toks[j]!.kind : "none";
      out.push(`${toks[i]!.usual ? "usual-" : ""}${kind}:${toks[i]!.num}`);
    }
  }
  return out;
}
const HABIT_KIND: Record<string, string> = { hedges: "hedge", "filler:like": "like", vague: "vague", restart: "restart" };

// Text with its quotes removed: the quote rule below checks them, and a quoted moment may hold
// numbers of its own (only quotes in `allowed` are removed; anything else is still counted).
const unquoted = (s: string, allowed: string[] | null) => s.replace(/"([^"]*)"/g, (q, inner: string) => (allowed === null || allowed.includes(fold(inner)) ? " " : q));

// The model output is accepted only when every check passes; else null (keep the template).
export function acceptPhrasing(out: unknown, recap: Recap, principles: Principles): Pick<Recap, "headline" | "narration" | "wristText"> | null {
  const o = out as Record<string, unknown>;
  if (!o || typeof o.headline !== "string" || typeof o.narration !== "string" || typeof o.wristText !== "string") return null;
  const headline = o.headline.trim();
  const narration = o.narration.trim();
  const wristText = o.wristText.trim();
  if (!headline || headline.length > 140 || !narration || narration.length > 420 || sentences(narration) > 3) return null;
  if (!wristText.startsWith("[coach] ") || wristText.length > WRIST_TEXT_MAX || /"/.test(wristText)) return null;
  for (const t of [headline, narration, wristText]) if (principles.sharesShingle(t)) return null;
  // Quotes must be the wearer's moment or its rephrase.
  const allowed = recap.moment ? [fold(recap.moment.text), fold(recap.moment.rephrase)] : [];
  for (const m of `${headline} ${narration}`.matchAll(/"([^"]+)"/g)) {
    const q = fold(m[1]!);
    if (q.split(" ").length >= 3 && !allowed.includes(q)) return null;
  }
  // Numbers: every one the template states is kept, about the same fact, and none is added (a
  // habit's count is a fact too, so "no hedges" may become "zero hedges").
  const facts = (t: string, keep: string[] | null) => numberFacts(unquoted(t.replace(/"(like)"/gi, "$1"), keep));
  const want = new Set([...facts(recap.headline, null), ...facts(recap.narration, null)]);
  const may = new Set([...want, ...facts(recap.wristText, null), ...recap.metrics.habits.flatMap((h) => (HABIT_KIND[h.key] ? [`${HABIT_KIND[h.key]}:${numKey(h.count)}`] : []))]);
  const said = [...facts(headline, allowed), ...facts(narration, allowed)];
  if ([...want].some((n) => !said.includes(n))) return null;
  if ([...said, ...facts(wristText, null)].some((n) => !may.has(n))) return null;
  return { headline, narration, wristText };
}

// Rephrase with the model, bounded by the timeout. Resolves null on any failure.
export async function phraseRecap(recap: Recap, principles: Principles, call: PhraseFn, timeoutMs = RECAP_LLM_TIMEOUT_MS): Promise<Pick<Recap, "headline" | "narration" | "wristText"> | null> {
  const { system, user } = recapPrompt(recap, principles);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
  try {
    // sanitize: a phrasing that fails acceptPhrasing (e.g. echoes the private principles) is never cached
    const sanitize = (x: unknown) => (acceptPhrasing(x, recap, principles) ? x : null);
    const res = await Promise.race([call({ system, user, tool: RECAP_TOOL, label: `recap:${recap.id}`, chain: [RECAP_LLM_MODEL], sanitize }).catch(() => null), timeout]);
    return res ? acceptPhrasing(res.input, recap, principles) : null;
  } finally {
    clearTimeout(timer);
  }
}
