// Drill lines are left out of the everyday-speech stats even when Bee's final transcript gives them
// ids of its own. The attempt is matched on the live stream (realtime utterance ids); the stats
// session comes from the final transcript (other ids, other segmentation). Synthetic text, a manual
// clock and Bee events shaped like the live stream and `bee conversations get` (src/bee/schemas.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConversationDetail } from "../src/bee/schemas.js";
import type { BeeEvent } from "../src/hub/bee.js";
import { deriveHabit, deriveMustSay, type HubCard } from "../src/hub/cards.js";
import { CoachHub, type Attempt, type HubEvent } from "../src/hub/core.js";
import { DEMO_TZ, DEMO_WEARER } from "../src/hub/demoData.js";
import type { HubDeck } from "../src/hub/scheduler.js";
import { wearerRule } from "../src/hub/setup.js";
import { conversationLines } from "../src/real/corpus.js";
import { isDrillLine, mergeCorpus, withoutDrillLines, type StatSession, type TransferPrereg } from "../src/hub/stats.js";
import { wordCount } from "../src/real/text.js";

const T0 = Date.parse("2026-10-20T20:00:00-04:00");
const LIKE = "demo:filler-like";
const CONV = 4242;
const UUID = "conv-uuid-4242";
const PREREG: TransferPrereg = {
  kind: "transfer", registered_at: "2026-10-12T13:00:00.000Z", registered_local: "", lang: "en", basis: "test",
  drilled: [{ habit: "filler:like", why: "" }], control: [{ habit: "restart", why: "" }], min_words_per_period: 50, cutover_rule: "",
};
const EVERYDAY = [
  "Yeah so the export is mostly done, like, almost.",
  "Okay, I think we can ship it on Friday.",
  "Um, the totals match the ledger, I checked them twice.",
  "Right, so the retry job runs every night at two.",
  "Yeah, the billing team wanted a summary by Thursday.",
  "Okay so I sent the draft to Sam this morning.",
  "We still need the sign-off from finance though.",
  "Right, the dashboard is kind of slow today.",
  "I'll look at the query plan after lunch, okay.",
  "The migration finished and the counts look right.",
  "The release notes are nearly ready, like, yeah.",
  "Let's sync again on Monday after the stand-up.",
];

// The first drill was yesterday, so today's conversation is in the "after" period: the drill said in
// it must not count as everyday speech there.
const YESTERDAY: Attempt = { id: "att_y", cardId: LIKE, sessionId: null, status: "graded", counted: true, createdAt: T0 - 86_400_000, settledAt: T0 - 86_400_000 + 6000, provisional: null, bee: { text: "x", utteranceIds: [1], speakerScore: 0.8, via: "stream", latencyMs: 6000, coverage: null, replay: false }, final: { source: "bee", pass: true, grade: {} as never }, agreement: "bee-only", reason: "", box: null };

function rig() {
  let now = T0;
  const deck = JSON.parse(readFileSync("fixtures/demo/deck.json", "utf8")) as HubDeck;
  deck.cards = deck.cards.map((c: HubCard) => ({ ...c, habit: c.habit ?? deriveHabit(c), mustSay: c.mustSay ?? deriveMustSay(c) }));
  const hub = new CoachHub({ mode: "demo", clock: () => now, tz: DEMO_TZ, deck, deckPath: null, attempts: [structuredClone(YESTERDAY)], attemptsPath: null, sessions: [], prereg: PREREG, preregPath: "p", wearer: wearerRule(DEMO_WEARER, ""), replay: true });
  const events: HubEvent[] = [];
  hub.on("event", (e: HubEvent) => events.push(e));
  return { hub, events, now: () => now, advance: (ms: number) => (now += ms), set: (t: number) => (now = t) };
}

