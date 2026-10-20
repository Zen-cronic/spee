// SYNTHETIC demo data. Every sentence here is invented, for a fictional wearer ("Ada", a
// product engineer at a fictional company). None of it is anyone's real speech or result.
// `npm run demo:fixtures` writes it to fixtures/demo/; the demo hub reads those files.
//
// Story: hedges ("I guess") and the filler "like" were pre-registered as drilled habits and
// restarts as the control on 2026-10-12. Drilling started 2026-10-15 at 12:10 EDT. In the Bee
// conversations after that, "I guess" and "like" drop; restarts stay flat.
import { grade } from "./grade.js";
import { deriveMustSay, habitOf, type HubCard } from "./cards.js";
import type { Attempt } from "./core.js";
import type { StatSession, TransferPrereg } from "./stats.js";
import type { MeetingTimeline } from "../real/tactiq.js";

export const DEMO_EPOCH = Date.parse("2026-10-20T13:30:00-04:00"); // demo "now": Tuesday 13:30 EDT
export const DEMO_TZ = "America/Toronto";
export const DEMO_WEARER = { id: 1, first_name: "Ada", last_name: "Demo", timezone: DEMO_TZ };
export const DEMO_LABEL = "SYNTHETIC DEMO DATA (invented; not anyone's real results)";

const CLEAN = [
  "The billing export finished on Monday and the totals match the ledger.",
  "We moved the release of the mobile build to Friday afternoon.",
  "The search page loads in two seconds on the staging server.",
  "Priya reviewed the onboarding copy and approved the second draft.",
  "The nightly backup job failed twice because the disk was full.",
  "I added retries to the invoice sender and wrote three tests.",
  "Our next step is to switch the queue to the new region.",
  "The design team wants one more round on the settings screen.",
  "Support closed forty tickets this week, mostly password resets.",
  "The analytics dashboard now shows weekly active users by plan.",
  "I paired with Tomas on the caching layer for an hour.",
  "The contract with the payment provider renews at the end of November.",
  "We need a decision on the pricing page before Thursday.",
  "The load test reached five hundred requests per second without errors.",
  "I wrote the migration plan and shared it in the team channel.",
  "The customer in Halifax asked for a demo of the reporting module.",
  "Our error budget for the month is still above eighty percent.",
  "The new hire starts on Monday and needs a laptop and accounts.",
  "I updated the runbook for the database failover drill.",
  "The marketing site redesign goes live after the legal review.",
  "We removed two unused feature flags from the checkout flow.",
  "The partner integration returns the wrong currency for Canadian orders.",
  "I estimate two days for the export filters and one for review.",
  "The accessibility audit found contrast issues on four screens.",
  "Our standup notes now live in the shared tracker.",
  "The import tool handles files up to fifty megabytes.",
  "I will send the release notes to the sales team tomorrow.",
  "The staging certificate expires next week, so I renewed it today.",
  "We agreed to freeze the schema until the launch.",
  "The mobile crash rate fell after the image library upgrade.",
];

// Clean synthetic small talk for the casual (evening and weekend) sessions: no habit words.
const CASUAL = [
  "We walked along the lake after dinner and watched the boats come in.",
  "My sister is visiting next month with her two dogs.",
  "The new bakery on the corner sells sourdough until noon.",
  "I finished the mystery novel on the train home.",
  "We are planning a cabin trip for the long weekend in May.",
  "The farmers market had the first apples of the season.",
  "Our neighbours painted their fence a bright shade of green.",
  "I tried the ramen place downtown and the broth was excellent.",
  "The soccer game went to penalties and our side won.",
  "My cousin started a pottery class on Thursday evenings.",
  "We found a quiet trail through the ravine behind the library.",
  "The museum has a new exhibit on old maps of the city.",
  "I fixed the bike chain and rode to the market this morning.",
  "Our book club picked a travel memoir for next month.",
  "The concert in the park starts at seven on Saturday.",
  "We cooked a big pot of chili and froze half of it.",
  "My niece learned to swim at the community pool this summer.",
  "The ferry to the island runs every half hour on weekends.",
  "I planted tulip bulbs along the front path yesterday.",
  "We watched the meteor shower from the roof until midnight.",
  "The cafe by the station roasts its own beans every Tuesday.",
  "My brother is building a canoe in his garage.",
  "We played board games until the power came back on.",
  "The pumpkin patch outside town opens next weekend.",
];

