// Real-data path: wearer filter, language routing, filler/hedge metrics, mislabel detector,
// code-switch handling, drills, deck, and the privacy contract. All synthetic inputs; no CLI, no LLM.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConversationDetail, Journal } from "../src/bee/schemas.js";
import type { BeeSource } from "../src/bee/source.js";
import type { CallToolFn } from "../src/llm/bedrock.js";
import { ALLOWED_MODELS, MODEL_CHAIN } from "../src/llm/bedrock.js";
import { buildDrills, codeSwitchCandidates, isProperNounSwitch, rates } from "../src/real/analyze.js";
import { loadRealCorpus } from "../src/real/corpus.js";
import { addDays, dueOn, markReviewed, updateDeck, type Deck } from "../src/real/deck.js";
import { detectMislabels } from "../src/real/mislabel.js";
import { parseLabels, sampleForLabelling, scoreLabels } from "../src/real/mislabelScore.js";
import { analyzeCorpus } from "../src/real/pipeline.js";
import { renderClass, renderMislabelSample } from "../src/real/render.js";
import { FILLER_RE, HEDGE_RE, countRe, lineLang, stripFillers } from "../src/real/text.js";
import { discoverWearerLabels, matchesProfile } from "../src/real/wearer.js";

const ME = { id: 1, first_name: "Ada Mae", last_name: "Lovelace", timezone: "America/Toronto" };
const SECRET = "OTHER-SPEAKER-SECRET";

function conv(id: number, utts: [string, string, number, number][], realtime = false): ConversationDetail {
  return {
    id, start_time: 1_792_000_000_000 + id * 1000, end_time: null, device_type: "unknown", summary: null, short_summary: null,
    state: realtime ? "CAPTURING" : "COMPLETED", created_at: 1, updated_at: 1,
    transcriptions: [{ id: id * 10, realtime, utterances: utts.map(([speaker, text, start, end], i) => ({ id: id * 1000 + i, realtime, start, end, spoken_at: 1_792_000_000_000, text, speaker, created_at: 1 })) }],
    suggested_links: [], primary_location: null,
  };
}

class FakeSource implements BeeSource {
  readonly kind = "fake";
  constructor(private convs: ConversationDetail[], private notes: Journal[] = []) {}
  async me() { return ME; }
  async conversations(since: number) {
    return this.convs.filter((c) => c.start_time >= since).map((c) => ({ id: c.id, start_time: c.start_time, end_time: c.end_time, created_at: c.created_at, summary: null, state: c.state }));
  }
  async conversation(id: number) { return structuredClone(this.convs.find((c) => c.id === id) ?? null); }
  async voiceNotes() { return this.notes; }
}

describe("wearer filter", () => {
  it("matches profile-name labels (full or first token), never Unknown", () => {
    expect(matchesProfile("Ada", ME)).toBe(true);
    expect(matchesProfile("Ada Mae", ME)).toBe(true);
    expect(matchesProfile("Unknown", ME)).toBe(false);
    expect(matchesProfile("Bob", ME)).toBe(false);
  });
  it("discovers labels from the profile, else a single named label, else none", () => {
    expect(discoverWearerLabels({ Unknown: 9, Ada: 3, "Ada Mae": 5 }, ME, "").labels).toEqual(["Ada", "Ada Mae"]);
    const single = discoverWearerLabels({ Unknown: 9, Zed: 4 }, null, "");
    expect(single).toMatchObject({ labels: ["Zed"], method: "single-named-label" });
    expect(discoverWearerLabels({ Unknown: 9 }, ME, "").method).toBe("none");
    expect(discoverWearerLabels({ Unknown: 9 }, ME, "X,Y").labels).toEqual(["X", "Y"]);
  });
});

