// Optional model phrasing for a recap (off by default; COACH_RECAP_LLM=1 turns it on in live mode).
//
// The model only rewords the template recap: the numbers, the verdicts and the moment are decided
// by code (live/recap.ts) and passed in. It runs off the request path, one call at a time, with a
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