// Clean (habit-free) synthetic sentences, also used by the live demo scripts (src/hub/live/demoScripts.ts).
export const DEMO_SENTENCES: readonly string[] = CLEAN;

// Deterministic PRNG (LCG) so the fixtures are identical on every run.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => ((a = (a * 1664525 + 1013904223) >>> 0), a / 4294967296);
}

type Mark = "iguess" | "like" | "restart" | "vague" | "ithink" | "um";
const apply = (s: string, m: Mark, r: () => number): string => {
  const words = s.split(" ");
  switch (m) {
    case "iguess":
      return `I guess ${s[0]!.toLowerCase()}${s.slice(1)}`;
    case "ithink":
      return `I think ${s[0]!.toLowerCase()}${s.slice(1)}`;
    case "like":
      return [words[0] + ",", "like,", ...words.slice(1)].join(" ");
    case "restart":
      return [words[0], words[0]!.toLowerCase(), ...words.slice(1)].join(" ");
    case "um":
      return `Um, ${s[0]!.toLowerCase()}${s.slice(1)}`;
    case "vague": {
      const v = [" and stuff.", ", or something like that.", ", but it's getting there."][Math.floor(r() * 3)]!;
      return s.replace(/\.$/, v);
    }
  }
};

export interface SessionPlan {
  id: string;
  kind: "conversation" | "meeting";
  start: string; // ISO with offset
  sentences: number;
  marks: Partial<Record<Mark, number>>;
  speakers?: number; // distinct speakers heard, the wearer included (a count, as Bee's sessions carry)
  casual?: boolean; // small talk (CASUAL sentences) instead of work talk
  // The captions of a meeting Bee also heard: the same lines as that Bee conversation, with every
  // "um" left out, as captions showed fewer "um" and "uh" on the one real meeting checked (docs/instrument-check.md).
  captionsOf?: string;
}

