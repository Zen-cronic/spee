// Session loading (BeeSource -> citeable segments) and the LLM error-item extraction pass.
import { z } from "zod";
import type { BeeSource } from "../bee/source.js";
import { pickUtterances } from "../bee/source.js";
import { callTool } from "../llm/bedrock.js";
import { detectLang } from "./lang.js";
import { splitSentences } from "./segment.js";
import { ERROR_TYPES, TAXONOMY, type Lang } from "./taxonomy.js";

export interface Segment {
  key: string; // u:<utteranceId> or v:<journalId>:<sentenceIndex>
  text: string;
  start: number | null;
  end: number | null;
}
export interface Session {
  id: string;
  kind: "conversation" | "voice_note";
  lang: Lang;
  startMs: number;
  segments: Segment[];
}

export async function loadSessions(src: BeeSource, sinceMs = 0): Promise<Session[]> {
  const out: Session[] = [];
  for (const s of await src.conversations(sinceMs)) {
    const c = await src.conversation(s.id);
    if (!c) continue;
    const segments = pickUtterances(c).map((u) => ({ key: `u:${u.id}`, text: u.text, start: u.start, end: u.end }));
    out.push({ id: String(c.id), kind: "conversation", lang: detectLang(segments.map((x) => x.text).join(" ")), startMs: c.start_time, segments });
  }
  for (const j of await src.voiceNotes(sinceMs)) {
    // Analyze the raw transcript `text`, never aiResponse.cleanedUpText: Bee's AI clean-up
    // rewrites the note and would erase the very errors the coach needs.
    if (!j.text) continue;
    const segments = splitSentences(j.text).map((t, i) => ({ key: `v:${j.id}:${i}`, text: t, start: null, end: null }));
    out.push({ id: j.id, kind: "voice_note", lang: detectLang(j.text), startMs: j.created_at < 1e12 ? j.created_at * 1000 : j.created_at, segments });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export const ItemSchema = z.object({
  utterance_id: z.string(),
  error_type: z.string(),
  excerpt: z.string(),
  correction: z.string(),
  resay_prompt: z.string(),
  explanation: z.string(),
  asr_suspect: z.boolean().optional(),
});
export type RawItem = z.infer<typeof ItemSchema>;
export interface Item extends RawItem {
  session_id: string;
  session_kind: Session["kind"];
  lang: Lang;
  startMs: number;
  citation_valid: boolean;
  excerpt_grounded: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();

export const PROMPT_VERSION = { noGuard: "v1", guard: "v2-asr-guard" };

function context(s: Session): string {
  if (s.kind === "voice_note")
    return s.lang === "en"
      ? "A solo voice note the wearer recorded on their Bee wearable to rehearse their daily stand-up. Every line is the wearer's own speech."
      : "A solo French practice voice note the wearer (a high-A2 / low-B1 learner of French) recorded on their Bee wearable. Every line is the wearer's own speech.";
  return s.lang === "en"
    ? "A conversation captured by the wearer's Bee wearable: a software team's daily stand-up. Bee does not label speakers (every line is 'Unknown'), so lines may be the wearer's or a teammate's. The wearer is one of the developers."
    : "A conversation captured by the wearer's Bee wearable during a French class: a native-speaker teacher plus several adult learners. Bee does not label speakers (every line is 'Unknown'). The wearer is one of the learners (high A2 / low B1).";
}

const ASR_GUARD =
  "IMPORTANT: the transcript is automatic speech recognition (ASR) output, not what was said. ASR mishears names, product and technical terms (a tool or model name rendered as an ordinary word, a brand, or a person's name; 'X or Y' where one compound term was said) and garbles fragments into nonsense. FIRST, list in asr_suspects only tokens that are implausible in context: a common word, brand or person's name where a technical term is expected, or a nonsense phrase. Do NOT list plausible technical terms, names of people being addressed, or grammar errors: in a language-learning context a grammatical error is the learner's, not the ASR's. THEN report error items. Never correct or coach a misheard token, never invent content to repair a garbled fragment, and if an item depends on a suspected token set asr_suspect=true. Items with asr_suspect=true are shown as 'check the transcript' and never become drills.";

export function buildPrompt(s: Session, guard: boolean): { system: string; user: string; tool: Parameters<typeof callTool>[0]["tool"] } {
  const types = ERROR_TYPES(s.lang);
  const tax = types.map((t) => `- ${t}: ${TAXONOMY[s.lang][t]}`).join("\n");
  const system = [
    "You are a deliberate-practice speech coach. You find specific, recurring, drillable errors in transcripts of real speech.",
    "Report only clear instances of the listed error types. Each item must cite exactly one line id as given, quote the shortest exact excerpt from that line that shows the error, give the corrected version of the excerpt, a re-say prompt (the full corrected sentence the speaker should say aloud, which must NOT contain the error), and a one-sentence explanation.",
    "Do not report filler words (um, uh, like, euh, ben), repetitions, punctuation or capitalization: those are measured separately or are transcription artifacts.",
    "Corrections must not invent facts (dates, numbers, names, causes) that are not in the transcript: use a <placeholder> such as <day> or <owner> instead.",
    "Do not report correct sentences, teacher recasts or metalinguistic corrections (for example a teacher saying what one should NOT say). At most one item per (line, error type).",
    guard ? ASR_GUARD : "",
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Context: ${context(s)}`,
    "",
    "Error types:",
    tax,
    "",
    "Transcript lines (id then text):",
    ...s.segments.map((g) => `[${g.key}] ${g.text}`),
  ].join("\n");
  const itemProps: Record<string, unknown> = {
    utterance_id: { type: "string", description: "line id exactly as given, e.g. u:5101003 or v:abc:2" },
    error_type: { type: "string", enum: types },
    excerpt: { type: "string", description: "exact substring of that line" },
    correction: { type: "string" },
    resay_prompt: { type: "string", description: "the full corrected sentence to practise aloud, without the error" },
    explanation: { type: "string" },
  };
  const required = ["utterance_id", "error_type", "excerpt", "correction", "resay_prompt", "explanation"];
  if (guard) {
    itemProps.asr_suspect = { type: "boolean" };
    required.push("asr_suspect");
  }
  const props: Record<string, unknown> = { items: { type: "array", items: { type: "object", properties: itemProps, required } } };
  const top = ["items"];
  if (guard) {
    props.asr_suspects = {
      type: "array",
      items: {
        type: "object",
        properties: { utterance_id: { type: "string" }, token: { type: "string", description: "exact substring of the line" }, likely_intended: { type: "string" } },
        required: ["utterance_id", "token", "likely_intended"],
      },
    };
    top.unshift("asr_suspects");
  }
  const tool = {
    toolSpec: {
      name: "report_errors",
      description: guard ? "Report suspected ASR mishearings, then the error items found in the transcript." : "Report the error items found in the transcript.",
      inputSchema: { json: { type: "object", properties: props, required: top } },
    },
  } as Parameters<typeof callTool>[0]["tool"];
  return { system, user, tool };
}

export interface AsrSuspect {
  utterance_id: string;
  token: string;
  likely_intended: string;
}
export async function extractItems(s: Session, opts: { guard: boolean; label: string }): Promise<{ items: Item[]; modelId: string; rejected: number; asrSuspects: AsrSuspect[] }> {
  const p = buildPrompt(s, opts.guard);
  const res = await callTool({ ...p, label: `${opts.label}:${s.id}` });
  const parsed = z.object({ items: z.array(z.unknown()) }).safeParse(res.input);
  const sus = z
    .object({ asr_suspects: z.array(z.object({ utterance_id: z.string(), token: z.string(), likely_intended: z.string() })) })
    .safeParse(res.input);
  const asrSuspects = sus.success ? sus.data.asr_suspects.map((a) => ({ ...a, utterance_id: a.utterance_id.replace(/^\[|\]$/g, "") })) : [];
  const raw = parsed.success ? parsed.data.items : [];
  const byKey = new Map(s.segments.map((g) => [g.key, g]));
  const types = new Set(ERROR_TYPES(s.lang));
  const items: Item[] = [];
  let rejected = parsed.success ? 0 : 1;
  const seen = new Set<string>();
  for (const r of raw) {
    const it = ItemSchema.safeParse(r);
    if (!it.success || !types.has(it.data.error_type)) {
      rejected++;
      continue;
    }
    const id = it.data.utterance_id.replace(/^\[|\]$/g, "");
    const dedupe = `${id}|${it.data.error_type}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const seg = byKey.get(id);
    // Deterministic guard rule: an item whose excerpt contains a suspected mishearing is quarantined.
    // Session-wide: a term misheard once is usually misheard everywhere in the same recording.
    const hitsSuspect = asrSuspects.some((a) => norm(a.token).length > 0 && norm(it.data.excerpt).includes(norm(a.token)));
    items.push({
      ...it.data,
      asr_suspect: opts.guard ? (it.data.asr_suspect ?? false) || hitsSuspect : undefined,
      utterance_id: id,
      session_id: s.id,
      session_kind: s.kind,
      lang: s.lang,
      startMs: s.startMs,
      citation_valid: !!seg,
      excerpt_grounded: !!seg && norm(seg.text).includes(norm(it.data.excerpt)),
    });
  }
  return { items, modelId: res.modelId, rejected, asrSuspects };
}

// Generic comparator: what Bee's native "Daily Insights" style coaching looks like.
export async function genericBaseline(sessions: Session[], lang: Lang, label: string): Promise<{ insights: { title: string; insight: string; suggestion: string }[]; modelId: string }> {
  const system =
    "You are the AI assistant inside a wearable that records the user's day. Write today's Daily Insights about how the user communicates, like a supportive personal coach. Give 3 to 5 insights, each with a short suggestion.";
  const user = [
    `Today's transcripts (speaker labels unavailable). Language: ${lang === "en" ? "English" : "French"}.`,
    ...sessions.map((s) => `\n## ${s.kind === "voice_note" ? "Voice note" : "Conversation"}\n` + s.segments.map((g) => g.text).join("\n")),
  ].join("\n");
  const tool = {
    toolSpec: {
      name: "daily_insights",
      description: "Return today's communication insights.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            insights: {
              type: "array",
              items: { type: "object", properties: { title: { type: "string" }, insight: { type: "string" }, suggestion: { type: "string" } }, required: ["title", "insight", "suggestion"] },
            },
          },
          required: ["insights"],
        },
      },
    },
  } as Parameters<typeof callTool>[0]["tool"];
  const res = await callTool({ system, user, tool, label });
  const parsed = z.object({ insights: z.array(z.object({ title: z.string(), insight: z.string(), suggestion: z.string() })) }).safeParse(res.input);
  return { insights: parsed.success ? parsed.data.insights : [], modelId: res.modelId };
}

// Specificity probe: does a piece of feedback quote >= 4 consecutive words of a real line?
export function quotesTranscript(text: string, sessions: Session[]): boolean {
  const lines = sessions.flatMap((s) => s.segments.map((g) => norm(g.text)));
  const toks = norm(text).split(" ");
  for (let i = 0; i + 4 <= toks.length; i++) {
    const gram = toks.slice(i, i + 4).join(" ");
    if (lines.some((l) => l.includes(gram))) return true;
  }
  return false;
}
