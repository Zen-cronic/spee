// Contract-check module for the mcp plugin, run against the shared demo hub (pace 0.02)
// with the MCP SDK client over Streamable HTTP:
//   - tools/list = MCP_TOOLS; public /mcp needs the bearer token;
//   - plan Verification item 1: MCP start_drill -> TV card.open -> phone attempt over the bridge ->
//     Bee replay -> graded, and get_verdict returns Bee's grade;
//   - submit_attempt -> get_verdict (pending, then graded); errors come back as isError.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOLS } from "../../src/hub/contract.js";
import type { CheckCtx, CheckResult, Ev } from "./types.js";

type Res = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, any>; isError?: boolean };

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  const notes: string[] = [];
  const waitList = async <T>(list: () => T[], pred: (e: T) => boolean, ms = 5000): Promise<T | null> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const e = list().find(pred);
      if (e) return e;
      await ctx.sleep(20);
    }
    return null;
  };
  const tvFrom = (i: number, pred: (e: Ev) => boolean) => waitList(() => ctx.tv.events.slice(i), pred);

  const client = new Client({ name: "contract-check", version: "2" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
  const text = (r: Res) => r.content?.find((c) => c.type === "text")?.text ?? "";

  try {
    const tools = await client.listTools();
    ctx.check(JSON.stringify(tools.tools.map((t) => t.name)) === JSON.stringify(MCP_TOOLS.map((t) => t.name)), `tools/list = MCP_TOOLS (${tools.tools.length} tools, in order)`);

    // Gate: public /mcp
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const pub = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" };
    const noTok = await ctx.raw("/mcp", { method: "POST", headers: pub, body });
    const withTok = await ctx.raw("/mcp", { method: "POST", headers: { ...pub, authorization: `Bearer ${ctx.tokens.mcp}` }, body });
    ctx.check(noTok.status === 403 && withTok.status === 200 && JSON.parse(withTok.text).result?.tools?.length === MCP_TOOLS.length && !withTok.text.includes(ctx.tokens.mcp), "public /mcp: 403 without the bearer token, tools/list with it (token never echoed)");
    ctx.check((await ctx.raw("/mcp")).status === 405, "GET /mcp -> 405 (stateless)");

    // Item 1: start_drill -> TV card.open -> phone attempt -> Bee replay -> graded
    await ctx.post("/api/session/end", {});
    let tvAt = ctx.tv.events.length;
    const start = await call("start_drill", { size: 3 });
    let card = start.structuredContent?.card;
    if (card) {
      const open = await tvFrom(tvAt, (e) => e.topic === "card.open" && e.payload.card?.id === card.id);
      ctx.check(!start.isError && open?.payload.by === "mcp" && text(start) === `Say this: "${card.resay}"`, "MCP start_drill -> the TV gets card.open for the same card; narration says the card");
    } else {
      // An earlier module drilled every due card: start_drill must say so, not fail; the flow goes
      // on with a practice card.
      ctx.check(!start.isError && start.structuredContent?.card === null && text(start).length > 0, "MCP start_drill with nothing due answers (no card) instead of failing");
      const any = (await ctx.get("/api/deck")).body.cards?.[0];
      card = any ? (await ctx.post("/api/card/open", { cardId: any.id, by: "mcp" })).body.card : null;
      notes.push("no card was due at start_drill: the phone attempt used a practice card");
    }
    if (!card) return { name: "mcp", ...ctx.counts(), note: "no card could be opened" };

    await ctx.post("/api/demo/scenario", { scenario: "verified" });
    tvAt = ctx.tv.events.length;
    const intentsAt = ctx.phone.intents.length;
    ctx.phone.ws.send(JSON.stringify({ type: "transcript.final", utteranceId: "u_mcp_1", text: card.resay, hops: [{ hop: "speech.end", at: ctx.phone.hubNow() }, { hop: "mic.send", at: ctx.phone.hubNow() }] }));
    const intent = await waitList(() => ctx.phone.intents.slice(intentsAt), (m: any) => m.utteranceId === "u_mcp_1");
    const phoneAttempt = intent?.payload?.attemptId as string | undefined;
    const graded = phoneAttempt ? await tvFrom(tvAt, (e) => e.topic === "attempt.graded" && e.payload.attempt?.id === phoneAttempt) : null;
    ctx.check(!!phoneAttempt && graded?.payload.attempt.counted === true && graded.payload.attempt.bee?.replay === true, "phone attempt over the bridge -> Bee replay -> attempt.graded on the TV");
    const v1 = phoneAttempt ? await call("get_verdict", { attempt_id: phoneAttempt }) : null;
    ctx.check(!!v1 && !v1.isError && v1.structuredContent?.verdictReady === true && v1.structuredContent.status === "graded" && v1.structuredContent.attempt.final.source === "bee" && text(v1) === v1.structuredContent.narration, "MCP get_verdict on the phone's attempt returns Bee's final grade and its narration");

    // submit_attempt -> get_verdict (pending, then graded). card_id opens a card for practice even
    // when none is due any more.
    const nxt = await call("next_card");
    const card2 = nxt.structuredContent?.card ?? (await ctx.get("/api/deck")).body.cards?.find((c: { id: string }) => c.id !== card.id);
    if (card2) {
      await ctx.post("/api/demo/scenario", { scenario: "merged" });
      const t0 = Date.now();
      const sub = await call("submit_attempt", { text: card2.resay, card_id: card2.id });
      const id = sub.structuredContent?.attempt?.id as string | undefined;
      ctx.check(!sub.isError && Date.now() - t0 < 1000 && sub.structuredContent?.attempt.status === "pending_bee" && sub.structuredContent.attempt.provisional.source === "mcp" && /checking with Bee/.test(text(sub)), "MCP submit_attempt returns pending_bee at once (source mcp) with the checking-with-Bee narration");
      const pending = await call("get_verdict", { attempt_id: id });
      ctx.check(pending.structuredContent?.verdictReady === false && typeof pending.structuredContent.retryAfterMs === "number", "an early get_verdict is not ready and says when to ask again");
      let v: Res = pending;
      const t1 = Date.now();
      while (!v.structuredContent?.verdictReady && Date.now() - t1 < 5000) {
        await ctx.sleep(50);
        v = await call("get_verdict", { attempt_id: id });
      }
      ctx.check(v.structuredContent?.status === "graded" && v.structuredContent.attempt.counted === true && !!v.structuredContent.attempt.bee.extraText, "then get_verdict returns the graded attempt (Bee's merged line, extra cut)");
    } else notes.push("no second card due: submit_attempt flow skipped");

    // Errors
    const bad = await call("get_verdict", { attempt_id: "att_nope" });
    ctx.check(bad.isError === true && bad.structuredContent?.error === "unknown_attempt", "get_verdict on an unknown id -> isError (unknown_attempt)");
    const refused = await call("did_it_transfer", { habit: "vague" });
    ctx.check(refused.isError === true && refused.structuredContent?.error === "not_preregistered", "did_it_transfer for an unregistered habit -> isError (not_preregistered, 422)");
    const sseAt = ctx.sse.length;
    const running = !!(await ctx.get("/api/session")).body.session; // next_card ends the session when nothing is due
    const end = await call("end_drill");
    const ended = running ? await waitList(() => ctx.sse.slice(sseAt), (e) => e.topic === "session.ended") : true;
    ctx.check(!end.isError && /^(Practice done: |You.re not practising right now)/.test(text(end)) && !!end.structuredContent?.summary && !!ended, `end_drill -> a summary narration${running ? " and session.ended" : " (the session had already ended)"}`);

    // v2 tools (need the live engine outside fixture mode)
    const how = await call("how_am_i_doing");
    if (how.isError && how.structuredContent?.error === "not_implemented") {
      ctx.check(true, "how_am_i_doing surfaces the live stub's 501 as isError");
      notes.push("how_am_i_doing, live_coach and last_recap wait for the live engine (the live routes answer 501)");
    } else {
      ctx.check(!how.isError && text(how) === how.structuredContent?.narration, "how_am_i_doing speaks GET /api/coach/now");
      const recap = await call("last_recap");
      ctx.check(!recap.isError && Array.isArray(recap.structuredContent?.recaps), "last_recap returns GET /api/recaps?limit=1");
    }
  } finally {
    await client.close();
  }
  return { name: "mcp", ...ctx.counts(), ...(notes.length ? { note: notes.join("; ") } : {}) };
}
