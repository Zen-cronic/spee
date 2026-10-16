// Real-data analysis over the wearer's lines: deterministic filler / hedge metrics per language,
// LLM error extraction (French grammar/lexis, English communication) with the ASR guard,
// code-switch vocabulary moments, and drill cards that cite the real utterance.
import { z } from "zod";
import { callTool as bedrockCallTool, type CallToolFn } from "../llm/bedrock.js";
import { repliesAfter, type TransientContext, type WearerLine } from "./corpus.js";
import { ALL_REAL_TYPES, REAL_TAXONOMY } from "./taxonomy.js";
import { FILLER_RE, HEDGE_RE, countRe, listRe, repeats, stripFillers, wordCount } from "./text.js";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Lines eligible for coaching: wearer-labelled and not flagged by the mislabel detector.
export const coachable = (l: WearerLine) => !l.uncertain;

// Metrics

export interface LangRates {
  lines: number;
  words: number;
  fillers: number;
  fillersPer100: number;
  fillerBreakdown: Record<string, number>;
  hedges: number;
  hedgesPer100: number;
  hedgeBreakdown: Record<string, number>;
  repeatsPer100: number;
}

export function rates(lines: WearerLine[]): Record<"fr" | "en", LangRates> {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const out = {} as Record<"fr" | "en", LangRates>;
  for (const lang of ["fr", "en"] as const) {
    const ls = lines.filter((l) => l.dom === lang);
    const words = ls.reduce((n, l) => n + wordCount(l.text), 0);
    const fb: Record<string, number> = {};
    const hb: Record<string, number> = {};
    let reps = 0;
    for (const l of ls) {
      for (const m of listRe(l.text, FILLER_RE[lang])) fb[m] = (fb[m] ?? 0) + 1;
      for (const m of listRe(l.text, HEDGE_RE[lang])) hb[m] = (hb[m] ?? 0) + 1;
      reps += repeats(l.text);
    }
    const fillers = Object.values(fb).reduce((a, b) => a + b, 0);
    const hedges = Object.values(hb).reduce((a, b) => a + b, 0);
    const per = (n: number) => (words ? r2((n / words) * 100) : 0);
    out[lang] = { lines: ls.length, words, fillers, fillersPer100: per(fillers), fillerBreakdown: fb, hedges, hedgesPer100: per(hedges), hedgeBreakdown: hb, repeatsPer100: per(reps) };
  }
  return out;
}

// LLM error extraction

export interface RealItem {
  key: string;
  session: string;
  kind: WearerLine["kind"];
  lang: "fr" | "en";
  error_type: string;
  excerpt: string;
  correction: string;
  resay_prompt: string;
  explanation: string;
  asr_suspect: boolean;
  citation_valid: boolean;
  excerpt_grounded: boolean;
  line: string; // the wearer's own line (persisted to gitignored paths only)
  verified?: boolean; // second-pass check (Sonnet); undefined = not verified
  verdict?: string;
  glossaryHit?: string; // a known misheard term (user glossary) in the excerpt or correction; never drilled
}

// Deterministic ASR guard from a user glossary of known mishearings (team tool and product names
// the captioner renders as common words). An item whose excerpt or correction contains one is
// quarantined: coaching it would repeat the mishearing as if it were real speech.
export function applyGlossary(items: RealItem[], terms: string[]): number {
  const ts = terms.map(norm).filter(Boolean);
  let n = 0;
  for (const i of items) {
    const hay = ` ${norm(`${i.excerpt} ${i.correction}`)} `;
    const hit = ts.find((t) => hay.includes(` ${t} `));
    if (hit) {
      i.glossaryHit = hit;
      n++;
    }
  }
  return n;
}

const ASR_GUARD =
  "IMPORTANT: the lines are automatic speech recognition (ASR) output, not exactly what was said. ASR mishears names, product and technical terms and garbles fragments into nonsense, and it is worse on accented and code-switched speech. FIRST list in asr_suspects only tokens or fragments that are implausible in context (a nonsense phrase, a common word where a name or term is expected, an English word that is clearly a misheard French word or vice versa). Do NOT list grammar errors: in a language-learning context a grammatical error is the learner's, not the ASR's. THEN report error items. Never coach a misheard token, never invent content to repair a garbled fragment, and if an item depends on a suspect set asr_suspect=true. When a line is too garbled to know what was meant, skip it.";

