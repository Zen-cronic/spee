// The MCP tools (packet C): one per entry of MCP_TOOLS in src/hub/contract.ts, each calling exactly
// one hub route through the loopback HubClient. A result is the route's narration as text plus the
// route's JSON as structuredContent; a route answering >= 400 (or an unreachable hub) is isError.
// Narration is deterministic: no model call in a tool.
import { z } from "zod";
import { MCP_TOOLS, type McpToolName, type RecapList, type StatsResponse, type TransferResponse } from "../hub/contract.js";
import type { HubClient, HubResult, SessionEndResponse } from "./hubClient.js";

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

export function summaryText(s: SessionEndResponse["summary"]): string {
  if (!s) return "No drill is running.";
  return `Drill ended: ${s.passed} of ${s.counted} Bee-graded attempts passed${s.unverified ? `, ${s.unverified} unconfirmed` : ""}${s.pending ? `, ${s.pending} still waiting for Bee` : ""}.`;
}
export function statsText(s: StatsResponse): string {
  const h = s.habits;
  return `${s.range === "week" ? "This week" : `Range ${s.range}`}, over ${h.words} words: hedges ${r2(h.hedges.per100)}, vague answers ${r2(h.vague.per100)}, fillers ${r2(h.fillers.per100)} and restarts ${r2(h.restarts.per100)} per 100 words.`;
}
export function transferText(t: TransferResponse): string {
  if (t.habits.length === 1) {
    const h = t.habits[0]!;
    return `${h.label}: ${h.verdict} (${h.role}), ${h.before.per100} before and ${h.after.per100} after per 100 words.`;
  }
  return t.headline;
}
export const recapText = (l: RecapList) => l.recaps[0]?.narration ?? "No conversation recap yet.";

// Arg names follow MCP_TOOLS (snake_case); the hub routes take camelCase.
export const TOOL_DEFS: ToolDef[] = [
  {
    name: "start_drill",
    title: "Start a drill",
    description: "Start a drill session and open the first due card. Returns the sentence to say. Mirrored on the TV.",
    input: { size: z.number().int().min(1).max(10).optional().describe("cards in the session (1-10, default 3)") },
    run: async (hub, a) => outcome("POST /api/session/start", await hub.startSession({ by: "alexa", ...(a.size !== undefined ? { size: a.size as number } : {}) }), (b) => narr(b) ?? ""),
  },
  {
    name: "submit_attempt",
    title: "Submit an attempt",
    description:
      "Send what the user said for the open card. Returns at once with status pending_bee: Bee (the wearable) is the grader of record and its line lands 5-20 s later. End the turn, then call get_verdict with the attempt id when the user asks how they did.",
    input: { text: z.string().min(1).max(2000).describe("the user's words, as transcribed"), card_id: z.string().optional().describe("a card to open first (default: the open card)") },
    run: async (hub, a) => outcome("POST /api/attempt", await hub.attempt({ text: a.text as string, source: "alexa", ...(a.card_id ? { cardId: a.card_id as string } : {}) }), (b) => narr(b) ?? ""),
  },
  {
    name: "get_verdict",
    title: "Get the verdict",
    description: "The Bee-graded verdict for one attempt. When verdictReady is false, tell the user to ask again after retryAfterMs; never present the provisional grade as the result.",
    input: { attempt_id: z.string().min(1).describe("the id returned by submit_attempt") },
    run: async (hub, a) => outcome("GET /api/attempts/<id>", await hub.verdict(a.attempt_id as string), (b) => narr(b) ?? ""),
  },
  {
    name: "drill_status",
    title: "Drill status",
    description: "The voice-UI state: idle, card_open, pending_bee, polling, graded or unverified, with the open card and the session summary.",
    input: {},
    run: async (hub) => outcome("GET /api/session", await hub.session(), (b) => narr(b) ?? ""),
  },
  {
    name: "next_card",
    title: "Next card",
    description: "Open the next due card in the session, or end the session when it is done.",
    input: {},
    run: async (hub) => outcome("POST /api/session/next", await hub.nextCard(), (b) => (b.done ? summaryText(b.summary ?? null) : (narr(b) ?? ""))),
  },
  {
    name: "end_drill",
    title: "End the drill",
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
    description: "Habit rates per 100 words (hedges, vague answers, fillers, restarts) with 95% intervals. Bee only by default; source=all adds labelled meeting captions.",
    input: { range: z.string().optional().describe("today | week | all | session:<id> | meeting:<id> (default week)"), source: z.enum(["bee", "all"]).optional() },
    run: async (hub, a) => outcome("GET /api/stats", await hub.stats({ range: (a.range as string | undefined) ?? "week", source: a.source as "bee" | "all" | undefined }), (b) => statsText(b)),
  },
  {
    name: "did_it_transfer",
    title: "Did it transfer",
    description: "Did the drilled habits drop in later real (non-drill) speech, against the pre-registered control habit?",
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
