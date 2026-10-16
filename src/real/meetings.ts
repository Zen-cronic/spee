// Meetings benchmark: English communication coaching on the wearer's lines from meeting caption
// transcripts. Per-meeting and pooled metrics, a trend across meetings, the candidate -> guard ->
// verify -> drill funnel, and a private markdown report. Aggregates (summary) carry no text;
// the report quotes the wearer's own lines only.
import { lexical } from "../analyze/metrics.js";
import { rates, usableItem, type LangRates, type RealItem } from "./analyze.js";
import type { RealCorpus } from "./corpus.js";
import type { Analysis } from "./pipeline.js";
import type { MeetingTimeline } from "./tactiq.js";
import { rateCi95, talkMetrics, wearerTurns, type TalkMetrics } from "./talk.js";

export interface Funnel {
  candidates: number;
  rejectedSchema: number;
  ungrounded: number; // bad citation or excerpt not in the line
  asrSuspect: number; // quarantined by the LLM's own ASR guard
  passedGuard: number;
  verifierDropped: number;
  verifierKept: number;
  glossaryDropped: number; // verifier-kept items that carried a known misheard term
  kept: number; // drilled
  keptByType: Record<string, number>;
  verdicts: Record<string, number>;
}

export function funnel(items: RealItem[], rejected = 0): Funnel {
  const grounded = items.filter((i) => i.citation_valid && i.excerpt_grounded);
  const passed = grounded.filter((i) => !i.asr_suspect);
  const vKept = passed.filter((i) => i.verified !== false);
  const kept = items.filter(usableItem);
  const keptByType: Record<string, number> = {};
  for (const i of kept) keptByType[i.error_type] = (keptByType[i.error_type] ?? 0) + 1;
  const verdicts: Record<string, number> = {};
  for (const i of passed) {
    const v = i.verdict?.split(":")[0] ?? "unverified";
    verdicts[v] = (verdicts[v] ?? 0) + 1;
  }
  return {
    candidates: items.length,
    rejectedSchema: rejected,
    ungrounded: items.length - grounded.length,
    asrSuspect: grounded.length - passed.length,
    passedGuard: passed.length,
    verifierDropped: passed.length - vKept.length,
    verifierKept: vKept.length,
    glossaryDropped: vKept.filter((i) => i.glossaryHit).length,
    kept: kept.length,
    keptByType,
    verdicts,
  };
}

