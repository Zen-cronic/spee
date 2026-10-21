// The MCP tools: one per entry of MCP_TOOLS in src/hub/contract.ts, each calling exactly
// one hub route through the loopback HubClient. A result is the route's narration as text plus the
// route's JSON as structuredContent; a route answering >= 400 (or an unreachable hub) is isError.
// Narration is deterministic: no model call in a tool.
import { z } from "zod";
import { MCP_TOOLS, type McpToolName, type RecapList, type SessionSummary, type StatsResponse, type TransferResponse } from "../hub/contract.js";
import type { HubClient, HubResult } from "./hubClient.js";
import { HABIT_NAME, habitTitle, PER_100_GLOSS } from "../hub/habitNames.js";

export interface ToolOutcome {
  route: string; // "METHOD /path" actually called
  result: HubResult<unknown>;
  text: string; // narration (TTS-ready)
}

export interface ToolDef {
  name: McpToolName;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run(hub: HubClient, args: Record<string, unknown>): Promise<ToolOutcome>;
}

const narr = (b: unknown): string | null => (b && typeof b === "object" && typeof (b as { narration?: unknown }).narration === "string" ? (b as { narration: string }).narration : null);
const errText = (r: HubResult<unknown>) => (r.ok ? "" : `${r.body.message} (${r.body.error})`);
const outcome = (route: string, result: HubResult<unknown>, ok: (b: any) => string): ToolOutcome => ({ route, result, text: result.ok ? ok(result.body) : errText(result) });
const r2 = (n: number) => Math.round(n * 100) / 100;

