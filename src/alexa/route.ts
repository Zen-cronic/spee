// Intent routing. The interaction model has a catch-all AttemptIntent ("{attempt}") so
// Alexa hands over the user's drill sentence verbatim. On a real device (2026-10-16) the catch-all
// also swallowed "how did I do", so commands said inside it are rescued here by whole-utterance
// match: a drill sentence that merely contains "next" or "stop" stays an attempt. Pure, and shared
// with the browser simulator (web/sim/src/router.ts), so both surfaces route the same words alike.
import type { AlexaIntent } from "../hub/contract.js";
import type { AlexaRequestEnvelope } from "./types.js";

export interface Routed {
  // NoAnswer: a request the skill may not answer with speech (NO_ANSWER_REQUEST)
  intent: AlexaIntent | "Unknown" | "NoAnswer";
  text: string | null; // the attempt text (AttemptIntent only)
  minutes: number | null; // LiveCoachOnIntent "for 30 minutes"
  rescuedFrom: string | null; // the model's intent when this router changed it
}

export const ATTEMPT_SLOT = "attempt";

const KNOWN = new Set<string>([
  "LaunchRequest",
  "StartDrillIntent",
  "AttemptIntent",
  "HowDidIDoIntent",
  "HowAmIDoingIntent",
  "LiveCoachOnIntent",
  "LiveCoachOffIntent",
  "DidItTransferIntent",
  "AMAZON.NextIntent",
  "AMAZON.HelpIntent",
  "AMAZON.StopIntent",
  "AMAZON.CancelIntent",
  "AMAZON.FallbackIntent",
  "SessionEndedRequest",
]);

// Lower case, apostrophes kept, other punctuation dropped, polite or filler lead-ins removed.
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

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, "twenty five": 25, thirty: 30, "forty five": 45, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  "a hundred and twenty": 120, "one hundred and twenty": 120, "a hundred twenty": 120, "one twenty": 120,
};
export function parseMinutes(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = normalize(s);
  if (/^\d+$/.test(t)) return Number(t);
  if (/^(an|one) hour$/.test(t)) return 60;
  if (/^(two|2) hours$/.test(t)) return 120;
  if (/^(three|3) hours$/.test(t)) return 180;
  if (/^half an hour$/.test(t)) return 30;
  return NUMBER_WORDS[t] ?? null;
}

// Live coaching minutes as the hub takes them: whole minutes, 1 to 180.
export const clampMinutes = (m: number | null | undefined): number | undefined => (m ? Math.max(1, Math.min(180, Math.round(m))) : undefined);