describe("language and lexicon", () => {
  it("routes lines as fr / en / mixed", () => {
    expect(lineLang("Je suis allé au cours de français hier soir.")).toBe("fr");
    expect(lineLang("I think we should ship it today.")).toBe("en");
    expect(lineLang("Mais le film est how do you say boring et voilà, c'est la fin")).toBe("mixed");
  });
  it("counts fillers per language, with um/uh in French and filler-only like in English", () => {
    expect(countRe("Uh, qui s'appelle uh euh ben le groupe", FILLER_RE.fr)).toBe(4);
    expect(countRe("I don't have like a way, you know, um", FILLER_RE.en)).toBe(3);
    expect(countRe("I like it and I feel like going, something like that", FILLER_RE.en)).toBe(0);
    expect(countRe("I think it's maybe kind of done", HEDGE_RE.en)).toBe(3);
    expect(countRe("Je pense que c'est un peu difficile", HEDGE_RE.fr)).toBe(2);
    expect(stripFillers("Um, so uh I was like, you know, there", "en")).toBe("so I was, there");
  });
});

describe("mislabel detector", () => {
  it("flags assistant phrasing and narration, keeps disfluent wearer speech", () => {
    const v = detectMislabels([
      { id: 1, start: 0, end: 5, text: "Uh, c'est uh le cours du mardi, comment on dit homework?" },
      { id: 2, start: 10, end: 20, text: "D'après mes recherches, le musée ouvre à neuf heures tous les jours de la semaine." },
      { id: 3, start: 21, end: 30, text: "Elle a fondé la boulangerie en 1990 et elle a publié trois livres de recettes." },
      { id: 4, start: 40, end: 44, text: "Yeah, I I think that's right." },
    ]);
    expect(v.get(1)!.uncertain).toBe(false);
    expect(v.get(2)!.uncertain).toBe(true);
    expect(v.get(3)!.uncertain).toBe(true);
    expect(v.get(4)!.uncertain).toBe(false);
  });
  it("charges the fluent line, not the disfluent one, when two wearer lines overlap", () => {
    const v = detectMislabels([
      { id: 1, start: 0, end: 20, text: "Um so I was uh thinking that we could, you know, try it" },
      { id: 2, start: 2, end: 18, text: "The festival brings together artists from many countries every single summer season." },
    ]);
    expect(v.get(2)!.reasons.some((r) => r.startsWith("overlaps"))).toBe(true);
    expect(v.get(1)!.uncertain).toBe(false);
  });
  it("samples blind and scores operator labels", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ key: `u:${i}`, session: i < 10 ? "1" : "2", kind: "conversation" as const, start: i, end: i + 1, spokenAt: 0, text: `line ${i}`, lang: "en" as const, dom: "en" as const, uncertain: i < 3, mislabelScore: 0, reasons: [] }));
    const s = sampleForLabelling(lines);
    expect(s.filter((l) => l.uncertain)).toHaveLength(3);
    expect(s).toHaveLength(3 + 7 + 10); // flagged + all 7 other lines of session 1 + 10 of session 2
    const md = renderMislabelSample(s);
    expect(md).not.toMatch(/uncertain|reasons/);
    const labelled = md.replace(/## \d+\. u:0\n([\s\S]*?)label: \?/, (m) => m.replace("label: ?", "label: not")).replace(/## \d+\. u:1\n([\s\S]*?)label: \?/, (m) => m.replace("label: ?", "label: me"));
    const sc = scoreLabels(parseLabels(labelled), new Set(["u:0", "u:1", "u:2"]));
    expect(sc).toMatchObject({ tp: 1, fp: 1, precision: 50 });
  });
});