// Before drilling (Oct 13-15 morning) vs after (Oct 15 afternoon onward). Bee conversations are
// the input of record; the three meetings are the secondary caption source (one of them, Oct 13, is
// the captions of a conversation Bee heard too).
// The weekday Bee conversations are work talk (2 to 4 speakers in work hours); the four evening and
// weekend ones are casual (src/hub/settings.ts tags them).
export const PLANS: SessionPlan[] = [
  { id: "demo-bee-1013", kind: "conversation", start: "2026-10-13T10:05:00-04:00", sentences: 26, marks: { iguess: 7, like: 9, restart: 2, vague: 3, ithink: 1, um: 2 }, speakers: 3 },
  { id: "demo-bee-1014", kind: "conversation", start: "2026-10-14T09:50:00-04:00", sentences: 26, marks: { iguess: 6, like: 9, restart: 3, vague: 2, ithink: 1, um: 2 }, speakers: 2 },
  { id: "demo-meet-1014", kind: "meeting", start: "2026-10-14T11:00:00-04:00", sentences: 12, marks: { iguess: 2, like: 4, restart: 1, vague: 1 } },
  { id: "demo-bee-1015", kind: "conversation", start: "2026-10-15T09:40:00-04:00", sentences: 26, marks: { iguess: 7, like: 10, restart: 2, vague: 2, ithink: 1, um: 2 }, speakers: 3 },
  { id: "demo-bee-1016", kind: "conversation", start: "2026-10-16T10:10:00-04:00", sentences: 23, marks: { iguess: 1, like: 2, restart: 2, vague: 2, ithink: 1, um: 2 }, speakers: 2 },
  { id: "demo-meet-1019", kind: "meeting", start: "2026-10-19T11:00:00-04:00", sentences: 12, marks: { like: 2, restart: 1, vague: 1 } },
  { id: "demo-bee-1019", kind: "conversation", start: "2026-10-19T15:20:00-04:00", sentences: 24, marks: { iguess: 1, like: 2, restart: 3, vague: 2, ithink: 1, um: 2 }, speakers: 3 },
  { id: "demo-bee-1020", kind: "conversation", start: "2026-10-20T09:35:00-04:00", sentences: 23, marks: { like: 2, restart: 2, vague: 1, ithink: 1, um: 1 }, speakers: 4 },
  // Appended (their seeds follow the eight above, which keep theirs); buildSessions sorts by start.
  { id: "demo-bee-1010", kind: "conversation", start: "2026-10-10T19:30:00-04:00", sentences: 20, marks: { iguess: 3, like: 3, restart: 2 }, speakers: 2, casual: true },
  { id: "demo-bee-1011", kind: "conversation", start: "2026-10-11T12:00:00-04:00", sentences: 20, marks: { iguess: 3, like: 3, restart: 1, vague: 1 }, speakers: 3, casual: true },
  { id: "demo-bee-1017", kind: "conversation", start: "2026-10-17T20:15:00-04:00", sentences: 20, marks: { iguess: 1, like: 2, restart: 2 }, speakers: 2, casual: true },
  { id: "demo-bee-1018", kind: "conversation", start: "2026-10-18T11:30:00-04:00", sentences: 20, marks: { iguess: 1, like: 2, restart: 1, vague: 1 }, speakers: 3, casual: true },
  // Synthetic: the Oct 13 stand-up's own captions, heard by Bee too (the instrument check's pair).
  // Last, so it can copy that conversation's lines. Before this week, so the usual "at work" rate
  // (this week's work talk) is the same with or without it.
  { id: "demo-meet-1013", kind: "meeting", start: "2026-10-13T10:06:00-04:00", sentences: 0, marks: {}, captionsOf: "demo-bee-1013" },
];

export function buildSessions(): StatSession[] {
  const built = new Map<string, string[]>();
  return PLANS.map((p, si) => {
    const r = rng(1000 + si);
    const src = p.casual ? CASUAL : CLEAN;
    const pool = [...src];
    const picked: string[] = [];
    for (let i = 0; i < p.sentences; i++) picked.push(pool.splice(Math.floor(r() * pool.length), 1)[0] ?? src[i % src.length]!);
    const marks: Mark[] = [];
    for (const [m, n] of Object.entries(p.marks) as [Mark, number][]) for (let k = 0; k < n; k++) marks.push(m);
    const slots = picked.map((_, i) => i);
    let text = [...picked];
    for (const m of marks) {
      const i = slots.splice(Math.floor(r() * slots.length), 1)[0]!;
      text[i] = apply(text[i]!, m, r);
    }
    if (p.captionsOf) text = (built.get(p.captionsOf) ?? []).map((t) => t.replace(/^Um, (.)/, (_m, c: string) => c.toUpperCase()));
    built.set(p.id, text);
    const startMs = Date.parse(p.start);
    const lines = text.map((t, i) => ({ key: `${p.kind === "meeting" ? "m" : "u"}:${p.id}:${i}`, text: t, dom: "en" as const, uncertain: false }));
    let timeline: MeetingTimeline | undefined;
    if (p.kind === "meeting") {
      // Counts only for the other (fictional) speakers, as for real meetings.
      const steps: MeetingTimeline["steps"] = [];
      let sec = 0;
      lines.forEach((l, i) => {
        steps.push({ w: false, sec, words: 30 + ((i * 7) % 20) });
        sec += 18;
        steps.push({ w: true, sec, words: l.text.split(/\s+/).length, key: l.key });
        sec += 6;
      });
      timeline = { session: p.id, durationMin: Math.round(sec / 60), speakers: 5, highlightLinesSkipped: 0, steps };
    }
    // A conversation ends about 20 s per sentence after it starts (the instrument check's overlap).
    const endMs = p.kind === "conversation" ? startMs + text.length * 20_000 : undefined;
    return { id: p.id, kind: p.kind, startMs, ...(endMs ? { endMs } : {}), lines, timeline, synthetic: true, ...(p.speakers ? { speakers: p.speakers } : {}) };
  }).sort((a, b) => a.startMs - b.startMs);
}