// Each line once, as the TV's Round over counts it (a line missed and then passed on a retry is one
// line passed, never two tries). The MCP server is its own process and may talk to an older hub,
// which sends no `lines`: then its counts are tries, and the sentence says so (as the TV's tally does).
// A round with no try Bee graded never says "checked by Bee": it says Bee checked none, and why.
type SummaryIn = Omit<SessionSummary, "lines"> & Partial<Pick<SessionSummary, "lines">>;
export function summaryText(s: SummaryIn | null | undefined): string {
  if (!s) return "You're not practising right now.";
  const l = s.lines;
  if (!s.counted) {
    const c = l ?? { ...s, untried: 0 };
    return `Practice done: Bee didn't check any line this round${c.unverified ? `, ${c.unverified} Bee didn't confirm` : ""}${c.pending ? `, ${c.pending} still waiting for Bee` : ""}${c.untried ? `, ${c.untried} not tried` : ""}.`;
  }
  if (!l) return `Practice done: ${s.passed} of ${s.counted} ${s.counted === 1 ? "try" : "tries"} passed, checked by Bee${s.unverified ? `, ${s.unverified} Bee didn't confirm` : ""}${s.pending ? `, ${s.pending} still waiting for Bee` : ""}.`;
  return `Practice done: ${l.passed} of ${s.cards} line${s.cards === 1 ? "" : "s"} passed, checked by Bee${l.unverified ? `, ${l.unverified} Bee didn't confirm` : ""}${l.pending ? `, ${l.pending} still waiting for Bee` : ""}${l.untried ? `, ${l.untried} not tried` : ""}.`;
}
export function statsText(s: StatsResponse): string {
  const h = s.habits;
  return `${s.range === "week" ? "This week" : `Range ${s.range}`}, over ${h.words} words: ${HABIT_NAME.hedges} ${r2(h.hedges.per100)}, ${HABIT_NAME.vague} ${r2(h.vague.per100)}, ${HABIT_NAME.fillers} ${r2(h.fillers.per100)} and ${HABIT_NAME.restarts} ${r2(h.restarts.per100)} per 100 words (${PER_100_GLOSS}).`;
}
export function transferText(t: TransferResponse): string {
  if (t.habits.length === 1) {
    const h = t.habits[0]!;
    const verdict: Record<string, string> = { "not drilled yet": "not practised yet", invalid: "not counted" };
    const name = h.habit in HABIT_NAME ? habitTitle(h.habit) : h.label.replace(/\s*\(.*$/, "");
    return `${name[0]!.toUpperCase()}${name.slice(1)} (${h.role === "drilled" ? "practised" : "the one you didn't practise"}): ${verdict[h.verdict] ?? h.verdict}, ${h.before.per100} before and ${h.after.per100} now per 100 words.`;
  }
  return t.headline;
}
export const recapText = (l: RecapList) => l.recaps[0]?.narration ?? "No conversation recap yet.";

// Arg names follow MCP_TOOLS (snake_case); the hub routes take camelCase.
export const TOOL_DEFS: ToolDef[] = [
  {
    name: "start_drill",
    title: "Start practising",
    description: "Start a drill session and open the first due card. Returns the sentence to say. Mirrored on the TV.",
    input: { size: z.number().int().min(1).max(10).optional().describe("cards in the session (1-10, default 3)") },
    run: async (hub, a) => outcome("POST /api/session/start", await hub.startSession({ by: "mcp", ...(a.size !== undefined ? { size: a.size as number } : {}) }), (b) => narr(b) ?? ""),
  },
  {
    name: "submit_attempt",
    title: "Send what I said",
    description:
      "Send what the user said for the open card. Returns at once with status pending_bee: Bee (the wearable) is the grader of record and its line lands 5-20 s later. End the turn, then call get_verdict with the attempt id when the user asks how they did.",
    input: { text: z.string().min(1).max(2000).describe("the user's words, as transcribed"), card_id: z.string().optional().describe("a card to open first (default: the open card)") },
    run: async (hub, a) => outcome("POST /api/attempt", await hub.attempt({ text: a.text as string, source: "mcp", ...(a.card_id ? { cardId: a.card_id as string } : {}) }), (b) => narr(b) ?? ""),
  },
  {
    name: "get_verdict",
    title: "How did I do",
    description: "The Bee-graded verdict for one attempt. When verdictReady is false, tell the user to ask again after retryAfterMs; never present the provisional grade as the result.",
    input: { attempt_id: z.string().min(1).describe("the id returned by submit_attempt") },
    run: async (hub, a) => outcome("GET /api/attempts/<id>", await hub.verdict(a.attempt_id as string), (b) => narr(b) ?? ""),
  },
  {
    name: "drill_status",
    title: "Practice status",
    description: "The voice-UI state: idle, card_open, pending_bee, polling, graded or unverified, with the open card and the session summary.",
    input: {},
    run: async (hub) => outcome("GET /api/session", await hub.session(), (b) => narr(b) ?? ""),
  },
  {
    name: "next_card",
    title: "Next line",
    description: "Open the next due card in the session, or end the session when it is done.",
    input: {},
    run: async (hub) => outcome("POST /api/session/next", await hub.nextCard(), (b) => (b.done ? summaryText(b.summary ?? null) : (narr(b) ?? ""))),
  },
  {
    name: "end_drill",
    title: "Stop practising",
    description: "End the drill session and return its summary.",
    input: {},
    run: async (hub) => outcome("POST /api/session/end", await hub.endSession(), (b) => summaryText(b.summary)),
  },
  {
    name: "how_am_i_doing",
    title: "How am I doing",
    description: "A short, deterministic coaching update: the live conversation, else the last recap, else the week; plus due drills and live-coaching status.",
    input: {},
    run: async (hub) => outcome("GET /api/coach/now", await hub.coachNow(), (b) => narr(b) ?? ""),
  },
  {
    name: "habit_stats",
    title: "Habit stats",
    description: "Habit rates per 100 words (unsure words, vague answers, filler words, starting over; keys hedges, vague, fillers, restarts) with 95% intervals. Say the plain names to the user. Bee only by default; source=all adds labelled meeting captions.",
    input: { range: z.string().optional().describe("today | week | all | session:<id> | meeting:<id> (default week)"), source: z.enum(["bee", "all"]).optional() },
    run: async (hub, a) => outcome("GET /api/stats", await hub.stats({ range: (a.range as string | undefined) ?? "week", source: a.source as "bee" | "all" | undefined }), (b) => statsText(b)),
  },
  {
    name: "did_it_transfer",
    title: "Is it working",
    description: "Is it working: did the practised habits drop in later real (non-practice) speech, against the pre-registered habit that was never practised? Say the plain habit names to the user.",
    input: { habit: z.string().optional().describe("one pre-registered habit key, e.g. hedges or filler:like") },
    run: async (hub, a) => outcome("GET /api/transfer", await hub.transfer({ habit: a.habit as string | undefined }), (b) => transferText(b)),
  },
  {
    name: "pre_meeting_brief",
    title: "Pre-meeting brief",
    description: "The next calendar event, this week's top habit and one warm-up card.",
    input: {},
    run: async (hub) => outcome("GET /api/brief", await hub.brief(), (b) => b.nudge ?? ""),
  },
  {
    name: "live_coach",
    title: "Live coaching on or off",
    description: "Turn opt-in live coaching (wrist nudges while you talk) on for a number of minutes, or off.",
    input: { enabled: z.boolean(), minutes: z.number().int().min(1).max(180).optional().describe("1-180, default 60") },
    run: async (hub, a) =>
      outcome("POST /api/live/mode", await hub.liveMode({ enabled: a.enabled as boolean, by: "mcp", ...(a.enabled && a.minutes !== undefined ? { minutes: a.minutes as number } : {}) }), (b) => narr(b) ?? ""),
  },
  {
    name: "last_recap",
    title: "Last recap",
    description: "The recap of the most recent conversation.",
    input: {},
    run: async (hub) => outcome("GET /api/recaps?limit=1", await hub.recaps(1), (b) => recapText(b)),
  },
];

// The definitions must cover MCP_TOOLS exactly, in order (checked at import).
{
  const want = MCP_TOOLS.map((t) => t.name).join(",");
  const got = TOOL_DEFS.map((t) => t.name).join(",");
  if (want !== got) throw new Error(`src/mcp/tools.ts does not match MCP_TOOLS: ${got} vs ${want}`);
}
export const TOOL_ROUTES: Record<McpToolName, string> = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t.route])) as Record<McpToolName, string>;