export function buildRealPrompt(lines: WearerLine[], kind: WearerLine["kind"]) {
  const tax = (["fr", "en"] as const).flatMap((lang) => Object.entries(REAL_TAXONOMY[lang]).map(([t, d]) => `- ${t}: ${d}`)).join("\n");
  const system = [
    "You are a deliberate-practice speech coach for one person: an adult learner of French at high A2 / low B1 who also wants clearer spoken English. You find specific, drillable errors in transcripts of their real speech.",
    "Report only clear instances of the listed error types. FR_* types apply only to French words and EN_* types only to English words; a line may mix both languages (code-switching), which is not itself an error here.",
    "Each item must cite exactly one line id as given, quote the shortest exact excerpt from that line that shows the error, give the corrected excerpt, a re-say prompt (one full, natural corrected sentence to say aloud, in the same language as the error, that must NOT contain the error) and a one-sentence explanation in English.",
    "Do not report filler words (um, uh, euh, ben, like, you know), repetitions, punctuation or capitalization: those are measured separately or are transcription artifacts.",
    "Corrections must not invent facts (dates, numbers, names) absent from the line: use a <placeholder> instead. At most one item per (line, error type). Prefer precision over recall: an item you are unsure about is worse than a missed one.",
    ASR_GUARD,
  ].join("\n");
  const ctx =
    kind === "voice_note"
      ? "A solo voice note the wearer recorded on their Bee wearable. Every line is the wearer's own speech."
      : kind === "meeting"
        ? "The wearer's own lines from a real work video meeting, transcribed by the meeting tool's live captions (a different ASR from Bee, which also mishears names, product and technical terms). Each line is a caption chunk of up to about 45 seconds, not a sentence, and its punctuation is the captioner's guess. Other people's lines are omitted, so some lines are short replies or fragments."
        : "The wearer's own lines from a real conversation captured by their Bee wearable (Bee labelled these lines as the wearer). Other people's lines are omitted, so some lines are short replies or fragments.";
  const user = [`Context: ${ctx}`, "", "Error types:", tax, "", "Lines (id, detected language, text):", ...lines.map((l) => `[${l.key}] (${l.lang}) ${l.text}`)].join("\n");
  const item = {
    type: "object",
    properties: {
      utterance_id: { type: "string", description: "line id exactly as given, e.g. u:3750000000 or v:abc:2" },
      error_type: { type: "string", enum: ALL_REAL_TYPES },
      excerpt: { type: "string", description: "exact substring of that line" },
      correction: { type: "string" },
      resay_prompt: { type: "string" },
      explanation: { type: "string" },
      asr_suspect: { type: "boolean" },
    },
    required: ["utterance_id", "error_type", "excerpt", "correction", "resay_prompt", "explanation", "asr_suspect"],
  };
  const tool = {
    toolSpec: {
      name: "report_errors",
      description: "Report suspected ASR mishearings, then the error items found in the wearer's lines.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            asr_suspects: {
              type: "array",
              items: { type: "object", properties: { utterance_id: { type: "string" }, token: { type: "string" } }, required: ["utterance_id", "token"] },
            },
            items: { type: "array", items: item },
          },
          required: ["asr_suspects", "items"],
        },
      },
    },
  } as Parameters<CallToolFn>[0]["tool"];
  return { system, user, tool };
}