describe("code-switch vocabulary", () => {
  it("finds asked-for words and drops proper-noun 'switches'", () => {
    const mk = (key: string, text: string) => ({ key, session: "9", kind: "conversation" as const, start: 0, end: 1, spokenAt: 0, text, lang: lineLang(text), dom: "fr" as const, uncertain: false, mislabelScore: 0, reasons: [] });
    const c = codeSwitchCandidates([mk("u:1", "Comment on dit homework?"), mk("u:2", "Oui, les devoirs."), mk("u:3", "Je suis allé au cours."), mk("u:4", "Le groupe est là.")]);
    expect(c.map((x) => [x.line.key, x.trigger])).toEqual([["u:1", "asked"]]);
    expect(isProperNounSwitch("the French Meetup for", "le groupe s'appelle French Meetup")).toBe(true);
    expect(isProperNounSwitch("homework", "les devoirs")).toBe(false);
  });
});

describe("privacy contract and class pipeline (fake source, stub LLM)", () => {
  const src = new FakeSource(
    [
      conv(1, [
        ["Unknown", `Bonjour tout le monde ${SECRET} on commence.`, 0, 3],
        ["Ada Mae", "Uh, j'ai vu cette livre à la bibliothèque, comment on dit borrow?", 4, 9],
        ["Unknown", `Emprunter ${SECRET}.`, 9, 10],
        ["Ada", "Ah oui, emprunter. Um, demain je rendre le livre.", 10, 14],
      ]),
      conv(2, [["Unknown", `${SECRET} realtime only`, 0, 2]], true),
    ],
    [{ id: "j1", text: "Euh, hier soir j'ai allé au cours. C'était bien.", state: "READY", created_at: 1_792_000_100_000, updated_at: 1 }],
  );
  const stub: CallToolFn = async (o) => {
    const name = o.tool.toolSpec!.name;
    if (name === "report_errors")
      return { modelId: "stub", cached: false, input: { asr_suspects: [], items: o.user.includes("cette livre") ? [{ utterance_id: "u:1001", error_type: "FR_GENDER", excerpt: "cette livre", correction: "ce livre", resay_prompt: "J'ai vu ce livre.", explanation: "livre (book) is masculine", asr_suspect: false }] : [] } };
    if (name === "audit_items") return { modelId: "stub", cached: false, input: { verdicts: [{ index: 0, verdict: "real_error", reason: "ok" }] } };
    if (name === "vocab_moments") {
      expect(o.user).toContain("do not quote"); // the reply is passed as context only
      return { modelId: "stub", cached: false, input: { moments: [{ utterance_id: "u:1001", english: "borrow", french: "emprunter", resay_prompt: "Je vais emprunter ce livre.", note: "" }] } };
    }
    return { modelId: "stub", cached: false, input: {} };
  };

  it("persists wearer lines only; other speakers' text never reaches the corpus, drills or report", async () => {
    const { corpus, context } = await loadRealCorpus(src, {});
    expect(corpus.wearer.method).toBe("profile-name");
    const c1 = corpus.sessions.find((s) => s.id === "1")!;
    expect(c1).toMatchObject({ totalLines: 4, wearerLines: 2, wearerShare: 0.5 });
    expect(corpus.sessions.find((s) => s.id === "2")!.skipped).toMatch(/realtime/);
    expect(corpus.lines.filter((l) => l.kind === "voice_note")).toHaveLength(2);
    expect(JSON.stringify(corpus)).not.toContain(SECRET);
    expect(JSON.stringify([...context.values()])).toContain(SECRET); // transient context exists in memory only

    const a = await analyzeCorpus(corpus, context, { label: "t", llm: stub });
    expect(a.drills.find((d) => d.type === "FR_GENDER")).toMatchObject({ key: "u:1001", said: "cette livre" });
    expect(a.drills.find((d) => d.kind === "vocab")).toMatchObject({ fix: "emprunter" });
    const md = renderClass({ date: "2026-10-15", sinceIso: "x", corpus, analysis: a, tomorrow: [], tomorrowDate: "2026-10-16", relapsed: [], warnings: [] });
    for (const out of [JSON.stringify(a), md]) expect(out).not.toContain(SECRET);
    expect(md).toContain("cette livre");
  });

  it("filler and hedge rates come from wearer lines, split by language", async () => {
    const { corpus } = await loadRealCorpus(src, { includeVoiceNotes: false });
    const r = rates(corpus.lines);
    expect(r.fr.fillers).toBe(2);
    expect(r.fr.fillerBreakdown).toEqual({ uh: 1, um: 1 });
  });
});