export interface MeetingMetrics {
  id: string;
  date: string;
  durationMin: number | null;
  speakers: number;
  totalLines: number;
  wearerLines: number;
  highlightLinesSkipped: number;
  langLines: Record<string, number>;
  en: LangRates;
  fillersCi95: [number, number];
  crossSourceFillersPer100: number; // um/uh/er/ah/hmm... per 100 whitespace tokens (cross-source list)
  umUhPer100: number; // um + uh per 100 words (the part every ASR comparison shares)
  talk: TalkMetrics;
  funnel: Funnel;
  drills: { error: number; filler: number };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function metricsFor(id: string, date: string, corpus: RealCorpus, timelines: MeetingTimeline[], analysis: Analysis, rejected: number): MeetingMetrics {
  const ids = new Set(timelines.map((t) => t.session));
  const ls = corpus.lines.filter((l) => ids.has(l.session));
  const en = rates(ls.filter((l) => !l.uncertain)).en;
  const enTexts = ls.filter((l) => l.dom === "en" && !l.uncertain).map((l) => l.text);
  const um = (en.fillerBreakdown["um"] ?? 0) + (en.fillerBreakdown["uh"] ?? 0) + Object.entries(en.fillerBreakdown).filter(([k]) => /^(um{2,}|uh{2,})$/.test(k)).reduce((n, [, v]) => n + v, 0);
  const items = analysis.items.filter((i) => ids.has(i.session));
  const drills = analysis.drills.filter((d) => ids.has(d.session) && d.lang === "en");
  const sessions = corpus.sessions.filter((s) => ids.has(s.id));
  return {
    id,
    date,
    durationMin: timelines.reduce<number | null>((n, t) => (t.durationMin == null ? n : (n ?? 0) + t.durationMin), null),
    speakers: Math.max(0, ...timelines.map((t) => t.speakers)),
    totalLines: sessions.reduce((n, s) => n + s.totalLines, 0),
    wearerLines: ls.length,
    highlightLinesSkipped: timelines.reduce((n, t) => n + t.highlightLinesSkipped, 0),
    langLines: ls.reduce<Record<string, number>>((m, l) => ((m[l.lang] = (m[l.lang] ?? 0) + 1), m), {}),
    en,
    fillersCi95: rateCi95(en.fillers, en.words),
    crossSourceFillersPer100: enTexts.length ? lexical("en", enTexts).crossSourceFillersPer100 : 0,
    umUhPer100: en.words ? r2((um / en.words) * 100) : 0,
    talk: talkMetrics(timelines, ls),
    funnel: funnel(items, rejected),
    drills: { error: drills.filter((d) => d.kind === "error").length, filler: drills.filter((d) => d.kind === "filler").length },
  };
}

export interface TrendRow {
  metric: string;
  values: (number | null)[];
  note: string;
}

export interface MeetingsSummary {
  generatedAt: string;
  meetings: MeetingMetrics[];
  pooled: MeetingMetrics;
  trend: TrendRow[];
}

const ciOverlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

export function summarizeMeetings(corpus: RealCorpus, timelines: MeetingTimeline[], analysis: Analysis): MeetingsSummary {
  const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString("en-CA", { timeZone: process.env.BEE_TZ ?? "America/Toronto" }) : "unknown");
  const meetings = corpus.sessions
    .filter((s) => s.kind === "meeting")
    .map((s) => metricsFor(s.id, date(s.startMs), corpus, timelines.filter((t) => t.session === s.id), analysis, 0));
  const pooled = metricsFor("pooled", "all", corpus, timelines, analysis, analysis.rejected);
  const row = (metric: string, f: (m: MeetingMetrics) => number | null, note = ""): TrendRow => ({ metric, values: meetings.map(f), note });
  // A rate change between two meetings counts only when their 95% intervals do not overlap.
  const solid = meetings.filter((m) => m.en.words >= 200);
  let fillerNote = "fewer than two meetings with at least 200 words: no trend claim";
  if (solid.length >= 2) {
    const a = solid[0]!,
      b = solid.at(-1)!;
    fillerNote = ciOverlap(a.fillersCi95, b.fillersCi95)
      ? `${a.id} → ${b.id}: 95% intervals overlap, so no measurable change`
      : `${a.id} → ${b.id}: ${b.en.fillersPer100 < a.en.fillersPer100 ? "down" : "up"}, and the 95% intervals do not overlap`;
  }
  const trend = [
    row("Your words", (m) => m.en.words, "meetings under 200 words are too small to read a rate from"),
    row("Fillers /100 words (um, uh, like, you know)", (m) => m.en.fillersPer100, fillerNote),
    row("um + uh /100 words", (m) => m.umUhPer100),
    row("'like' /100 words", (m) => (m.en.words ? r2(((m.en.fillerBreakdown["like"] ?? 0) / m.en.words) * 100) : 0)),
    row("Hedges /100 words", (m) => m.en.hedgesPer100),
    row("Restarts /100 words", (m) => m.talk.per100.restarts),
    row("Vague tags /100 words", (m) => m.talk.per100.vague),
    row("'and yeah' / 'so yeah' /100 words", (m) => m.talk.per100.yeahTics),
    row("Trailing-off sentences /100 words", (m) => m.talk.per100.trailingOff),
    row("Talk share (% of words)", (m) => m.talk.talkShareWords),
    row("Avg substantive turn (words)", (m) => m.talk.avgTurnWords),
    row("Longest turn (words)", (m) => m.talk.longestTurnWords),
    row("Kept drills", (m) => m.funnel.kept),
  ];
  return { generatedAt: new Date().toISOString(), meetings, pooled, trend };
}