// The final transcript of the conversation, as `bee conversations get` returns it: a realtime list
// (the stream's ids) and the final list with its own ids, where the drill sentence is one line among
// the everyday ones, spoken at `drillAt`.
function finalConversation(startMs: number, drillAt: number, drillText: string): ConversationDetail {
  const final = EVERYDAY.map((text, i) => ({ id: 90_000 + i, text, at: startMs + i * 6000 }));
  final.splice(6, 0, { id: 90_100, text: drillText, at: drillAt });
  final.sort((a, b) => a.at - b.at);
  const name = `${DEMO_WEARER.first_name} ${DEMO_WEARER.last_name}`.trim();
  return {
    id: CONV, start_time: startMs, end_time: startMs + 600_000, device_type: "watch", summary: null, short_summary: null, state: "COMPLETED", created_at: startMs, updated_at: startMs,
    transcriptions: [
      { id: 1, realtime: true, utterances: [{ id: 501, realtime: true, start: 0, end: 3, spoken_at: drillAt, text: drillText.toLowerCase(), speaker: "Unknown", created_at: startMs }] },
      { id: 2, realtime: false, utterances: final.map((u, i) => ({ id: u.id, realtime: false, start: i * 6, end: i * 6 + 4, spoken_at: u.at, text: u.text, speaker: name, created_at: startMs })) },
    ],
    suggested_links: [], primary_location: null,
  };
}

// The stats session the live ingest makes from it (the same path: conversationLines, then mergeCorpus).
function sessionOf(c: ConversationDetail): StatSession {
  const name = `${DEMO_WEARER.first_name} ${DEMO_WEARER.last_name}`.trim();
  const { sessions, lines } = conversationLines([c], { labels: [name], method: "env", counts: {} } as never);
  const byId = new Map<string, StatSession>();
  mergeCorpus(byId, { generatedAt: "x", wearer: { labels: [name], method: "env", counts: {} }, sessions, lines } as never);
  return byId.get(String(c.id))!;
}

