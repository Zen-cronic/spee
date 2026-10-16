// Keyword intent router for the simulator: a STAND-IN FOR ALEXA+'S MODEL. On a real Alexa+ device the
// model picks the MCP tool; here plain keyword rules do, so the demo is deterministic and runs with
// no model at all. Pure: no DOM, no network.
import type { McpToolName } from "../../../src/hub/contract.js";

export interface DrillState {
  cardOpen: boolean; // a drill card is open (start_drill / next_card returned one)
  attemptId: string | null; // the last submitted attempt, until its verdict is final
}

export type Routed =
  | { kind: "tool"; tool: McpToolName; args: Record<string, unknown>; rule: string }
  | { kind: "help"; rule: string };

export function normalize(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) t = t.replace(/^(alexa|um|uh|so|ok|okay|and|hey|well|please|right) /, "");
  return t.replace(/ (please|now|then)$/, "").trim();
}

const WORD_NUM: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, sixty: 60, ninety: 90 };
export function minutesIn(t: string): number | undefined {
  const m = / for (\d+|an|one|two|three|half an|[a-z]+(?: [a-z]+)?) (minutes?|hours?)$/.exec(t);
  if (!m) return undefined;
  const [, n, unit] = m as unknown as [string, string, string];
  if (unit.startsWith("hour")) return n === "an" || n === "one" ? 60 : n === "two" ? 120 : n === "three" ? 180 : /^\d+$/.test(n) ? Math.min(180, Number(n) * 60) : undefined;
  if (n === "half an") return undefined;
  const v = /^\d+$/.test(n) ? Number(n) : WORD_NUM[n];
  return v === undefined ? undefined : Math.max(1, Math.min(180, v));
}

const HOW_DID_I_DO = /^(how did i do|how'd i do|how did that go|how did it go|how was that|did i pass|did i get it|what's the verdict|what is the verdict)( (on|with) (that|it|this one))?( this time)?$/;

// Whole-utterance rules, first match wins. Anything else while a card is open is an attempt.
const RULES: { rule: string; re: RegExp; to: (t: string, s: DrillState) => Routed }[] = [
  { rule: "how did I do", re: HOW_DID_I_DO, to: (_t, s) => (s.attemptId ? tool("get_verdict", { attempt_id: s.attemptId }, "how did I do") : tool("drill_status", {}, "how did I do (no attempt yet)")) },
  { rule: "how am I doing", re: /^(how am i doing|how'm i doing|how am i doing today|how is my speaking|how's my speaking|coach me)$/, to: () => tool("how_am_i_doing", {}, "how am I doing") },
  { rule: "live coaching off", re: /^((turn|switch) off|stop|disable|pause|end) (the )?live coach(ing)?$|^(turn|switch) (the )?live coach(ing)? off$/, to: () => tool("live_coach", { enabled: false }, "live coaching off") },
  {
    rule: "live coaching on",
    re: /^((turn|switch) on|start|enable|resume) (the )?live coach(ing)?( for .+)?$|^(turn|switch) (the )?live coach(ing)? on( for .+)?$/,
    to: (t) => {
      const minutes = minutesIn(t);
      return tool("live_coach", minutes ? { enabled: true, minutes } : { enabled: true }, "live coaching on");
    },
  },
  { rule: "did it transfer", re: /^(did it transfer|is it transferring|did the drilling work|is the drilling working|did my habits drop|did it work)$/, to: () => tool("did_it_transfer", {}, "did it transfer") },
  { rule: "next", re: /^(next|next card|next one|skip|skip it|skip this one|another|another one|move on)$/, to: () => tool("next_card", {}, "next") },
  { rule: "stop", re: /^(stop|cancel|quit|exit|end|end drill|end the drill|stop the drill|i'm done|im done|that's enough|goodbye|bye)$/, to: () => tool("end_drill", {}, "stop") },
  { rule: "quiz me", re: /^(quiz me|drill me|start (a |the )?drill|start drilling|let's drill|let's practice|let's practise|give me a card|open speech coach|start)$/, to: () => tool("start_drill", {}, "quiz me") },
  { rule: "stats", re: /^(my )?(stats|habit stats|habits|show my habits|how many hedges|what are my habits)( this week)?$/, to: () => tool("habit_stats", { range: "week" }, "stats") },
  { rule: "brief", re: /^((give me )?(a |my )?(pre meeting |meeting )?brief|warm me up|what's next on my calendar|prep me for my meeting)$/, to: () => tool("pre_meeting_brief", {}, "brief") },
  { rule: "recap", re: /^((give me )?(the |my )?(last )?recap|how did my last conversation go|recap my last conversation)$/, to: () => tool("last_recap", {}, "recap") },
  { rule: "status", re: /^(status|drill status|where am i|what's my card|what is my card|repeat the card|say the card again)$/, to: () => tool("drill_status", {}, "status") },
  { rule: "help", re: /^(help|what can i say|what can you do)$/, to: () => ({ kind: "help", rule: "help" }) },
];

function tool(name: McpToolName, args: Record<string, unknown>, rule: string): Routed {
  return { kind: "tool", tool: name, args, rule };
}

export function route(text: string, state: DrillState): Routed {
  const t = normalize(text);
  if (!t) return { kind: "help", rule: "empty" };
  for (const r of RULES) if (r.re.test(t)) return r.to(t, state);
  if (state.cardOpen) {
    // "<sentence> how did I do" in one breath: submit the sentence; the verdict needs the next turn.
    const merged = new RegExp(`^(.+?) ${HOW_DID_I_DO.source.slice(1, -1)}$`).exec(t);
    const said = merged && merged[1]!.split(" ").length >= 3 ? stripTail(text) : text.trim();
    return tool("submit_attempt", { text: said }, merged ? "attempt (how did I do cut)" : "attempt");
  }
  return { kind: "help", rule: "no card open" };
}

// Drop a trailing "how did I do?" from the raw text, keeping the user's own casing.
function stripTail(raw: string): string {
  return raw.replace(/[\s,.;:!?-]*(how did i do|how'd i do|how did that go|how did it go|how was that|did i pass)[\s?.!]*$/i, "").trim();
}

export const HELP_TEXT = 'Say "quiz me", then say the sentence on the card, then ask "how did I do?". You can also ask "how am I doing?", "did it transfer?", or say "turn on live coaching".';
