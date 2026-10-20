// Screens for Alexa devices with a display (Fire TV, Echo Show): one APL document
// (alexa/apl/speaking-mirror.json) and the datasource for each screen. Without these, Fire TV shows
// Alexa's own "Speech Coach" card while the skill speaks and listens.
//
// A RenderDocument directive goes out only when the request's device lists
// context.System.device.supportedInterfaces["Alexa.Presentation.APL"]; voice-only devices get the
// same response as before. Colours live in the document's resources only (@colorBee is the one
// colour for "checked by Bee"); the datasource carries words and states. Every string a person reads is masked for the screen here (maskDeep
// "screen"). The Alexa plugin then masks only what Alexa speaks (plugin.ts maskSpoken): the document
// goes out as it is, since its expressions and resource names are not words. Pure, apart from reading
// the document once.
//
// https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-for-screen-devices.html
import { readFileSync } from "node:fs";
import type { CardView, CoachNow, GradeResult } from "../hub/contract.js";
import { habitTitle, PER_100_GLOSS } from "../hub/habitNames.js";
import { maskDeep } from "../hub/mask.js";
import { clean, clip } from "./speech.js";
import type { AlexaDirective, AlexaRequestEnvelope } from "./types.js";

export const APL_INTERFACE = "Alexa.Presentation.APL";
export const APL_DIRECTIVE = "Alexa.Presentation.APL.RenderDocument";
export const APL_DOC_URL = new URL("../../alexa/apl/speaking-mirror.json", import.meta.url);
export const BRAND = "Speaking Mirror";

let doc: Record<string, unknown> | null = null;
/** The APL document, read once. */
export function aplDocument(): Record<string, unknown> {
  doc ??= JSON.parse(readFileSync(APL_DOC_URL, "utf8")) as Record<string, unknown>;
  return doc;
}

/** True when the device that sent this request can show an APL document. */
export function supportsApl(env: AlexaRequestEnvelope): boolean {
  const s = env.context?.System?.device?.supportedInterfaces;
  return !!s && typeof s === "object" && APL_INTERFACE in s;
}

export type ScreenKind = "drill" | "checking" | "verdict" | "progress" | "empty";
export type StepState = "done" | "current" | "todo";
// who: whose step it is; the document colours "you" lime and "bee" @colorBee.
export interface Step {
  label: string;
  state: StepState;
  who: "you" | "bee";
}
export type Tone = "pass" | "fail" | "neutral";
// Every field is always present (empty when a screen does not use it), so each binding in the
// document resolves on every screen.
export interface Screen {
  kind: ScreenKind;
  brand: string;
  kicker: string;
  sentence: string;
  steps: Step[];
  status: string;
  hint: string;
  headline: string;
  tone: Tone; // the headline colour: lime, coral or plain text
  reason: string;
  checked: boolean;
  tag: string;
  hero: string;
  heroCaption: string;
  line: string;
  footerTv: string;
  footerHub: string;
}

export const SCREEN_TEXT = {
  sayThis: "Say this:",
  sayAgain: "Say it again:",
  next: "Next, say:",
  thenAsk: "Then ask: how did I do?",
  checking: "Bee is checking…",
  checkedByBee: "Checked by Bee",
  steps: ["You said it", "Checked by Bee", "Result"], // the same words as the TV's Live tracker (test/claims.test.ts)
  passed: "Passed.",
  notYet: "Not yet.",
  notCounted: "Not counted.",
  footerTv: "Open Speaking Mirror on this TV for details",
  footerHub: "Open Speaking Mirror on your TV for details",
} as const;

const BLANK: Screen = {
  kind: "empty",
  brand: BRAND,
  kicker: "",
  sentence: "",
  steps: [],
  status: "",
  hint: "",
  headline: "",
  tone: "neutral",
  reason: "",
  checked: false,
  tag: SCREEN_TEXT.checkedByBee,
  hero: "",
  heroCaption: "",
  line: "",
  footerTv: SCREEN_TEXT.footerTv,
  footerHub: SCREEN_TEXT.footerHub,
};

const step = (i: number, state: StepState): Step => ({ label: SCREEN_TEXT.steps[i]!, state, who: i === 1 ? "bee" : "you" });
/** The tracker with `at` (0, 1 or 2) as the current step; 3 marks all three done. */
export const tracker = (at: number): Step[] => [0, 1, 2].map((i) => step(i, i < at ? "done" : i === at ? "current" : "todo"));

// Straight quotes to typographic ones, as the TV shows them.
const curly = (s: string) => s.replace(/"([^"]*)"/g, "“$1”");
const say = (resay: string) => clean(resay);

/** Turn 1 of a drill: the sentence to say, nothing said yet. */
export function drillScreen(card: Pick<CardView, "resay">, kicker: string = SCREEN_TEXT.sayThis): Screen {
  return { ...BLANK, kind: "drill", kicker, sentence: say(card.resay), steps: tracker(0), hint: SCREEN_TEXT.thenAsk };
}

/** Said, and Bee is checking (after the attempt, or an early "how did I do?"). */
export function checkingScreen(card: Pick<CardView, "resay"> | null): Screen {
  return { ...BLANK, kind: "checking", kicker: SCREEN_TEXT.sayThis, sentence: card ? say(card.resay) : "", steps: tracker(1), status: SCREEN_TEXT.checking, hint: SCREEN_TEXT.thenAsk };
}

export type VerdictKind = "pass" | "fail" | "unverified";
/**
 * Bee's verdict. `reason` is the TV's own words (plainReason of gradeFailure); `next` is the card to
 * say next (a pass) or again (a fail), else `hint` says what to do.
 */