const card = (c: Omit<HubCard, "box" | "due" | "added" | "relapses" | "lastSeenSession" | "score" | "key" | "line"> & { box: number; due: string; session: string; score?: number }): HubCard => {
  const full: HubCard = { key: `u:${c.session}:0`, line: c.said, added: "2026-10-15", relapses: 0, lastSeenSession: c.session, score: c.score ?? 1, synthetic: true, ...c };
  full.habit = habitOf(full);
  full.mustSay = deriveMustSay(full);
  return full;
};

export function buildDeck(): { cards: HubCard[] } {
  return {
    cards: [
      card({ id: "demo:hedge-i-guess", kind: "error", lang: "en", type: "EN_HEDGE_STACK", session: "demo-bee-1015", said: "I guess the billing export is ready", fix: "The billing export is ready", resay: "The billing export is ready for review today.", why: "\"I guess\" makes a finished result sound like an opinion. State it.", box: 2, due: "2026-10-20", score: 5 }),
      card({ id: "demo:vague-referent", kind: "error", lang: "en", type: "EN_VAGUE_REFERENT", session: "demo-bee-1016", said: "that thing", fix: "the invoice retry job", resay: "I fixed the invoice retry job this morning.", why: "\"That thing\" makes listeners guess. Name it.", box: 1, due: "2026-10-20", score: 4.5 }),
      card({ id: "demo:vague-status", kind: "error", lang: "en", type: "EN_VAGUE_STATUS", session: "demo-bee-1019", said: "it's getting there", fix: "two of the three checks pass", resay: "The migration is not done yet: two of the three checks pass.", why: "\"Getting there\" hides the status. Say what is done and what is left.", box: 1, due: "2026-10-20", score: 4.4 }),
      card({ id: "demo:filler-like", kind: "filler", lang: "en", type: "EN_FILLERS", session: "demo-bee-1014", said: "So, like, the dashboard, like, loads slowly on Mondays", fix: "The dashboard loads slowly on Mondays", resay: "The dashboard loads slowly on Mondays.", why: "Two fillers in nine words. Pause silently instead of saying \"like\".", box: 2, due: "2026-10-20", score: 4 }),
      card({ id: "demo:hedge-stack", kind: "error", lang: "en", type: "EN_HEDGE_STACK", session: "demo-bee-1016", said: "it's kind of maybe blocked", fix: "it's blocked on the API key", resay: "The release is blocked on the API key from finance.", why: "Two unsure words hide a blocker. Lead with it and name what unblocks it.", box: 1, due: "2026-10-21", score: 3.5 }),
      card({ id: "demo:fr-vocab", kind: "vocab", lang: "fr", type: "FR_VOCAB_SWITCH", session: "demo-bee-1019", said: "deadline", fix: "la date limite", resay: "La date limite, c'est vendredi.", why: "You reached for English (\"deadline\"); say it in French.", box: 1, due: "2026-10-22", score: 1.5 }),
    ],
  };
}

