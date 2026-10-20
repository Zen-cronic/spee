// Keyword intent router for the simulator: a STAND-IN FOR ALEXA+'S MODEL. On a real Alexa+ device the
// model picks the MCP tool; here plain keyword rules do, so the demo is deterministic and runs with
// no model at all. Pure: no DOM, no network.
//
// The words the Alexa skill knows are classified by the skill's own router (src/alexa/route.ts:
// "how did I do", live coaching and its minutes, next, stop, quiz me, a sentence with "how did I do"
// run on), so the two surfaces never drift apart. Only the tools the skill has no intent for (stats,
// brief, recap, status) have rules here.
import { clampMinutes, classifyUtterance, normalize } from "../../../src/alexa/route.js";
import type { AlexaIntent, McpToolName } from "../../../src/hub/contract.js";

export { normalize };

export interface DrillState {
  cardOpen: boolean; // a drill card is open (start_drill / next_card returned one)
  attemptId: string | null; // the last submitted attempt, until its verdict is final
}

export type Routed =
  | { kind: "tool"; tool: McpToolName; args: Record<string, unknown>; rule: string }
  | { kind: "help"; rule: string };

// The skill's intents as MCP tools.
function fromIntent(intent: AlexaIntent, minutes: number | null, s: DrillState): Routed | null {
  switch (intent) {
    case "HowDidIDoIntent":
      return s.attemptId ? tool("get_verdict", { attempt_id: s.attemptId }, "how did I do") : tool("drill_status", {}, "how did I do (no attempt yet)");
    case "HowAmIDoingIntent":
      return tool("how_am_i_doing", {}, "how am I doing");
    case "LiveCoachOffIntent":
      return tool("live_coach", { enabled: false }, "live coaching off");
    case "LiveCoachOnIntent": {
      const m = clampMinutes(minutes);
      return tool("live_coach", m ? { enabled: true, minutes: m } : { enabled: true }, "live coaching on");
    }
    case "DidItTransferIntent":
      return tool("did_it_transfer", {}, "did it transfer");
    case "AMAZON.NextIntent":
      return tool("next_card", {}, "next");
    case "AMAZON.StopIntent":
      return tool("end_drill", {}, "stop");
    case "StartDrillIntent":
      return tool("start_drill", {}, "quiz me");
    case "AMAZON.HelpIntent":
      return { kind: "help", rule: "help" };
    default:
      return null;
  }
}

// Tools the skill has no intent for: whole-utterance rules, first match wins.
const SIM_RULES: { rule: string; re: RegExp; to: () => Routed }[] = [
  { rule: "quiz me", re: /^(open speech coach|start)$/, to: () => tool("start_drill", {}, "quiz me") },
  { rule: "stats", re: /^(my )?(stats|habit stats|habits|show my habits|how many hedges|how many unsure words|what are my habits)( this week)?$/, to: () => tool("habit_stats", { range: "week" }, "stats") },
  { rule: "brief", re: /^((give me )?(a |my )?(pre meeting |meeting )?brief|warm me up|what's next on my calendar|prep me for my meeting)$/, to: () => tool("pre_meeting_brief", {}, "brief") },
  { rule: "recap", re: /^((give me )?(the |my )?(last )?recap|how did my last conversation go|recap my last conversation)$/, to: () => tool("last_recap", {}, "recap") },
  { rule: "status", re: /^(status|drill status|where am i|what's my card|what is my card|repeat the card|say the card again)$/, to: () => tool("drill_status", {}, "status") },
];

function tool(name: McpToolName, args: Record<string, unknown>, rule: string): Routed {
  return { kind: "tool", tool: name, args, rule };
}

export function route(text: string, state: DrillState): Routed {
  const t = normalize(text);
  if (!t) return { kind: "help", rule: "empty" };
  const c = classifyUtterance(text);
  if (c.intent !== "AttemptIntent") return fromIntent(c.intent, c.minutes, state) ?? { kind: "help", rule: "help" };
  for (const r of SIM_RULES) if (r.re.test(t)) return r.to();
  if (!state.cardOpen) return { kind: "help", rule: "no card open" };
  // "<sentence> how did I do" in one breath: the router submits the sentence alone; the verdict needs the next turn.
  const said = c.text.trim();
  return tool("submit_attempt", { text: said }, said === text.trim() ? "attempt" : "attempt (how did I do cut)");
}

export const HELP_TEXT = 'Say "quiz me", say the line out loud, then ask "how did I do?". You can also ask "how am I doing?", "is it working?", or say "turn on live coaching".';