describe("drill lines in the final transcript", () => {
  it("a stream-matched attempt is left out of the transfer and the next-session glance, though the final ids differ", () => {
    const r = rig();
    const before = sessionOf({ ...finalConversation(T0 - 2 * 86_400_000, T0 - 2 * 86_400_000 + 1, "Like, I mean, yeah."), id: 4100 });
    r.hub.addSessions([before]);
    r.hub.ingestBee({ type: "new-conversation", conversation: { id: CONV, conversation_uuid: UUID, start_time: new Date(T0).toISOString(), state: "CAPTURING" } } as BeeEvent);
    const card = r.hub.openCard({ cardId: LIKE, by: "tv" })!;
    // the wearer says the card 10 s later; Bee's stream line (realtime id 501) and its tag land 6 s after
    const spoken = r.now() + 10_000;
    r.set(spoken + 6000);
    r.hub.ingestBee({ type: "new-utterance", conversation_uuid: UUID, utterance: { id: 501, sample_id: "s501", start: 0, end: 3, text: card.resay.toLowerCase(), spoken_at: new Date(spoken).toISOString() } } as BeeEvent);
    r.hub.ingestBee({ type: "tagged-utterance", utterance_id: 501, person_id: 1, person_first_name: DEMO_WEARER.first_name, speaker_score: 0.82, conversation_uuid: UUID } as BeeEvent);
    const graded = r.events.filter((e) => e.topic === "attempt.graded").map((e) => e.payload.attempt as Attempt);
    expect(graded).toHaveLength(1);
    expect(graded[0]!.bee).toMatchObject({ utteranceIds: [501], spokenFromMs: spoken, conversationId: String(CONV) });

    // Bee completes the conversation: its final transcript gives the drill sentence id 90100
    const c = finalConversation(T0 - 30_000, spoken, card.resay);
    const s = sessionOf(c);
    expect(s.lines.find((l) => l.text === card.resay)?.key).toBe("u:90100");
    r.advance(600_000);
    r.hub.addSessions([s]);
    const t = r.hub.transfer()!;
    const like = t.habits.find((h) => h.habit === "filler:like")!;
    const everydayWords = EVERYDAY.reduce((n, x) => n + wordCount(x), 0);
    expect(like.after.words).toBe(everydayWords);
    expect(t.firstSignal[0]!.after).toMatchObject({ session: String(CONV), words: everydayWords });
    const glance = r.hub.stats({ kind: "all" }).drilledVsNextSession.find((d) => d.habit === "filler:like")!;
    expect(glance.nextSessionAfter).toMatchObject({ session: String(CONV), words: everydayWords });
    r.hub.dispose();
  });

  it("only a line in the attempt's window, in its conversation, with the attempt's words, is a drill line", () => {
    const at = T0 + 30_000;
    const d = { keys: new Set<string>(), spans: [{ session: "7", fromMs: at, toMs: at + 3000, text: "the dashboard loads slowly on mondays" }] };
    const line = (text: string, spokenAt: number | null) => ({ key: "u:1", text, dom: "en" as const, uncertain: false, spokenAt });
    expect(isDrillLine("7", line("The dashboard loads slowly on Mondays.", at + 1000), d)).toBe(true);
    // Bee split it differently: most of the line is the attempt's words
    expect(isDrillLine("7", line("The dashboard loads slowly", at), d)).toBe(true);
    // merged with a few more words: most of the attempt is in the line
    expect(isDrillLine("7", line("Okay. The dashboard loads slowly on Mondays, right.", at), d)).toBe(true);
    expect(isDrillLine("7", line("The dashboard loads slowly on Mondays.", at + 60_000), d)).toBe(false); // outside the window
    expect(isDrillLine("8", line("The dashboard loads slowly on Mondays.", at + 1000), d)).toBe(false); // another conversation
    expect(isDrillLine("7", line("We moved the stand-up to Friday at ten.", at + 1000), d)).toBe(false); // other words
    expect(isDrillLine("7", line("The dashboard loads slowly on Mondays.", null), d)).toBe(false); // no time: id only
    const s: StatSession = { id: "7", kind: "conversation", startMs: at - 5000, lines: [line("The dashboard loads slowly on Mondays.", at + 1000), { ...line("Okay, see you then.", at + 2000), key: "u:2" }] };
    expect(withoutDrillLines([s], d)[0]!.lines.map((l) => l.text)).toEqual(["Okay, see you then."]);
  });

  it("a line Bee merged with a lead-in, starting well before the attempt, is still a drill line (its span overlaps)", () => {
    const at = T0 + 30_000;
    const d = { keys: new Set<string>(), spans: [{ session: "7", fromMs: at + 12_000, toMs: at + 15_000, text: "the export ships on Friday after the review" }] };
    const text = "Okay so let me try that one again, the export ships on Friday after the review.";
    const merged = { key: "u:9", text, dom: "en" as const, uncertain: false, spokenAt: at, spokenEndAt: at + 15_000 };
    expect(isDrillLine("7", merged, d)).toBe(true);
    // no known end: estimated from its words (16 words, 8 s), which still reaches the window
    expect(isDrillLine("7", { ...merged, spokenEndAt: null }, d)).toBe(true);
    // a line that ended long before the attempt is not
    expect(isDrillLine("7", { ...merged, spokenAt: at - 60_000, spokenEndAt: at - 50_000 }, d)).toBe(false);
  });

  it("mergeCorpus carries each line's end (spoken_at plus its duration)", () => {
    const byId = new Map<string, StatSession>();
    mergeCorpus(byId, { sessions: [{ id: "1", kind: "conversation", startMs: T0, totalLines: 1, wearerLines: 1 }], lines: [{ key: "u:1", session: "1", kind: "conversation", start: 10, end: 14.5, spokenAt: T0 + 10_000, text: "hello there", lang: "en", dom: "en", uncertain: false, mislabelScore: 0, reasons: [] }] } as never);
    expect(byId.get("1")!.lines[0]).toMatchObject({ spokenAt: T0 + 10_000, spokenEndAt: T0 + 14_500 });
  });
});