describe("Leitner deck", () => {
  const d = (id: string, type: string, session: string, kind: "error" | "vocab" = "error") => ({ id, kind, lang: "fr" as const, type, key: id, session, said: "x", fix: "y", resay: "z", why: "", line: "x", score: 1 });
  it("adds new cards due tomorrow, relapses recurring types, promotes on review", () => {
    const deck: Deck = { cards: [] };
    const now = Date.parse("2026-10-15T23:00:00-04:00");
    updateDeck(deck, [d("a", "FR_GENDER", "s1"), d("v", "FR_VOCAB_ASKED", "s1", "vocab")], now);
    expect(deck.cards.map((c) => c.due)).toEqual(["2026-10-16", "2026-10-16"]);
    expect(dueOn(deck, "2026-10-16").map((c) => c.kind).sort()).toEqual(["error", "vocab"]);
    markReviewed(deck, "a", now);
    expect(deck.cards[0]).toMatchObject({ box: 2, due: addDays("2026-10-15", 2) });
    const { relapsed } = updateDeck(deck, [d("b", "FR_GENDER", "s2")], now + 86_400_000);
    expect(relapsed.map((c) => c.id)).toEqual(["a"]);
    expect(deck.cards[0]!.box).toBe(1);
  });
});

describe("model allowlist", () => {
  it("only the three approved models can ever be invoked", () => {
    expect([...ALLOWED_MODELS].sort()).toEqual(["openai.gpt-oss-120b-1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]);
    // qwen may sit in the legacy chain string but is skipped at call time
    expect(MODEL_CHAIN.filter((m) => !ALLOWED_MODELS.has(m))).toEqual(["qwen.qwen3-next-80b-a3b"]);
    const src = readFileSync("src/llm/bedrock.ts", "utf8");
    expect(src).toMatch(/if \(!ALLOWED_MODELS\.has\(modelId\)\)/);
  });
});

describe("Bee timeline quirks (FL-3, FL-6)", () => {
  it("orders appended recordings by spoken_at when start offsets restart, and keeps wearer lines from realtime-only transcripts", async () => {
    const t0 = 1_792_100_000_000;
    const u = (id: number, speaker: string, text: string, start: number, end: number, spoken_at: number) =>
      ({ id, realtime: true, start, end, spoken_at, text, speaker, created_at: 1 });
    const c: ConversationDetail = {
      id: 77, start_time: t0, end_time: null, device_type: "unknown", summary: null, short_summary: null,
      state: "CAPTURING", created_at: 1, updated_at: 1,
      transcriptions: [{ id: 770, realtime: true, utterances: [
        u(1, "Ada", "Première lecture, c'est un difficile exercice.", 100, 104, t0 + 100_000),
        u(2, "Unknown", "Okay.", 380, 381, t0 + 380_000),
        // A later recording appended to the same open conversation: offsets restart near 0.
        u(3, "Ada Mae", "Deuxième lecture, je suis trente ans.", 38, 42, t0 + 1_000_000),
      ] }],
      suggested_links: [], primary_location: null,
    } as ConversationDetail;
    const { corpus } = await loadRealCorpus(new FakeSource([c]), { includeVoiceNotes: false, me: ME });
    const s = corpus.sessions.find((x) => x.id === "77")!;
    expect(s.skipped).toBeUndefined();
    expect(s.realtimeOnly).toBe(true);
    const mine = corpus.lines.filter((l) => l.session === "77").sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    expect(mine.map((l) => l.key)).toEqual(["u:1", "u:3"]); // the appended reading sorts last, not first
    expect(mine[1]!.start).toBeCloseTo(1000, 5);
  });
});
