// SYNTHETIC demo conversations for the live engine (POST /api/demo/live, npm run demo:replay).
// Every line is invented, for the fictional wearer "Ada" and fictional colleagues. The colleagues'
// lines are never tagged, so the engine sees them as word counts only; the story plants one of
// them (PLANTED_OTHER_MARKER) to prove that another speaker's words never reach a surface or disk.
//
// Timing is story time (ms from the call). The director (setup.ts DemoDirector.replayConversation)
// turns a schedule into Bee-shaped events: new-utterance 5.4 s after a line ends, the wearer tag
// 0.5 s later (FL-8), all scaled by the demo pace.
import type { DemoLiveScript } from "../contract.js";
import { DEMO_SENTENCES } from "../demoData.js";

export const PLANTED_OTHER_MARKER = "zebra orchid";
export const DEMO_CONV_START_MS = 1000; // new-conversation, after the call
export const BEE_LINE_LAG_MS = 5400; // new-utterance after the line ends
export const BEE_TAG_LAG_MS = 5900; // tagged-utterance after the line ends
export const ADA_WPM = 140;
export const OTHER_WPM = 165;

export interface DemoLine {
  who: "ada" | "other";
  text: string;
  pauseBeforeMs?: number;
  expect?: "nudge.sent" | "nudge.skipped"; // what the engine should do on this line (story notes)
}
export interface DemoScript {
  name: DemoLiveScript;
  description: string;
  lines: DemoLine[];
}

const ada = (text: string, expect?: DemoLine["expect"]): DemoLine => ({ who: "ada", text, expect });
const other = (text: string): DemoLine => ({ who: "other", text });

export const DEMO_SCRIPTS: Record<DemoLiveScript, DemoScript> = {
  story: {
    name: "story",
    description:
      "Ada's stand-up chat about the export (synthetic, about 3 minutes): a hedge streak after the first minute -> nudge.sent; a second streak inside the 3-minute cooldown -> nudge.skipped (cooldown); 90 s idle -> conversation.ended -> recap.ready. With live coaching off, the first streak is nudge.skipped (reason off). One colleague line is planted to prove other speakers are never stored.",
    lines: [
      ada("Morning! I just got back from the vendor call about the export."),
      other("Great, how did it go with their team?"),
      ada("It went well. They can send the new file format next week."),
      other("Did they agree to the column names we asked for?"),
      ada("Yes, all twelve columns, and the dates come in ISO format now."),
      ada("I wrote the mapping this morning and the tests pass locally."),
      other("The billing team asked about it again yesterday."),
      ada("I told them the load test reached five hundred requests per second."),
      ada("The staging server handled it without errors, which was a relief."),
      other("And the accessibility audit, is that still open?"),
      ada("Two contrast fixes are merged, and two more are in review."),
      other("Nice. So when can we turn the export on for customers?"),
      ada("I guess we could maybe ship the export on Friday."),
      ada("I think the retry logic is kind of ready, but not fully.", "nudge.sent"),
      other("What is left on the retry logic?"),
      ada("Probably just the alerting, and one more review from Priya."),
      other("Okay. Priya is out on Thursday, so ask her today."),
      ada("Good point, I will message her right after this."),
      other(`Between us, the ${PLANTED_OTHER_MARKER} passcode is 4417, keep it quiet.`),
      ada("Understood. The support team also wants a short note for customers."),
      ada("So, like, a paragraph on the new columns and the date format."),
      other("Can you draft that and send it to me first?"),
      ada("Yes, I will send the draft by three o'clock today."),
      other("Merci. On se parle vendredi?"),
      ada("Oui, c'est bon pour vendredi, on se parle après le stand-up."),
      other("One more thing: the partner integration bug from last week."),
      ada("I guess the currency fix is maybe in the next release.", "nudge.skipped"),
      ada("I think it sort of depends on the payment provider."),
      other("Do we have a ticket with them?"),
      ada("We do, and I will check it with finance today."),
      other("Fine. Let's review the export plan again tomorrow at ten."),
      ada("Sounds good. I will bring the test results and the customer note."),
      ada("The the rollout checklist is in the shared tracker as well."),
      other("Perfect, thanks for the update."),
      ada("Thanks, talk to you tomorrow."),
    ],
  },
  monologue: {
    name: "monologue",
    description: "Ada explains the migration plan without a break (synthetic): after 90 s of one turn -> nudge.sent (monologue); then idle -> conversation.ended -> recap.ready.",
    lines: [
      other("So walk me through the migration plan."),
      ...DEMO_SENTENCES.slice(0, 22).map((t, i) => ({ ...ada(t), ...(i === 19 ? { expect: "nudge.sent" as const } : {}), pauseBeforeMs: 600 })),
      other("That makes sense, thanks for walking me through it."),
      ada("Happy to help."),
    ],
  },
  short: {
    name: "short",
    description: "A quick exchange (synthetic): under 60 of Ada's words, so conversation.ended has recap \"skipped-short\" and no recap is made.",
    lines: [other("Quick question, is the demo still at two?"), ada("Yes, at two, in the small room."), other("Thanks."), ada("See you there.")],
  },
};

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export interface ScheduledLine extends DemoLine {
  startMs: number; // story ms after the call
  endMs: number;
  durMs: number;
  words: number;
}
export interface Schedule {
  script: DemoScript;
  convStartMs: number;
  lines: ScheduledLine[];
  lastEndMs: number;
}