export function verdictScreen(v: { kind: VerdictKind; grade?: GradeResult | null; next?: Pick<CardView, "resay"> | null; hint?: string }): Screen {
  const headline = v.kind === "pass" ? SCREEN_TEXT.passed : v.kind === "fail" ? SCREEN_TEXT.notYet : SCREEN_TEXT.notCounted;
  const tone: Tone = v.kind === "pass" ? "pass" : v.kind === "fail" ? "fail" : "neutral";
  const reason = v.kind === "pass" ? "Bee heard it." : v.kind === "fail" ? `${plainReason(gradeFailure(v.grade)) ?? "So close"}.` : "Bee didn’t catch that one, so it doesn’t count.";
  const kicker = v.next ? (v.kind === "pass" ? SCREEN_TEXT.next : SCREEN_TEXT.sayAgain) : "";
  return { ...BLANK, kind: "verdict", headline, tone, reason, checked: v.kind !== "unverified", kicker, sentence: v.next ? say(v.next.resay) : "", hint: v.hint ?? "" };
}

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
/** "How am I doing": one number, one sentence of the coach's narration, and where to see more. */
export function progressScreen(c: Pick<CoachNow, "narration" | "week" | "drills">): Screen {
  let hero: string;
  let heroCaption: string;
  if (c.week.topHabit) {
    hero = fmt1(c.week.topHabit.per100);
    heroCaption = `${habitTitle(c.week.topHabit.key)}, ${PER_100_GLOSS} this week`;
  } else if (c.drills.dueNow > 0) {
    hero = String(c.drills.dueNow);
    heroCaption = c.drills.dueNow === 1 ? "line ready to practise" : "lines ready to practise";
  } else {
    hero = String(c.week.words);
    heroCaption = "words Bee heard this week";
  }
  return { ...BLANK, kind: "progress", hero, heroCaption: curly(heroCaption), line: curly(clip(c.narration, 1)) };
}

/** A friendly empty state, or a short note (caught up, no line, live coaching, the hub away). */
export function emptyScreen(headline: string, line: string, hint = ""): Screen {
  return { ...BLANK, kind: "empty", headline: curly(clean(headline)), line: curly(clean(line)), hint: curly(clean(hint)) };
}

export const EMPTY = {
  caughtUp: () => emptyScreen("You’re all caught up.", "No lines to practise right now.", "Ask: how am I doing?"),
  noLine: () => emptyScreen("No line to say right now.", "Start a round, and the line shows here.", "Say: quiz me"),
  noDrill: () => emptyScreen("You’re not practising right now.", "A round gives you a line to say, and Bee checks it.", "Say: quiz me"),
  noAttempt: () => emptyScreen("Nothing to check yet.", "Say a line first, then ask how you did.", "Say: quiz me"),
  hubDown: () => emptyScreen("The coach hub didn’t answer.", "Try again in a moment.", ""),
  help: () => emptyScreen("Practise speaking, checked by Bee.", "Alexa gives you a line. Say it out loud, and Bee checks it in your own voice.", "Say: quiz me, or how am I doing?"),
};

/** The RenderDocument directive for one screen, its datasource masked for a screen. `end`: the session closes with this turn. */
export function renderDirective(screen: Screen, opts: { end?: boolean } = {}): AlexaDirective {
  const base = aplDocument();
  // A screen that closes the session leaves quickly, so the TV goes back to what it was showing.
  const document = opts.end ? { ...base, settings: { idleTimeout: IDLE_AFTER_END_MS } } : base;
  return { type: APL_DIRECTIVE, token: `speakingMirror.${screen.kind}`, document, datasources: { payload: { screen: maskDeep(screen, "screen") } } };
}
export const IDLE_AFTER_END_MS = 6000;

// The grader's first failed rule in the TV's words (tv/web/src/mirror/format.ts gradeFailure and
// plainReason; the TV cannot import hub code and the hub does not import TV code, so the test keeps
// the two copies in step).
export interface GradeFailure {
  rule: GradeResult["checks"][number]["rule"];
  words: string[];
}
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
export function gradeFailure(g: Partial<GradeResult> | null | undefined): GradeFailure | null {
  const fail = g?.checks?.find((c) => !c.ok);
  if (!fail) return null;
  const words =
    fail.rule === "habit"
      ? uniq(g?.habit?.found ?? [])
      : fail.rule === "fillers"
        ? uniq(g?.fillers ?? [])
        : fail.rule === "content"
          ? uniq(g?.missing ?? [])
          : fail.rule === "required"
            ? uniq((g?.required ?? []).filter((r) => !r.ok).map((r) => r.word))
            : [];
  return { rule: fail.rule, words };
}
export function plainReason(f: GradeFailure | null): string | null {
  if (!f) return null;
  const q = f.words.map((w) => `“${w}”`);
  switch (f.rule) {
    case "nonempty":
      return "Bee heard nothing";
    case "habit":
      return q.length ? `You still said ${q.slice(0, 2).join(" and ")}` : "The old habit was still there";
    case "fillers":
      return q.length ? `Bee heard ${q.slice(0, 2).join(" and ")}` : "Bee heard a filler word";
    case "content":
      return f.words.length ? `A few words were missing: ${f.words.slice(0, 3).join(", ")}` : "It didn’t match the sentence";
    case "required":
      return q.length ? `You didn’t say ${q.join(" or ")}` : "A key word was missing";
    default:
      return null;
  }
}
