// Real-data corpus: pulls conversations (and voice notes) through a BeeSource, keeps the wearer's
// lines only, and runs the mislabel detector.
//
// PRIVACY CONTRACT. `RealCorpus.conversations` / `.voiceNotes` hold the wearer's lines only and are
// the only things ever persisted (to gitignored real/ and out/). Other speakers' lines live in
// `TransientContext`, an in-memory map that is never serialized; it exists only so an LLM prompt
// can see the reply to a "how do you say X?" moment. test/privacy.test.ts enforces this.
import type { ConversationDetail, Me } from "../bee/schemas.js";
import { epochMs, pickUtterances, type BeeSource } from "../bee/source.js";
import { splitSentences } from "../analyze/segment.js";
import { detectMislabels } from "./mislabel.js";
import { dominantLang, lineLang, type LineLang } from "./text.js";
import { discoverWearerLabels, isWearer, type WearerLabels } from "./wearer.js";

export interface WearerLine {
  key: string; // u:<utteranceId> | v:<journalId>:<sentenceIndex> | m:<meetingId>:<lineIndex>
  session: string; // conversation id, journal id or meeting id
  kind: "conversation" | "voice_note" | "meeting"; // meeting: a video-meeting caption transcript (src/real/tactiq.ts)
  start: number | null;
  end: number | null;
  spokenAt: number | null;
  text: string;
  lang: LineLang;
  dom: "fr" | "en";
  uncertain: boolean; // mislabel detector: maybe not the wearer; never drilled by default
  mislabelScore: number;
  reasons: string[];
}

export interface SessionStats {
  id: string;
  kind: "conversation" | "voice_note" | "meeting";
  state: string;
  startMs: number;
  totalLines: number;
  wearerLines: number; // labelled as the wearer
  uncertainLines: number; // of those, flagged by the mislabel detector
  wearerShare: number; // wearerLines / totalLines
  skipped?: string;
  realtimeOnly?: boolean; // included from a still-capturing realtime transcript (labels may change on completion)
}

export interface RealCorpus {
  generatedAt: string;
  wearer: WearerLabels;
  sessions: SessionStats[];
  lines: WearerLine[]; // wearer lines only
}

export interface OtherLine {
  start: number | null;
  end: number | null;
  text: string;
}
// session id -> other speakers' lines, in time order. NEVER persist.
export type TransientContext = Map<string, OtherLine[]>;

export interface SourceWithProfile extends BeeSource {
  me?(): Promise<Me>;
}

export async function loadRealCorpus(
  src: SourceWithProfile,
  opts: { sinceMs?: number; untilMs?: number; ids?: number[]; includeVoiceNotes?: boolean; me?: Me | null } = {},
): Promise<{ corpus: RealCorpus; context: TransientContext }> {
  const sinceMs = opts.sinceMs ?? 0;
  const untilMs = opts.untilMs ?? Number.POSITIVE_INFINITY;
  const me = opts.me !== undefined ? opts.me : src.me ? await src.me().catch(() => null) : null;
  const summaries = (await src.conversations(sinceMs)).filter((s) => s.start_time < untilMs && (!opts.ids || opts.ids.includes(s.id)));
  const details = [];
  for (const s of summaries) {
    const c = await src.conversation(s.id);
    if (c) details.push(c);
  }
  // Discover the wearer's labels from the whole pull (labels and counts only).
  const wearer = discoverWearerLabels(speakerCounts(details), me);
  const { sessions, lines, context } = conversationLines(details, wearer);

  if (opts.includeVoiceNotes !== false) {
    for (const j of await src.voiceNotes(sinceMs)) {
      const t = epochMs(j.created_at);
      if (t >= untilMs || !j.text) continue;
      // Voice notes are wearer-only by construction (push-to-talk). Raw `text`, never cleanedUpText.
      const sents = splitSentences(j.text);
      const dom = dominantLang(j.text);
      sents.forEach((s, i) =>
        lines.push({ key: `v:${j.id}:${i}`, session: j.id, kind: "voice_note", start: null, end: null, spokenAt: t, text: s, lang: lineLang(s), dom: dominantLang(s, dom), uncertain: false, mislabelScore: 0, reasons: [] }),
      );
      sessions.push({ id: j.id, kind: "voice_note", state: j.state, startMs: t, totalLines: sents.length, wearerLines: sents.length, uncertainLines: 0, wearerShare: 1 });
    }
  }
  sessions.sort((a, b) => a.startMs - b.startMs);
  return { corpus: { generatedAt: new Date().toISOString(), wearer, sessions, lines }, context };
}