// Place the lines on a story timeline: a speaker's rate gives each line's length; 0.7 s between a
// speaker's own lines and 1.1 s at a turn change, unless the line says otherwise.
export function scheduleScript(script: DemoScript, convStartMs = DEMO_CONV_START_MS): Schedule {
  let t = convStartMs + 1500;
  let prev: DemoLine["who"] | null = null;
  const lines: ScheduledLine[] = script.lines.map((l) => {
    t += prev == null ? 0 : (l.pauseBeforeMs ?? (prev === l.who ? 700 : 1100));
    const n = words(l.text);
    const durMs = Math.round((n / (l.who === "ada" ? ADA_WPM : OTHER_WPM)) * 60_000);
    const s: ScheduledLine = { ...l, startMs: t, endMs: t + durMs, durMs, words: n };
    t += durMs;
    prev = l.who;
    return s;
  });
  return { script, convStartMs, lines, lastEndMs: t };
}

// The steps a DemoLiveResponse announces (story ms; the plugin scales them by the pace).
export function predictedSteps(s: Schedule, opts: { idleEndMs: number; tagWaitMs: number; wristMs: number }): { atMs: number; what: string }[] {
  const steps: { atMs: number; what: string }[] = [];
  const wearer = s.lines.filter((l) => l.who === "ada");
  const first = wearer[0];
  if (first) steps.push({ atMs: first.endMs + BEE_TAG_LAG_MS, what: "conversation.started" });
  let lastWindow = -Infinity;
  for (const l of wearer) {
    const at = l.endMs + BEE_TAG_LAG_MS;
    if (at - lastWindow >= 30_000) (steps.push({ atMs: at, what: "live.window" }), (lastWindow = at));
    if (l.expect === "nudge.sent") steps.push({ atMs: at + opts.wristMs, what: "nudge.sent" });
    if (l.expect === "nudge.skipped") steps.push({ atMs: at, what: "nudge.skipped" });
  }
  const lastActivity = Math.max(...s.lines.map((l) => l.endMs + (l.who === "ada" ? BEE_TAG_LAG_MS : BEE_LINE_LAG_MS + opts.tagWaitMs)));
  const ended = lastActivity + opts.idleEndMs;
  steps.push({ atMs: ended, what: "conversation.ended" });
  if (wearer.reduce((n, l) => n + l.words, 0) >= 60) steps.push({ atMs: ended + 300, what: "recap.ready" });
  return steps.sort((a, b) => a.atMs - b.atMs).map((x) => ({ atMs: Math.round(x.atMs), what: x.what }));
}