const RawItem = z.object({
  utterance_id: z.string(),
  error_type: z.string(),
  excerpt: z.string(),
  correction: z.string(),
  resay_prompt: z.string(),
  explanation: z.string(),
  asr_suspect: z.boolean().optional(),
});

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function extractRealItems(lines: WearerLine[], opts: { label: string; llm?: CallToolFn; chunkSize?: number }): Promise<{ items: RealItem[]; rejected: number; models: string[] }> {
  const llm = opts.llm ?? bedrockCallTool;
  const items: RealItem[] = [];
  const models: string[] = [];
  let rejected = 0;
  const bySession = new Map<string, WearerLine[]>();
  for (const l of lines.filter(coachable)) {
    if (wordCount(l.text) < 2) continue; // "Ah oui." has nothing to coach
    if (!bySession.has(l.session)) bySession.set(l.session, []);
    bySession.get(l.session)!.push(l);
  }
  for (const [session, ls] of bySession) {
    for (const [ci, part] of chunk(ls, opts.chunkSize ?? 60).entries()) {
      const p = buildRealPrompt(part, part[0]!.kind);
      const res = await llm({ ...p, label: `${opts.label}:${session}:${ci}` });
      models.push(res.modelId);
      const input = res.input as { items?: unknown[]; asr_suspects?: { utterance_id?: string; token?: string }[] };
      const suspects = (input.asr_suspects ?? []).map((a) => norm(a.token ?? "")).filter((t) => t.length > 0);
      const byKey = new Map(part.map((l) => [l.key, l]));
      const seen = new Set<string>();
      for (const r of input.items ?? []) {
        const it = RawItem.safeParse(r);
        if (!it.success || !ALL_REAL_TYPES.includes(it.data.error_type)) {
          rejected++;
          continue;
        }
        const key = it.data.utterance_id.replace(/^\[|\]$/g, "");
        const d = `${key}|${it.data.error_type}`;
        if (seen.has(d)) continue;
        seen.add(d);
        const line = byKey.get(key);
        const ex = norm(it.data.excerpt);
        items.push({
          key,
          session,
          kind: line?.kind ?? part[0]!.kind,
          lang: it.data.error_type.startsWith("FR_") ? "fr" : "en",
          error_type: it.data.error_type,
          excerpt: it.data.excerpt,
          correction: it.data.correction,
          resay_prompt: it.data.resay_prompt,
          explanation: it.data.explanation,
          // Deterministic guard: an excerpt containing a suspected mishearing is quarantined.
          asr_suspect: (it.data.asr_suspect ?? false) || suspects.some((s) => ex.includes(s) || s.includes(ex)),
          citation_valid: !!line,
          excerpt_grounded: !!line && ex.length > 0 && norm(line.text).includes(ex),
          line: line?.text ?? "",
        });
      }
    }
  }
  return { items, rejected, models };
}

// Second pass: a stronger model re-checks each candidate against its line and drops ASR
// artifacts, fragments of an interrupted sentence, non-errors and corrections that invent content.
export const VERIFIER_CHAIN = ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];

export async function verifyItems(items: RealItem[], opts: { label: string; llm?: CallToolFn }): Promise<{ models: string[] }> {
  const llm = opts.llm ?? bedrockCallTool;
  const cands = items.filter((i) => i.citation_valid && i.excerpt_grounded && !i.asr_suspect);
  if (!cands.length) return { models: [] };
  const system = [
    "You audit candidate speech-coaching items for one adult learner of French (high A2 / low B1) who also wants clearer spoken English. Each item quotes one of the learner's own transcribed lines (automatic speech recognition, possibly code-switched), an excerpt, an error type and a correction.",
    "Verdict per item:",
    "- real_error: the excerpt is clearly an error the learner made, of that type, and the correction fixes it without inventing content.",
    "- asr_artifact: the excerpt is more likely a transcription mishearing (nonsense, a misheard word) than the learner's error.",
    "- fragment: the line is an interrupted or incomplete fragment (a reply to someone, a sentence cut off), so the 'error' is just missing context.",
    "- not_an_error: acceptable spoken French or English (informal speech is fine), or the wrong error type.",
    "- invented: the correction or re-say adds facts or meaning the learner did not express.",
    "Be strict: when unsure, do not choose real_error.",
  ].join("\n");
  const tool = {
    toolSpec: {
      name: "audit_items",
      description: "Return one verdict per item.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                properties: { index: { type: "integer" }, verdict: { type: "string", enum: ["real_error", "asr_artifact", "fragment", "not_an_error", "invented"] }, reason: { type: "string" } },
                required: ["index", "verdict", "reason"],
              },
            },
          },
          required: ["verdicts"],
        },
      },
    },
  } as Parameters<CallToolFn>[0]["tool"];
  const models: string[] = [];
  for (const i of cands) i.verified = false; // missing verdict = not verified
  for (const [ci, part] of chunk(cands, 40).entries()) {
    const user = part
      .map((i, n) => `#${n}\nline: ${i.line}\ntype: ${i.error_type} (${REAL_TAXONOMY[i.lang][i.error_type] ?? ""})\nexcerpt: ${i.excerpt}\ncorrection: ${i.correction}\nre-say: ${i.resay_prompt}`)
      .join("\n\n");
    const res = await llm({ system, user, tool, label: `${opts.label}:verify:${ci}`, chain: VERIFIER_CHAIN });
    models.push(res.modelId);
    const p = z.object({ verdicts: z.array(z.object({ index: z.number(), verdict: z.string(), reason: z.string() })) }).safeParse(res.input);
    for (const v of p.success ? p.data.verdicts : []) {
      const i = part[v.index];
      if (!i) continue;
      i.verified = v.verdict === "real_error";
      i.verdict = `${v.verdict}: ${v.reason}`;
    }
  }
  return { models };
}

