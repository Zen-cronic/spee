// The Alexa skill handler: a pure function of the request envelope and its dependencies
// (the loopback hub client, a clock, a sleep, the progressive-response sender). Every intent maps
// onto a contract route; nothing here calls a model, and nothing here persists transcript text.
//
// Drills take two turns: a drill line can take up to about 20 s, because Bee may merge it with the
// next words, and Alexa must answer within 8 s (FACTS.md, L2; docs/CONTRACT.md, "Two-turn voice drill"):
//   turn 1  AttemptIntent   POST /api/attempt {source:"alexa"} -> 202 pending_bee; "checking with Bee"
//   turn 2  HowDidIDoIntent GET /api/attempts/<id>; not ready -> progressive response, poll <= 6.5 s
// Alexa's own transcript is provisional; the verdict spoken is always Bee's final grade.
// On a device with a screen (Fire TV, Echo Show) each turn also renders a Speaking Mirror screen
// (./apl.ts); the speech, the reprompts and the timing are the same with or without one.
import type { CardView, SessionSummary, VerdictResponse } from "../hub/contract.js";
import { roundLineWords } from "../hub/roundWords.js";
import type { HubClient, HubResult } from "../mcp/hubClient.js";
import { clampMinutes, routeRequest, type Routed } from "./route.js";
import { EMPTY, checkingScreen, drillScreen, emptyScreen, progressScreen, renderDirective, supportsApl, verdictScreen, type Screen } from "./apl.js";
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

// screen: set only when the device can show APL (handleAlexa checks supportedInterfaces).
type Out = { text: string; reprompt?: string; end?: boolean; attrs: SessionAttributes; screen?: Screen };