const HOW_DID_I_DO = "(how did i do|how'd i do|how did that go|how did it go|how was that|did i pass|did i get it|did that pass|what's the verdict|what is the verdict|verdict)( (on|with) (that|it|this one))?( this time)?";
const RULES: [AlexaIntent, RegExp][] = [
  ["HowDidIDoIntent", new RegExp(`^${HOW_DID_I_DO}$`)],
  ["HowAmIDoingIntent", /^(how am i doing|how'm i doing|how am i going|how is my speaking|how's my speaking|how am i doing today|how's it going with my speaking|coach me)$/],
  ["LiveCoachOffIntent", /^((turn|switch) off|stop|disable|pause|end) (the )?live coach(ing)?$|^(turn|switch) (the )?live coach(ing)? off$/],
  ["LiveCoachOnIntent", /^((turn|switch) on|start|enable|resume) (the )?live coach(ing)?( for .+)?$|^(turn|switch) (the )?live coach(ing)? on( for .+)?$/],
  ["DidItTransferIntent", /^(did it transfer|is it transferring|did the drilling work|is the drilling working|did my habits drop|did it work|is it working|is the practice working|is practising working)$/],
  ["AMAZON.NextIntent", /^(next|next card|next one|skip|skip it|skip this one|skip that|another|another one|go on|move on)$/],
  ["AMAZON.StopIntent", /^(stop|cancel|quit|exit|end|end drill|end the drill|stop the drill|stop drilling|i'm done|im done|that's enough|that's all|goodbye|bye)$/],
  ["StartDrillIntent", /^(quiz me|drill me|start (a |the )?drill|start drilling|let's drill|let's practice|let's practise|give me a card)$/],
  ["AMAZON.HelpIntent", /^(help|what can i say|what can you do)$/],
];

// Classify one free-text utterance (the catch-all slot, or the simulator's text box).
export function classifyUtterance(text: string): { intent: AlexaIntent; minutes: number | null; text: string } {
  const n = normalize(text);
  for (const [intent, re] of RULES) {
    if (!re.test(n)) continue;
    const m = intent === "LiveCoachOnIntent" ? / for (.+?)( minutes?)?$/.exec(n) : null;
    return { intent, minutes: m ? parseMinutes(m[1]) : null, text };
  }
  // A drill sentence with "how did I do" run on: grade the sentence; the verdict needs turn 2.
  const merged = new RegExp(`^(.+?) ${HOW_DID_I_DO}$`).exec(n);
  if (merged && merged[1]!.split(" ").length >= 3) return { intent: "AttemptIntent", minutes: null, text: rawPrefix(text, merged[1]!) };
  return { intent: "AttemptIntent", minutes: null, text };
}

// The words of `raw` that normalize to `cut`, in the user's own casing and without trailing
// punctuation ("The export shipped on Monday. What's the verdict?" -> "The export shipped on
// Monday"); `cut` itself when no prefix matches.
function rawPrefix(raw: string, cut: string): string {
  const words = raw.trim().split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const prefix = words.slice(0, i).join(" ");
    if (normalize(prefix) === cut) return prefix.replace(/[\s,.;:!?-]+$/, "");
  }
  return cut;
}

// Requests Alexa sends about the skill's own output: an APL document that failed on the device
// (Alexa.Presentation.APL.RuntimeError; the document sends no other APL request) and a response
// Alexa could not use (System.ExceptionEncountered). The skill cannot answer them with speech.
export const NO_ANSWER_REQUEST = (type: string) => type.startsWith("Alexa.Presentation.APL.") || type === "System.ExceptionEncountered";

export function routeRequest(env: AlexaRequestEnvelope): Routed {
  const type = env.request.type;
  if (type === "LaunchRequest") return { intent: "LaunchRequest", text: null, minutes: null, rescuedFrom: null };
  if (type === "SessionEndedRequest") return { intent: "SessionEndedRequest", text: null, minutes: null, rescuedFrom: null };
  if (NO_ANSWER_REQUEST(type)) return { intent: "NoAnswer", text: null, minutes: null, rescuedFrom: null };
  if (type !== "IntentRequest" || !env.request.intent) return { intent: "Unknown", text: null, minutes: null, rescuedFrom: null };
  const name = env.request.intent.name;
  const slots = env.request.intent.slots ?? {};
  if (name === "AttemptIntent") {
    const raw = slots[ATTEMPT_SLOT]?.value?.trim() ?? "";
    if (!raw) return { intent: "AMAZON.FallbackIntent", text: null, minutes: null, rescuedFrom: name };
    const c = classifyUtterance(raw);
    if (c.intent === "AttemptIntent") return { intent: "AttemptIntent", text: c.text, minutes: null, rescuedFrom: null };
    return { intent: c.intent, text: null, minutes: c.minutes, rescuedFrom: name };
  }
  if (name === "LiveCoachOnIntent") return { intent: name, text: null, minutes: parseMinutes(slots.minutes?.value), rescuedFrom: null };
  if (name === "AMAZON.NavigateHomeIntent") return { intent: "AMAZON.StopIntent", text: null, minutes: null, rescuedFrom: name };
  if (KNOWN.has(name)) return { intent: name as AlexaIntent, text: null, minutes: null, rescuedFrom: null };
  return { intent: "Unknown", text: null, minutes: null, rescuedFrom: null };
}
