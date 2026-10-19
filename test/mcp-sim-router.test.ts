// The simulator's keyword router (the stand-in for Alexa+'s model) and its two-turn dialog, against
// a scripted MCP tool caller (packet C, web/sim/src/router.ts and dialog.ts). Pure: no browser.
import { describe, expect, it } from "vitest";
import { Dialog, type ToolReply } from "../web/sim/src/dialog.js";
import { HELP_TEXT, normalize, route, type DrillState } from "../web/sim/src/router.js";
import { classifyUtterance } from "../src/alexa/route.js";
import { MCP_TOOLS, type McpToolName } from "../src/hub/contract.js";

const idle: DrillState = { cardOpen: false, attemptId: null };
const open: DrillState = { cardOpen: true, attemptId: null };
const waiting: DrillState = { cardOpen: true, attemptId: "att_1" };
const toolOf = (text: string, s: DrillState) => {
  const r = route(text, s);
  return r.kind === "tool" ? [r.tool, r.args] : [r.kind, r.rule];
};

describe("router", () => {
  it.each<[string, DrillState, McpToolName, Record<string, unknown>]>([
    ["Quiz me", idle, "start_drill", {}],
    ["Alexa, start a drill", idle, "start_drill", {}],
    ["How did I do?", waiting, "get_verdict", { attempt_id: "att_1" }],
    ["how did I do", open, "drill_status", {}],
    ["How am I doing?", open, "how_am_i_doing", {}],
    ["next", open, "next_card", {}],
    ["stop", open, "end_drill", {}],
    ["did it transfer?", idle, "did_it_transfer", {}],
    ["Turn on live coaching", idle, "live_coach", { enabled: true }],
    ["turn on live coaching for 30 minutes", idle, "live_coach", { enabled: true, minutes: 30 }],
    ["start live coaching for an hour", idle, "live_coach", { enabled: true, minutes: 60 }],
    ["turn off live coaching", open, "live_coach", { enabled: false }],
    ["show my habits", idle, "habit_stats", { range: "week" }],
    ["give me my brief", idle, "pre_meeting_brief", {}],
    ["last recap", idle, "last_recap", {}],
    ["what's my card", open, "drill_status", {}],
  ])("%s -> %s", (text, state, tool, args) => {
    expect(toolOf(text, state)).toEqual([tool, args]);
  });
  it("while a card is open, anything else is the attempt, verbatim (even with command words inside)", () => {
    expect(toolOf("The next release ships on Friday.", open)).toEqual(["submit_attempt", { text: "The next release ships on Friday." }]);
    expect(toolOf("We stop the export at noon", waiting)).toEqual(["submit_attempt", { text: "We stop the export at noon" }]);
  });
  it("a sentence run into 'how did I do' submits the sentence alone", () => {
    expect(toolOf("The report is ready for review. How did I do?", open)).toEqual(["submit_attempt", { text: "The report is ready for review" }]);
    expect(toolOf("The export shipped on Monday. What's the verdict on that?", open)).toEqual(["submit_attempt", { text: "The export shipped on Monday" }]);
    expect(toolOf("The export shipped on Monday. Did that pass this time?", open)).toEqual(["submit_attempt", { text: "The export shipped on Monday" }]);
  });
  it("routes every utterance the way the Alexa skill does", () => {
    const intentTool: Record<string, string> = { HowDidIDoIntent: "get_verdict", HowAmIDoingIntent: "how_am_i_doing", LiveCoachOnIntent: "live_coach", LiveCoachOffIntent: "live_coach", DidItTransferIntent: "did_it_transfer", "AMAZON.NextIntent": "next_card", "AMAZON.StopIntent": "end_drill", StartDrillIntent: "start_drill", AttemptIntent: "submit_attempt" };
    for (const u of ["verdict", "did that pass", "skip that", "go on", "that's all", "stop drilling", "how am i going", "quiz me", "turn on live coaching for half an hour", "The deploy finished this morning."]) {
      const c = classifyUtterance(u);
      const r = route(u, waiting);
      expect(r.kind === "tool" ? r.tool : r.kind, u).toBe(intentTool[c.intent]);
    }
  });
  it("with no card open, an unknown utterance gets help, not an attempt", () => {
    expect(toolOf("the report is ready", idle)).toEqual(["help", "no card open"]);
    expect(toolOf("   ", open)).toEqual(["help", "empty"]);
    expect(toolOf("what can I say", open)).toEqual(["help", "help"]);
  });
  it("every routed tool is an MCP tool", () => {
    const names = new Set<string>(MCP_TOOLS.map((t) => t.name));
    for (const t of ["quiz me", "how did i do", "how am i doing", "next", "stop", "did it transfer", "turn on live coaching", "stats", "brief", "recap", "status", "anything"]) {
      for (const s of [idle, open, waiting]) {
        const r = route(t, s);
        if (r.kind === "tool") expect(names.has(r.tool), `${t} -> ${r.tool}`).toBe(true);
      }
    }
  });
  it("normalize and minutes", () => {
    expect(normalize("Okay, so: HOW did I do?!")).toBe("how did i do");
    const minutes = (t: string) => (route(t, idle) as { args: { minutes?: number } }).args.minutes;
    expect(minutes("turn on live coaching for 45 minutes")).toBe(45);
    expect(minutes("turn on live coaching for two hours")).toBe(120);
    expect(minutes("turn on live coaching for half an hour")).toBe(30);
    expect(minutes("turn on live coaching for 999 minutes")).toBe(180);
    expect(minutes("turn on live coaching")).toBeUndefined();
  });
});

