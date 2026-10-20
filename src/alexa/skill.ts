// The Alexa skill handler (packet C): a pure function of the request envelope and its dependencies
// (the loopback hub client, a clock, a sleep, the progressive-response sender). Every intent maps
// onto a contract route; nothing here calls a model, and nothing here persists transcript text.
//
// Drills take two turns because Alexa must answer within 8 s and Bee's wearer-tagged line lands 5
// to 20 s after speech (docs/CONTRACT.md, "Two-turn voice drill"):
//   turn 1  AttemptIntent   POST /api/attempt {source:"alexa"} -> 202 pending_bee; "checking with Bee"
//   turn 2  HowDidIDoIntent GET /api/attempts/<id>; not ready -> progressive response, poll <= 6.5 s
// Alexa's own transcript is provisional; the verdict spoken is always Bee's final grade.
import type { AlexaIntent, CardView, VerdictResponse } from "../hub/contract.js";
import type { HubClient, HubResult } from "../mcp/hubClient.js";
import { clampMinutes, routeRequest, type Routed } from "./route.js";
import { clip, failReason, line, sayCard, seconds } from "./speech.js";
import type { AlexaRequestEnvelope, AlexaResponseEnvelope, SessionAttributes } from "./types.js";

export interface SkillDeps {
  hub: HubClient;
  now(): number; // ms; used for the polling budget only
  sleep(ms: number): Promise<void>;
  // Sends "VoicePlayer.Speak" for this request; resolves false when the request has no usable
  // apiEndpoint/apiAccessToken. The handler does not wait for it.
  progressive(env: AlexaRequestEnvelope, speech: string): Promise<boolean>;
  log?(event: string, data?: Record<string, unknown>): void;
  pollBudgetMs?: number; // default 6500 (Alexa's limit is 8 s)
  pollEveryMs?: number; // default 600
}

export const POLL_BUDGET_MS = 6500;
export const POLL_EVERY_MS = 600;

export const SPEECH = {
  launchNoCard: "You're all caught up: no lines to practise right now. Ask me how you're doing, or say stop.",
  checking: "Checking with Bee.",
  askHowDidIDo: "Ask me: how did I do?",
  noAttempt: "There's nothing to check yet. Say quiz me to start practising.",
  noCard: "There's no line to say right now. Say quiz me to start practising.",
  noDrill: "You're not practising right now. Say quiz me to start.",
  hubDown: "The coach hub didn't answer. Try again in a moment.",
  help: "I help you practise speaking, and Bee checks every line in your own voice. Say quiz me, how am I doing, or turn on live coaching.",
  helpReprompt: "Say quiz me, or how am I doing.",
  fallbackCard: "I didn't catch that. Say the sentence again, or ask how did I do.",
  fallbackIdle: "Say quiz me to practise, or ask how am I doing.",
  bye: "Bye.",
  infoReprompt: "Say quiz me to practise, or stop.",
} as const;

type Out = { text: string; reprompt?: string; end?: boolean; attrs: SessionAttributes };

export function respond(o: Out): AlexaResponseEnvelope {
  const end = o.end ?? false;
  return {
    version: "1.0",
    sessionAttributes: o.attrs,
    response: {
      outputSpeech: { type: "PlainText", text: o.text },
      ...(!end && o.reprompt ? { reprompt: { outputSpeech: { type: "PlainText" as const, text: o.reprompt } } } : {}),
      shouldEndSession: end,
    },
  };
}

const without = (a: SessionAttributes, ...keys: string[]): SessionAttributes => Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)));