// Speaker label -> utterance count over the final transcriptions (labels and counts only).
export function speakerCounts(details: ConversationDetail[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of details) for (const u of pickUtterances(c)) counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
  return counts;
}

// The wearer filter and the mislabel detector over fetched conversations: per-conversation counts,
// the wearer's lines, and (in memory only) everyone else's. The offline pipeline (loadRealCorpus) and
// the hub's live ingest (src/hub/ingest.ts) both go through here.
export function conversationLines(details: ConversationDetail[], wearer: WearerLabels): { sessions: SessionStats[]; lines: WearerLine[]; context: TransientContext } {
  const sessions: SessionStats[] = [];
  const lines: WearerLine[] = [];
  const context: TransientContext = new Map();
  for (const c of details) {
    const utts = pickUtterances(c);
    const final = c.transcriptions.some((t) => !t.realtime);
    const stat: SessionStats = { id: String(c.id), kind: "conversation", state: c.state, startMs: c.start_time, totalLines: utts.length, wearerLines: 0, uncertainLines: 0, wearerShare: 0 };
    // Bee restarts `start`/`end` offsets at 0 when a later recording is appended to the same open
    // conversation (observed 2026-10-15, FL-6), so place every utterance on one timeline derived from
    // `spoken_at` (epoch ms) relative to the conversation start; fall back to the raw offsets.
    const onTimeline = <U extends { start: number | null; end: number | null; spoken_at: number | null }>(u: U) => {
      if (u.spoken_at == null || !c.start_time) return { start: u.start, end: u.end };
      const s = (u.spoken_at - c.start_time) / 1000;
      const dur = u.start != null && u.end != null ? Math.max(0, u.end - u.start) : 0;
      return { start: s, end: s + dur };
    };
    const mine = utts.filter((u) => isWearer(u.speaker, wearer));
    // Wearer labels can already be present on realtime-only (still capturing) transcripts
    // (observed 2026-10-15, FL-3), so only skip when no wearer line exists yet.
    if (!final && mine.length === 0) {
      stat.skipped = "realtime transcription only (still capturing) with no wearer-labelled lines yet; rerun later";
      sessions.push(stat);
      continue;
    }
    if (!final) stat.realtimeOnly = true;
    context.set(
      String(c.id),
      utts.filter((u) => !isWearer(u.speaker, wearer)).map((u) => ({ ...onTimeline(u), text: u.text })),
    );
    const verdicts = detectMislabels(mine.map((u) => ({ id: u.id, ...onTimeline(u), text: u.text })));
    const convDom = dominantLang(mine.map((u) => u.text).join(" "));
    for (const u of mine) {
      const v = verdicts.get(u.id)!;
      lines.push({
        key: `u:${u.id}`,
        session: String(c.id),
        kind: "conversation",
        ...onTimeline(u),
        spokenAt: u.spoken_at,
        text: u.text,
        lang: lineLang(u.text),
        dom: dominantLang(u.text, convDom),
        uncertain: v.uncertain,
        mislabelScore: v.score,
        reasons: v.reasons,
      });
    }
    stat.wearerLines = mine.length;
    stat.uncertainLines = [...verdicts.values()].filter((v) => v.uncertain).length;
    stat.wearerShare = utts.length ? Math.round((mine.length / utts.length) * 1000) / 1000 : 0;
    sessions.push(stat);
  }
  return { sessions, lines, context };
}

// Other speakers' lines right after a wearer line (for "how do you say X?"). Transient only.
export function repliesAfter(ctx: TransientContext, line: WearerLine, n = 2, withinSec = 20): string[] {
  const others = ctx.get(line.session) ?? [];
  const t0 = line.end ?? line.start ?? 0;
  return others
    .filter((o) => o.start != null && o.start >= (line.start ?? 0) && o.start - t0 <= withinSec)
    .slice(0, n)
    .map((o) => o.text);
}