// A scripted hub behind the MCP tool calls: the first verdict is pending, the second is a pass.
function scripted() {
  const calls: [McpToolName, Record<string, unknown>][] = [];
  let verdicts = 0;
  const cards = ["The report is ready for review.", "We moved the meeting to Thursday."];
  let card = 0;
  const reply = (text: string, structured: Record<string, any>, isError = false): ToolReply => ({ text, structured, isError });
  const call = async (name: McpToolName, args: Record<string, unknown>): Promise<ToolReply> => {
    calls.push([name, args]);
    switch (name) {
      case "start_drill":
        return reply(`Say this: "${cards[0]}"`, { session: { id: "ses_1" }, card: { id: "c0", resay: cards[0] }, narration: "" });
      case "submit_attempt":
        return reply("Got it. I'm checking with Bee, which takes 5 to 20 seconds. Ask me how you did in a moment.", { attempt: { id: "att_9", status: "pending_bee" } });
      case "get_verdict":
        verdicts++;
        return verdicts === 1
          ? reply("Bee hasn't sent that line yet. Ask me again in a few seconds.", { verdictReady: false, status: "pending_bee", attempt: { id: "att_9" } })
          : verdicts === 2
            ? reply("Bee heard it. That's a pass.", { verdictReady: true, status: "graded", attempt: { id: "att_9", final: { pass: true } } })
            : reply('Bee heard it. Not yet: 1 filler ("um"); allowed 0.', { verdictReady: true, status: "graded", attempt: { id: "att_9", final: { pass: false } } });
      case "next_card":
        card++;
        return reply(`Say this: "${cards[card]}"`, { card: { id: `c${card}`, resay: cards[card] }, done: false, narration: "" });
      case "end_drill":
        return reply("Drill ended: 1 of 2 Bee-graded attempts passed.", { summary: { passed: 1, counted: 2 } });
      case "how_am_i_doing":
        return reply("Your last conversation ran high on hedges.", { synthetic: true, dataLabel: "SYNTHETIC DEMO DATA", narration: "" });
      default:
        return reply("", { error: "nope", message: "nope" }, true);
    }
  };
  return { call, calls };
}

describe("dialog: the same two-turn drill as the Alexa skill", () => {
  it("quiz me -> attempt (checking with Bee) -> early how did I do -> verdict -> next card", async () => {
    const h = scripted();
    const d = new Dialog(h.call);
    const t1 = await d.handle("quiz me");
    expect(t1.card).toBe("The report is ready for review.");
    expect(d.state).toEqual({ cardOpen: true, attemptId: null });
    const t2 = await d.handle("The report is ready for review.");
    expect(t2.calls).toEqual(["submit_attempt"]);
    expect(t2.speech).toMatch(/checking with Bee/);
    expect(d.state.attemptId).toBe("att_9");
    const t3 = await d.handle("how did I do?");
    expect(t3.speech).toBe("Bee hasn't sent that line yet. Ask me again in a few seconds.");
    expect(d.state.attemptId).toBe("att_9");
    const t4 = await d.handle("how did I do?");
    expect(t4.calls).toEqual(["get_verdict", "next_card"]);
    expect(t4.speech).toBe('Bee heard it. That\'s a pass. Next, say: "We moved the meeting to Thursday."');
    expect(t4.card).toBe("We moved the meeting to Thursday.");
    expect(d.state).toEqual({ cardOpen: true, attemptId: null });
    expect(h.calls.filter(([n]) => n === "get_verdict").map(([, a]) => a)).toEqual([{ attempt_id: "att_9" }, { attempt_id: "att_9" }]);
  });
  it("a fail asks for the same card again; stop ends the drill; labels surface", async () => {
    const h = scripted();
    const d = new Dialog(h.call);
    await d.handle("quiz me");
    await d.handle("The report is ready for review.");
    await d.handle("how did I do");
    await d.handle("how did I do");
    await d.handle("We moved the meeting to Thursday.");
    const fail = await d.handle("how did I do");
    expect(fail.speech).toBe('Bee heard it. Not yet: 1 filler ("um"); allowed 0. Say it again: "We moved the meeting to Thursday."');
    const how = await d.handle("how am I doing");
    expect(how.dataLabel).toBe("SYNTHETIC DEMO DATA");
    const stop = await d.handle("stop");
    expect(stop.speech).toMatch(/^Drill ended/);
    expect(stop.card).toBeNull();
    expect(d.state.cardOpen).toBe(false);
  });
  it("help when nothing is open; the card again when one is", async () => {
    const d = new Dialog(scripted().call);
    expect((await d.handle("hello there")).speech).toBe(HELP_TEXT);
    await d.handle("quiz me");
    expect((await d.handle("help")).speech).toBe('Say: "The report is ready for review."');
  });
});