// Code-switch moments ("how do you say X?" / English inserted into French)

const ASK_RE = /\b(how do you say|how to say|what'?s the word|comment (?:on )?dit|comment (?:on )?dire|comment ça se dit|c'est quoi le mot)\b/i;

export interface CodeSwitch {
  key: string;
  session: string;
  trigger: "asked" | "inserted";
  english: string; // what the wearer reached for (excerpt of their line)
  french: string; // the French target
  resay_prompt: string;
  note: string;
  line: string;
  grounded: boolean;
}

// A "switch" that is just a name (a group, a venue, an app) is not vocabulary: drop it when the
// French target carries over a capitalized token from the English excerpt.
export function isProperNounSwitch(english: string, french: string): boolean {
  const caps = new Set((english.match(/\b\p{Lu}[\p{L}'-]+/gu) ?? []).map((w) => w.toLowerCase()));
  return (french.match(/\b\p{Lu}[\p{L}'-]+/gu) ?? []).some((w) => caps.has(w.toLowerCase()));
}

export function codeSwitchCandidates(lines: WearerLine[]): { line: WearerLine; trigger: "asked" | "inserted" }[] {
  const out: { line: WearerLine; trigger: "asked" | "inserted" }[] = [];
  const sessFr = new Map<string, number>();
  for (const l of lines) sessFr.set(l.session, (sessFr.get(l.session) ?? 0) + (l.dom === "fr" ? 1 : 0));
  for (const l of lines.filter(coachable)) {
    if (ASK_RE.test(l.text)) out.push({ line: l, trigger: "asked" });
    // An English insertion inside French speech, in a session where the wearer mostly speaks French.
    else if (l.lang === "mixed" && (sessFr.get(l.session) ?? 0) >= 3) out.push({ line: l, trigger: "inserted" });
  }
  return out;
}

export async function extractCodeSwitches(lines: WearerLine[], ctx: TransientContext, opts: { label: string; llm?: CallToolFn }): Promise<{ moments: CodeSwitch[]; models: string[] }> {
  const llm = opts.llm ?? bedrockCallTool;
  const cands = codeSwitchCandidates(lines);
  if (!cands.length) return { moments: [], models: [] };
  const system = [
    "You help an adult learner of French (high A2 / low B1) turn moments where they reached for English, or asked how to say something, into French vocabulary drills.",
    "For each candidate line decide whether the learner reached for English (or a calque) while speaking French. If yes, return: the exact English (or calqued) excerpt from the learner's line; the natural French word or phrase they needed (Canadian/standard French); a short natural French sentence for them to say aloud that uses it; a one-line note.",
    "Some candidates include what another person said right after, as context only. Use it to understand what was meant, but NEVER quote it: write the French target in your own words.",
    "Skip candidates where the English is a proper noun, a brand, an app name, a quoted title, or too garbled by transcription to know what was meant.",
  ].join("\n");
  const user = cands
    .map(({ line, trigger }) => {
      const replies = trigger === "asked" ? repliesAfter(ctx, line) : [];
      return [`[${line.key}] (${trigger}) ${line.text}`, ...replies.map((r) => `   context, another speaker, do not quote: ${r}`)].join("\n");
    })
    .join("\n");
  const tool = {
    toolSpec: {
      name: "vocab_moments",
      description: "Return the code-switch vocabulary moments worth drilling.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            moments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  utterance_id: { type: "string" },
                  english: { type: "string", description: "exact excerpt of the learner's line" },
                  french: { type: "string" },
                  resay_prompt: { type: "string" },
                  note: { type: "string" },
                },
                required: ["utterance_id", "english", "french", "resay_prompt", "note"],
              },
            },
          },
          required: ["moments"],
        },
      },
    },
  } as Parameters<CallToolFn>[0]["tool"];
  const res = await llm({ system, user, tool, label: `${opts.label}:codeswitch` });
  const parsed = z
    .object({ moments: z.array(z.object({ utterance_id: z.string(), english: z.string(), french: z.string(), resay_prompt: z.string(), note: z.string() })) })
    .safeParse(res.input);
  const byKey = new Map(cands.map((c) => [c.line.key, c]));
  const moments: CodeSwitch[] = [];
  for (const m of parsed.success ? parsed.data.moments : []) {
    const key = m.utterance_id.replace(/^\[|\]$/g, "");
    const c = byKey.get(key);
    if (!c || isProperNounSwitch(m.english, m.french)) continue;
    moments.push({
      key,
      session: c.line.session,
      trigger: c.trigger,
      english: m.english,
      french: m.french,
      resay_prompt: m.resay_prompt,
      note: m.note,
      line: c.line.text,
      grounded: norm(c.line.text).includes(norm(m.english)),
    });
  }
  return { moments, models: [res.modelId] };
}

// Drill cards

export interface Drill {
  id: string;
  kind: "error" | "vocab" | "filler";
  lang: "fr" | "en";
  type: string;
  key: string; // the real utterance id
  session: string;
  said: string;
  fix: string;
  resay: string;
  why: string;
  line: string; // wearer's own line (gitignored outputs only)
  score: number; // ranking
}

export const usableItem = (i: RealItem) => i.citation_valid && i.excerpt_grounded && !i.asr_suspect && i.verified !== false && !i.glossaryHit;

export function fillerDrills(lines: WearerLine[], max = 3): Drill[] {
  return lines
    .filter(coachable)
    .map((l) => ({ l, n: countRe(l.text, FILLER_RE[l.dom]), w: wordCount(l.text) }))
    // Single-language lines only: a code-switched line's "clean" version is still a mess to re-say.
    .filter((x) => x.n >= 3 && x.w >= 8 && x.l.lang !== "mixed")
    .sort((a, b) => b.n / b.w - a.n / a.w)
    .slice(0, max)
    .map(({ l, n, w }) => ({
      id: `FILLER:${l.key}`,
      kind: "filler" as const,
      lang: l.dom,
      type: l.dom === "fr" ? "FR_FILLERS" : "EN_FILLERS",
      key: l.key,
      session: l.session,
      said: l.text,
      fix: stripFillers(l.text, l.dom),
      resay: stripFillers(l.text, l.dom),
      why: `${n} fillers in ${w} words. Say it again and pause silently where each filler was.`,
      line: l.text,
      score: n / w,
    }));
}

export function buildDrills(items: RealItem[], vocab: CodeSwitch[], lines: WearerLine[]): Drill[] {
  const usable = items.filter(usableItem);
  const typeFreq = new Map<string, number>();
  for (const i of usable) typeFreq.set(i.error_type, (typeFreq.get(i.error_type) ?? 0) + 1);
  const errs: Drill[] = usable.map((i) => ({
    id: `${i.error_type}:${i.key}`,
    kind: "error",
    lang: i.lang,
    type: i.error_type,
    key: i.key,
    session: i.session,
    said: i.excerpt,
    fix: i.correction,
    resay: i.resay_prompt,
    why: i.explanation,
    line: i.line,
    // French first (the operator's goal: French for Canadian PR), then recurring types, then voice notes.
    score: (i.lang === "fr" ? 3 : 0) + (typeFreq.get(i.error_type) ?? 1) + (i.kind === "voice_note" ? 0.25 : 0),
  }));
  const voc: Drill[] = vocab
    .filter((v) => v.grounded)
    .map((v) => ({
      id: `VOCAB:${v.key}`,
      kind: "vocab",
      lang: "fr",
      type: v.trigger === "asked" ? "FR_VOCAB_ASKED" : "FR_VOCAB_SWITCH",
      key: v.key,
      session: v.session,
      said: v.english,
      fix: v.french,
      resay: v.resay_prompt,
      why: `You reached for English here ("${v.english}"); say it in French. ${v.note}`,
      line: v.line,
      score: v.trigger === "asked" ? 3.5 : 1.5,
    }));
  return [...errs, ...voc, ...fillerDrills(lines)].sort((a, b) => b.score - a.score);
}