export async function handleAlexa(env: AlexaRequestEnvelope, deps: SkillDeps): Promise<{ envelope: AlexaResponseEnvelope; routed: Routed; hubCalls: string[] }> {
  const t0 = deps.now();
  const routed = routeRequest(env);
  const attrs: SessionAttributes = { ...(env.session?.attributes ?? {}) };
  const isNew = !!env.session?.new;
  const hub = deps.hub;
  const hubCalls: string[] = [];
  const track = async <T>(name: string, p: Promise<HubResult<T>>) => {
    const r = await p;
    hubCalls.push(`${name} ${r.status}`);
    return r;
  };
  const hubDown = (): Out => ({ text: SPEECH.hubDown, reprompt: SPEECH.helpReprompt, attrs });
  // One-shot questions ("Alexa, ask speech coach how am I doing") end; mid-session ones stay open.
  const info = (text: string, reprompt: string): Out => ({ text, reprompt, end: isNew, attrs });

  const openCard = async (): Promise<CardView | null> => {
    const s = await track("GET /api/session", hub.session());
    return s.ok ? s.body.openCard : null;
  };

  const handlers: Record<AlexaIntent | "Unknown", () => Promise<Out | null>> = {
    LaunchRequest: () => start("launch"),
    StartDrillIntent: () => start("start"),
    async AttemptIntent() {
      const r = await track("POST /api/attempt", hub.attempt({ text: routed.text ?? "", source: "alexa" }));
      if (!r.ok) {
        if (r.body.error === "no_open_card") return { text: SPEECH.noCard, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId") };
        if (r.status === 0 || r.status >= 500) return hubDown();
        return { text: SPEECH.fallbackCard, reprompt: SPEECH.askHowDidIDo, attrs };
      }
      return {
        text: line([`Got it, checking with Bee`, `Ask me how you did in about ${seconds(r.body.retryAfterMs)}`]),
        reprompt: SPEECH.askHowDidIDo,
        attrs: { ...attrs, attemptId: r.body.attempt.id, cardId: r.body.attempt.cardId },
      };
    },
    async HowDidIDoIntent() {
      let id = typeof attrs.attemptId === "string" ? attrs.attemptId : null;
      if (!id) {
        const s = await track("GET /api/session", hub.session());
        if (!s.ok) return hubDown();
        id = s.body.lastAttempt?.id ?? null;
      }
      if (!id) return { text: SPEECH.noAttempt, reprompt: SPEECH.helpReprompt, attrs };
      let v = await track("GET /api/attempts/<id>", hub.verdict(id));
      if (!v.ok) {
        if (v.status === 404) return { text: "I lost track of that one. Say the line again.", reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId") };
        return hubDown();
      }
      if (!v.body.verdictReady) {
        void deps.progressive(env, SPEECH.checking).then(
          (sent) => deps.log?.("alexa.progressive", { sent }),
          () => deps.log?.("alexa.progressive", { sent: false }),
        );
        const budget = deps.pollBudgetMs ?? POLL_BUDGET_MS;
        const every = deps.pollEveryMs ?? POLL_EVERY_MS;
        while (deps.now() - t0 + every <= budget) {
          await deps.sleep(every);
          const next: HubResult<VerdictResponse> = await track("GET /api/attempts/<id>", hub.verdict(id));
          if (!next.ok) break;
          v = next;
          if (v.body.verdictReady) break;
        }
      }
      if (!v.ok) return hubDown();
      if (!v.body.verdictReady) return { text: clip(v.body.narration), reprompt: SPEECH.askHowDidIDo, attrs: { ...attrs, attemptId: id } };
      return verdictOut(v.body, without(attrs, "attemptId"));
    },
    async HowAmIDoingIntent() {
      const c = await track("GET /api/coach/now", hub.coachNow());
      if (!c.ok) return hubDown();
      return info(clip(c.body.narration, 4), c.body.mode.enabled ? "Say quiz me to practise, or turn off live coaching." : "Say quiz me to practise, or turn on live coaching.");
    },
    LiveCoachOnIntent: () => live(true),
    LiveCoachOffIntent: () => live(false),
    async DidItTransferIntent() {
      const t = await track("GET /api/transfer", hub.transfer());
      if (!t.ok) return t.body.error === "no_prereg" ? info("There's no before-and-after plan yet, so there's nothing to report.", SPEECH.infoReprompt) : hubDown();
      return info(clip(t.body.headline), SPEECH.infoReprompt);
    },
    async "AMAZON.NextIntent"() {
      const n = await track("POST /api/session/next", hub.nextCard());
      if (!n.ok) return hubDown();
      if (n.body.card) return { text: line([sayCard("Next, say:", n.body.card.resay)]), reprompt: sayCard("Say:", n.body.card.resay), attrs: { ...without(attrs, "attemptId"), cardId: n.body.card.id } };
      if (n.body.summary) return { text: line([summaryLine(n.body.summary), SPEECH.bye]), end: true, attrs: without(attrs, "attemptId", "cardId") };
      return { text: SPEECH.noDrill, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId", "cardId") };
    },
    "AMAZON.StopIntent": () => stop(),
    "AMAZON.CancelIntent": () => stop(),
    "AMAZON.HelpIntent": async () => ({ text: SPEECH.help, reprompt: SPEECH.helpReprompt, attrs }),
    "AMAZON.FallbackIntent": async () => (attrs.cardId ? { text: SPEECH.fallbackCard, reprompt: SPEECH.askHowDidIDo, attrs } : { text: SPEECH.fallbackIdle, reprompt: SPEECH.helpReprompt, attrs }),
    Unknown: async () => (attrs.cardId ? { text: SPEECH.fallbackCard, reprompt: SPEECH.askHowDidIDo, attrs } : { text: SPEECH.fallbackIdle, reprompt: SPEECH.helpReprompt, attrs }),
    // Alexa closed the session (the user went quiet, said nothing valid, or an error). The drill this
    // skill session started (its id is in the session attributes) is ended on the hub too, so it does
    // not keep live nudges muted (drill-active). A drill started since by anyone else (the simulator,
    // an MCP client, the TV, another Alexa session) is left alone. No speech is allowed here.
    SessionEndedRequest: async () => {
      const mine = typeof attrs.drillSessionId === "string" ? attrs.drillSessionId : null;
      if (!mine) return null;
      const state = await track("GET /api/session", hub.session());
      if (state.ok && state.body.session?.id === mine) await track("POST /api/session/end", hub.endSession());
      return null;
    },
  };

  async function start(kind: "launch" | "start"): Promise<Out> {
    const r = await track("POST /api/session/start", hub.startSession({ by: "alexa" }));
    if (!r.ok) return hubDown();
    const card = r.body.card;
    if (!card) return { text: SPEECH.launchNoCard, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId", "cardId", "drillSessionId") };
    return {
      text: line([sayCard(kind === "launch" ? "Speech coach. Say this:" : "Here's your first line. Say:", card.resay)]),
      reprompt: sayCard("Say:", card.resay),
      attrs: { ...without(attrs, "attemptId"), cardId: card.id, drillSessionId: r.body.session.id },
    };
  }

  async function live(enabled: boolean): Promise<Out> {
    const minutes = enabled ? clampMinutes(routed.minutes) : undefined;
    const r = await track("POST /api/live/mode", hub.liveMode({ enabled, by: "alexa", ...(minutes ? { minutes } : {}) }));
    if (!r.ok) return hubDown();
    return info(clip(r.body.narration), SPEECH.infoReprompt);
  }

  async function stop(): Promise<Out> {
    const bye: Out = { text: SPEECH.bye, end: true, attrs: without(attrs, "attemptId", "cardId", "drillSessionId") };
    const state = await track("GET /api/session", hub.session());
    if (state.ok && !state.body.session) return bye; // nothing running: don't repeat an old summary
    const r = await track("POST /api/session/end", hub.endSession());
    const s = r.ok ? r.body.summary : null;
    return s && s.attempts > 0 ? { ...bye, text: line([summaryLine(s), SPEECH.bye]) } : bye;
  }

  async function verdictOut(v: VerdictResponse, rest: SessionAttributes): Promise<Out> {
    const a = v.attempt;
    if (v.status === "graded" && a.final?.pass) {
      const n = await track("POST /api/session/next", hub.nextCard());
      if (n.ok && n.body.card) return { text: line(["Nice, Bee heard it", sayCard("Next, say:", n.body.card.resay)]), reprompt: sayCard("Say:", n.body.card.resay), attrs: { ...rest, cardId: n.body.card.id } };
      if (n.ok && n.body.summary) return { text: line(["Nice, Bee heard it", summaryLine(n.body.summary)]), end: true, attrs: without(rest, "cardId") };
      return { text: "Nice, Bee heard it.", reprompt: "Say quiz me for another line, or stop.", attrs: rest };
    }
    const card = await openCard();
    const again = card ? sayCard("Say it again:", card.resay) : "Say quiz me to try another line";
    const why = v.status === "graded" && a.final ? `Not yet: ${failReason(a.final.grade)}` : "Bee didn't confirm that one, so it doesn't count";
    return { text: line([why, again]), reprompt: card ? sayCard("Say:", card.resay) : SPEECH.helpReprompt, attrs: card ? { ...rest, cardId: card.id } : rest };
  }

  const out = await handlers[routed.intent]();
  deps.log?.("alexa.intent", { intent: routed.intent, rescuedFrom: routed.rescuedFrom, calls: hubCalls.length, ms: deps.now() - t0 });
  const envelope: AlexaResponseEnvelope = out ? respond(out) : { version: "1.0", response: {} };
  return { envelope, routed, hubCalls };
}

export function summaryLine(s: { passed: number; counted: number; attempts: number }): string {
  if (!s.counted) return s.attempts ? "Bee didn't confirm any of those this time" : "That's the round";
  return `That's the round: ${s.passed} of ${s.counted} lines passed, checked by Bee`;
}