export function respond(o: Out): AlexaResponseEnvelope {
  const end = o.end ?? false;
  return {
    version: "1.0",
    sessionAttributes: o.attrs,
    response: {
      outputSpeech: { type: "PlainText", text: o.text },
      ...(!end && o.reprompt ? { reprompt: { outputSpeech: { type: "PlainText" as const, text: o.reprompt } } } : {}),
      shouldEndSession: end,
      ...(o.screen ? { directives: [renderDirective(o.screen, { end })] } : {}),
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
  const apl = supportsApl(env);
  // A screen for this turn, built only for a device with a display (it may cost one more hub call).
  const screen = async (f: () => Screen | Promise<Screen>): Promise<Screen | undefined> => (apl ? f() : undefined);
  const hubCalls: string[] = [];
  const track = async <T>(name: string, p: Promise<HubResult<T>>) => {
    const r = await p;
    hubCalls.push(`${name} ${r.status}`);
    return r;
  };
  const hubDown = async (): Promise<Out> => ({ text: SPEECH.hubDown, reprompt: SPEECH.helpReprompt, attrs, screen: await screen(EMPTY.hubDown) });
  // One-shot questions ("Alexa, ask speech coach how am I doing") end; mid-session ones stay open.
  const info = async (text: string, reprompt: string, shown?: () => Screen): Promise<Out> => ({ text, reprompt, end: isNew, attrs, screen: shown ? await screen(shown) : undefined });

  const openCard = async (): Promise<CardView | null> => {
    const s = await track("GET /api/session", hub.session());
    return s.ok ? s.body.openCard : null;
  };
  // The open line to say again (a turn that checked nothing must not leave "Bee is checking…" up).
  const lineAgain = (none: () => Screen) => screen(async () => {
    const card = await openCard();
    return card ? drillScreen(card) : none();
  });

  const handlers: Record<Routed["intent"], () => Promise<Out | null>> = {
    LaunchRequest: () => start("launch"),
    StartDrillIntent: () => start("start"),
    async AttemptIntent() {
      const r = await track("POST /api/attempt", hub.attempt({ text: routed.text ?? "", source: "alexa" }));
      if (!r.ok) {
        if (r.body.error === "no_open_card") return { text: SPEECH.noCard, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId"), screen: await screen(EMPTY.noLine) };
        if (r.status === 0 || r.status >= 500) return hubDown();
        return { text: SPEECH.fallbackCard, reprompt: SPEECH.askHowDidIDo, attrs, screen: await lineAgain(EMPTY.noLine) };
      }
      return {
        text: line([`Got it, checking with Bee`, `Ask me how you did in about ${seconds(r.body.retryAfterMs)}`]),
        reprompt: SPEECH.askHowDidIDo,
        attrs: { ...attrs, attemptId: r.body.attempt.id, cardId: r.body.attempt.cardId },
        screen: await screen(async () => checkingScreen(await openCard())),
      };
    },
    async HowDidIDoIntent() {
      let id = typeof attrs.attemptId === "string" ? attrs.attemptId : null;
      if (!id) {
        const s = await track("GET /api/session", hub.session());
        if (!s.ok) return hubDown();
        id = s.body.lastAttempt?.id ?? null;
      }
      if (!id) return { text: SPEECH.noAttempt, reprompt: SPEECH.helpReprompt, attrs, screen: await screen(EMPTY.noAttempt) };
      let v = await track("GET /api/attempts/<id>", hub.verdict(id));
      if (!v.ok) {
        if (v.status === 404) return { text: "I lost track of that one. Say the line again.", reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId"), screen: await lineAgain(EMPTY.noAttempt) };
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
      if (!v.body.verdictReady) return { text: clip(v.body.narration), reprompt: SPEECH.askHowDidIDo, attrs: { ...attrs, attemptId: id }, screen: await screen(async () => checkingScreen(await openCard())) };
      return verdictOut(v.body, without(attrs, "attemptId"));
    },
    async HowAmIDoingIntent() {
      const c = await track("GET /api/coach/now", hub.coachNow());
      if (!c.ok) return hubDown();
      return info(clip(c.body.narration, 4), c.body.mode.enabled ? "Say quiz me to practise, or turn off live coaching." : "Say quiz me to practise, or turn on live coaching.", () => progressScreen(c.body));
    },
    LiveCoachOnIntent: () => live(true),
    LiveCoachOffIntent: () => live(false),
    async DidItTransferIntent() {
      const t = await track("GET /api/transfer", hub.transfer());
      if (!t.ok) return t.body.error === "no_prereg" ? info("There's no before-and-after plan yet, so there's nothing to report.", SPEECH.infoReprompt, () => emptyScreen("Nothing to report yet.", "There’s no before-and-after plan yet.")) : hubDown();
      return info(clip(t.body.headline), SPEECH.infoReprompt, () => emptyScreen("Did it carry over?", clip(t.body.headline)));
    },
    async "AMAZON.NextIntent"() {
      const n = await track("POST /api/session/next", hub.nextCard());
      if (!n.ok) return hubDown();
      const card = n.body.card;
      if (card) return { text: line([sayCard("Next, say:", card.resay)]), reprompt: sayCard("Say:", card.resay), attrs: { ...without(attrs, "attemptId"), cardId: card.id }, screen: await screen(() => drillScreen(card, "Next, say:")) };
      const sum = n.body.summary;
      if (sum) return { text: line([summaryLine(sum), SPEECH.bye]), end: true, attrs: without(attrs, "attemptId", "cardId"), screen: await screen(() => summaryScreen(sum)) };
      return { text: SPEECH.noDrill, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId", "cardId"), screen: await screen(EMPTY.noDrill) };
    },
    "AMAZON.StopIntent": () => stop(),
    "AMAZON.CancelIntent": () => stop(),
    // With a line open, its screen stays up (a response without a document leaves the last one shown).
    "AMAZON.HelpIntent": async () => ({ text: SPEECH.help, reprompt: SPEECH.helpReprompt, attrs, screen: attrs.cardId ? undefined : await screen(EMPTY.help) }),
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
    // An APL document failed on the device, or Alexa could not use the last response: logged (the
    // request type, the token and the error kinds; never a message, which can quote the screen) and
    // answered with an empty response, as Alexa requires. The drill and the screen stay as they are.
    NoAnswer: async () => {
      const r = env.request;
      const errors = r.errors?.map((x) => (x.reason ? `${x.type ?? "?"}:${x.reason}` : (x.type ?? "?"))) ?? (r.error?.type ? [r.error.type] : []);
      deps.log?.("alexa.no-answer", { type: r.type, token: r.token ?? null, errors });
      return null;
    },
  };

  async function start(kind: "launch" | "start"): Promise<Out> {
    const r = await track("POST /api/session/start", hub.startSession({ by: "alexa" }));
    if (!r.ok) return hubDown();
    const card = r.body.card;
    if (!card) return { text: SPEECH.launchNoCard, reprompt: SPEECH.helpReprompt, attrs: without(attrs, "attemptId", "cardId", "drillSessionId"), screen: await screen(EMPTY.caughtUp) };
    return {
      text: line([sayCard(kind === "launch" ? "Speech coach. Say this:" : "Here's your first line. Say:", card.resay)]),
      reprompt: sayCard("Say:", card.resay),
      attrs: { ...without(attrs, "attemptId"), cardId: card.id, drillSessionId: r.body.session.id },
      screen: await screen(() => drillScreen(card)),
    };
  }

  async function live(enabled: boolean): Promise<Out> {
    const minutes = enabled ? clampMinutes(routed.minutes) : undefined;
    const r = await track("POST /api/live/mode", hub.liveMode({ enabled, by: "alexa", ...(minutes ? { minutes } : {}) }));
    if (!r.ok) return hubDown();
    return info(clip(r.body.narration), SPEECH.infoReprompt, () => emptyScreen(enabled ? "Live coaching is on." : "Live coaching is off.", clip(r.body.narration, 1)));
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
      const next = n.ok ? n.body.card : null;
      const sum = n.ok ? n.body.summary : null;
      if (next) return { text: line(["Nice, Bee heard it", sayCard("Next, say:", next.resay)]), reprompt: sayCard("Say:", next.resay), attrs: { ...rest, cardId: next.id }, screen: await screen(() => verdictScreen({ kind: "pass", next })) };
      if (sum) return { text: line(["Nice, Bee heard it", summaryLine(sum)]), end: true, attrs: without(rest, "cardId"), screen: await screen(() => verdictScreen({ kind: "pass", hint: summaryLine(sum) })) };
      return { text: "Nice, Bee heard it.", reprompt: "Say quiz me for another line, or stop.", attrs: rest, screen: await screen(() => verdictScreen({ kind: "pass", hint: "Say: quiz me" })) };
    }
    const card = await openCard();
    const again = card ? sayCard("Say it again:", card.resay) : "Say quiz me to try another line";
    const graded = v.status === "graded" && a.final;
    const why = graded ? `Not yet: ${failReason(a.final!.grade)}` : "Bee didn't confirm that one, so it doesn't count";
    const shown = await screen(() => verdictScreen({ kind: graded ? "fail" : "unverified", grade: a.final?.grade ?? null, next: card, hint: card ? "" : "Say: quiz me" }));
    return { text: line([why, again]), reprompt: card ? sayCard("Say:", card.resay) : SPEECH.helpReprompt, attrs: card ? { ...rest, cardId: card.id } : rest, screen: shown };
  }

  const out = await handlers[routed.intent]();
  deps.log?.("alexa.intent", { intent: routed.intent, rescuedFrom: routed.rescuedFrom, calls: hubCalls.length, ms: deps.now() - t0 });
  const envelope: AlexaResponseEnvelope = out ? respond(out) : { version: "1.0", response: {} };
  return { envelope, routed, hubCalls };
}

type RoundEnd = Pick<SessionSummary, "counted" | "attempts" | "cards" | "lines"> & Partial<SessionSummary>;
// The round in the TV's words (roundLineWords), each line once as Round over counts it: "1 of 2
// lines passed, checked by Bee (1 not yet)" (a line missed and then passed on a retry is one line
// passed, never two tries). A round with no line Bee checked says so, never "checked by Bee".

/** The end of a round, on a screen. */
export function summaryScreen(s: RoundEnd): Screen {
  return emptyScreen("That’s the round.", s.cards ? `${roundLineWords(s).said}.`.replace(/'/g, "’") : "");
}

export function summaryLine(s: RoundEnd): string {
  const w = roundLineWords(s);
  if (w.checked) return `That's the round: ${w.said}`;
  return s.cards ? w.said : "That's the round";
}