// Private report (gitignored out/meetings.md): the wearer's own lines only.
export function renderMeetingsReport(s: MeetingsSummary, corpus: RealCorpus, timelines: MeetingTimeline[], analysis: Analysis, extra: { comparison?: string[]; warnings?: string[] } = {}): string {
  const esc = (x: string) => x.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const cols = [...s.meetings, s.pooled];
  const head = `| Metric | ${cols.map((m) => m.id).join(" | ")} |`;
  const sep = `|---|${cols.map(() => "---").join("|")}|`;
  const tr = (label: string, f: (m: MeetingMetrics) => string | number | null) => `| ${label} | ${cols.map((m) => f(m) ?? "n/a").join(" | ")} |`;
  const bd = (b: Record<string, number>) => Object.entries(b).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ×${v}`).join(", ") || "none";
  const out: string[] = ["# Meetings: English communication coaching", "", "Private (gitignored). Your own lines only; other speakers appear as counts.", ""];
  for (const w of extra.warnings ?? []) out.push(`> ${w}`, "");
  out.push("## Metrics", "", head, sep);
  out.push(
    tr("Duration (min)", (m) => m.durationMin),
    tr("Caption lines (all) / yours", (m) => `${m.totalLines} / ${m.wearerLines}`),
    tr("Your English words", (m) => m.en.words),
    tr("Talk share, words (time est.)", (m) => `${m.talk.talkShareWords}% (${m.talk.talkShareTime ?? "n/a"}%)`),
    tr("Fillers /100 [95% CI]", (m) => `${m.en.fillersPer100} [${m.fillersCi95[0]}–${m.fillersCi95[1]}]`),
    tr("Filler breakdown", (m) => esc(bd(m.en.fillerBreakdown))),
    tr("Cross-source list /100 tokens", (m) => m.crossSourceFillersPer100),
    tr("Hedges /100", (m) => m.en.hedgesPer100),
    tr("Hedge breakdown", (m) => esc(bd(m.en.hedgeBreakdown))),
    tr("Restarts /100", (m) => m.talk.per100.restarts),
    tr("Vague tags /100", (m) => `${m.talk.per100.vague} (${esc(bd(m.talk.vagueBreakdown))})`),
    tr("Turns (substantive / backchannel)", (m) => `${m.talk.turns} (${m.talk.substantiveTurns} / ${m.talk.backchannels})`),
    tr("Avg substantive turn, words", (m) => m.talk.avgTurnWords),
    tr("Longest turn, words (sec est.)", (m) => `${m.talk.longestTurnWords} (${m.talk.longestTurnSec ?? "n/a"})`),
    tr("Questions / tag / uptalk", (m) => `${m.talk.questions} / ${m.talk.tagQuestions} / ${m.talk.uptalk}`),
    tr("Trailing-off sentences", (m) => `${m.talk.trailingOff} of ${m.talk.sentences}`),
    tr("Turns ending on yeah/so/and", (m) => `${m.talk.tailEndings} of ${m.talk.substantiveTurns}`),
    tr("'and/so yeah' tics", (m) => m.talk.yeahTics),
    tr("Candidates → guard → verifier → kept", (m) => `${m.funnel.candidates} → ${m.funnel.passedGuard} → ${m.funnel.verifierKept} → ${m.funnel.kept}`),
  );
  out.push("", "## Trend", "", `| Metric | ${s.meetings.map((m) => m.id).join(" | ")} | Note |`, `|---|${s.meetings.map(() => "---").join("|")}|---|`);
  for (const t of s.trend) out.push(`| ${t.metric} | ${t.values.map((v) => v ?? "n/a").join(" | ")} | ${t.note} |`);
  if (extra.comparison?.length) out.push("", "## Other transcription sources", "", ...extra.comparison);
  const errs = analysis.drills.filter((d) => d.kind === "error" && d.lang === "en");
  out.push("", `## Drills kept (${errs.length})`, "");
  if (!errs.length) out.push("_None._");
  errs.forEach((d, i) => out.push(`${i + 1}. **${d.type}** (\`${d.key}\`)`, `   - You said: "${esc(d.said)}"`, `   - Say: "${esc(d.fix)}"`, `   - Re-say: ${esc(d.resay)}`, `   - Why: ${esc(d.why)}`));
  const fd = analysis.drills.filter((d) => d.kind === "filler" && d.lang === "en");
  if (fd.length) {
    out.push("", "## Filler drills", "");
    for (const d of fd) out.push(`- \`${d.key}\`: ${d.why}`, `  - Clean: "${esc(d.fix)}"`);
  }
  const longest = [...wearerTurns(timelines, corpus.lines)].sort((a, b) => b.words - a.words)[0];
  if (longest) out.push("", "## Longest turn", "", `${longest.session}, ${longest.words} words over about ${longest.endSec != null ? longest.endSec - longest.startSec : "?"} s. Practise it as: one-line headline, then at most three points, then the ask.`);
  const dropped = analysis.items.filter((i) => !usableItem(i));
  out.push("", `## Dropped candidates (${dropped.length})`, "");
  for (const i of dropped)
    out.push(`- ${i.error_type} \`${i.key}\` "${esc(i.excerpt)}": ${!i.citation_valid || !i.excerpt_grounded ? "ungrounded" : i.asr_suspect ? "ASR suspect" : i.glossaryHit ? `glossary (${i.glossaryHit})` : esc(i.verdict ?? "dropped")}`);
  out.push("");
  return out.join("\n");
}