// Seeded history: drills of the two pre-registered habits, Bee-verified (synthetic).
export function buildAttempts(deck: { cards: HubCard[] }): Attempt[] {
  const hist: [string, string, string, number][] = [
    ["demo:hedge-i-guess", "2026-10-15T12:10:00-04:00", "I guess the billing export is ready for review today.", 0.81],
    ["demo:hedge-i-guess", "2026-10-15T12:12:00-04:00", "The billing export is ready for review today.", 0.84],
    ["demo:filler-like", "2026-10-15T12:15:00-04:00", "The dashboard loads slowly on Mondays.", 0.79],
    ["demo:filler-like", "2026-10-19T08:05:00-04:00", "The dashboard loads slowly on Mondays.", 0.83],
    ["demo:hedge-i-guess", "2026-10-19T08:07:00-04:00", "The billing export is ready for review today.", 0.86],
  ];
  return hist.map(([cardId, at, text, score], i) => {
    const c = deck.cards.find((x) => x.id === cardId)!;
    const g = grade({ lang: c.lang, resay: c.resay, habit: c.habit!, mustSay: c.mustSay }, text);
    const t = Date.parse(at);
    return {
      id: `att_demo_${i + 1}`,
      cardId,
      sessionId: null,
      status: "graded",
      counted: true,
      createdAt: t,
      settledAt: t + 6000,
      provisional: null,
      bee: { text, utteranceIds: [9_000_000 + i], speakerScore: score, via: "stream", latencyMs: 5900, coverage: null, replay: true },
      final: { source: "bee", pass: g.pass, grade: g },
      agreement: "bee-only",
      reason: "synthetic history (demo)",
      box: null,
      synthetic: true,
    } satisfies Attempt;
  });
}

export function buildPrereg(): TransferPrereg {
  return {
    kind: "transfer",
    registered_at: "2026-10-12T13:00:00.000Z",
    registered_local: "2026-10-12 09:00 EDT",
    lang: "en",
    basis: "SYNTHETIC DEMO pre-registration (invented, mirrors prereg/transfer.json): two drilled habits and one control habit that is deliberately never drilled",
    drilled: [
      { habit: "hedges", why: "hero habit: hedging a finished result (all hedges)" },
      { habit: "filler:like", why: "the most frequent filler" },
    ],
    control: [{ habit: "restart", why: "same speech, never drilled: separates drill transfer from a general change in how the wearer talks" }],
    min_words_per_period: 400,
    cutover_rule: "drilled habit: its first Bee-verified drill attempt; control: the earliest first drill of any drilled habit",
    synthetic: true,
  };
}

export const DEMO_CALENDAR = [{ title: "Team stand-up (demo)", startsAt: Date.parse("2026-10-20T14:00:00-04:00") }];

// Scripted Bee replays, shaped like the recorded stream (FL-8): new-utterance about 5.4 s after
// the speaker stops, tagged-utterance about 0.5 s later, speaker score about 0.8.
export type DemoScenario = "verified" | "bee-hears-filler" | "asr-slip" | "merged" | "poll" | "untagged" | "other-speaker";
export const DEMO_SCENARIOS: Record<DemoScenario, string> = {
  verified: "Bee hears the same words and tags the wearer (score 0.82) 5.9 s after speech end",
  "bee-hears-filler": "Bee hears an 'um' the phone recognizer dropped; Bee's text fails the filler rule and overrules the preview",
  "asr-slip": "Bee mishears 'card' as 'car' and 'Rack Board' as 'rec board'; the fuzzy grader still passes it",
  merged: "Bee merges the drill sentence with the next words ('How did I do?') into one line that lands 16.5 s after speech end, as seen on a real device; the extra sentence is cut before grading",
  poll: "the stream drops both events; the fallback poll of the conversation finds the wearer-labelled line",
  untagged: "Bee sends the line but never tags a speaker, and the poll finds no wearer label: unverified",
  "other-speaker": "Bee tags the line as someone else: unverified",
};
export const DEMO_DEFAULT_CYCLE: DemoScenario[] = ["verified", "bee-hears-filler", "verified", "asr-slip"];
