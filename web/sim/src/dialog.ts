// The simulator's turn logic: the router picks a tool, this calls it through MCP and decides what to
// say, mirroring the Alexa skill's two-turn drill (attempt -> "checking with Bee" -> "how did I do?"
// -> Bee's verdict -> next card on a pass). No DOM: the caller supplies the MCP tool call.
import type { McpToolName } from "../../../src/hub/contract.js";
import { HELP_TEXT, route, type DrillState, type Routed } from "./router.js";

export interface ToolReply {
  text: string;
  structured: Record<string, any> | null;
  isError: boolean;
}
export type CallTool = (name: McpToolName, args: Record<string, unknown>) => Promise<ToolReply>;

export interface Turn {
  heard: string;
  routed: Routed;
  calls: McpToolName[];
  speech: string;
  card: string | null; // the sentence to say now, if a card is open
  dataLabel: string | null;
}

export class Dialog {
  state: DrillState = { cardOpen: false, attemptId: null };
  card: string | null = null;

  constructor(private readonly call: CallTool) {}

  private take(r: ToolReply) {
    const s = r.structured;
    if (!s || r.isError) return;
    if ("card" in s && "session" in s) this.setCard(s.card);
    else if ("card" in s && "done" in s) this.setCard(s.done ? null : s.card);
    else if ("summary" in s && !("card" in s)) this.setCard(null);
    else if ("openCard" in s) this.setCard(s.openCard);
  }
  private setCard(c: { resay?: string } | null | undefined) {
    this.card = c?.resay ?? null;
    this.state.cardOpen = !!c;
  }

  async handle(heard: string): Promise<Turn> {
    const routed = route(heard, this.state);
    const calls: McpToolName[] = [];
    let label: string | null = null;
    const call = async (name: McpToolName, args: Record<string, unknown>) => {
      calls.push(name);
      const r = await this.call(name, args);
      if (r.structured?.synthetic === true && typeof r.structured.dataLabel === "string") label = r.structured.dataLabel;
      return r;
    };
    const done = (speech: string): Turn => ({ heard, routed, calls, speech, card: this.card, dataLabel: label });
    if (routed.kind === "help") return done(this.state.cardOpen && this.card ? `Say: "${this.card}"` : HELP_TEXT);

    const r = await call(routed.tool, routed.args);
    this.take(r);
    if (r.isError) {
      if (routed.tool === "get_verdict") this.state.attemptId = null;
      return done(r.structured?.error === "no_open_card" ? 'No card is open. Say "quiz me" to start a drill.' : r.text);
    }
    switch (routed.tool) {
      case "submit_attempt":
        this.state.attemptId = r.structured?.attempt?.id ?? null;
        return done(r.text);
      case "get_verdict": {
        const v = r.structured!;
        if (!v.verdictReady) return done(r.text);
        this.state.attemptId = null;
        if (v.status === "graded" && v.attempt?.final?.pass) {
          const n = await call("next_card", {});
          this.take(n);
          return done(`${r.text} ${n.structured?.done ? n.text : this.card ? `Next, say: "${this.card}"` : n.text}`);
        }
        return done(this.card ? `${r.text} Say it again: "${this.card}"` : r.text);
      }
      case "end_drill":
        this.state.attemptId = null;
        return done(r.text);
      default:
        return done(r.text);
    }
  }
}
