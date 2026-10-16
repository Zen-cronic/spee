// Contract-check module for the alexa plugin (packet C), run against the shared demo hub (pace 0.02):
//   - POST /alexa rejects a wrong skill id and a stale timestamp (400 alexa_rejected) and passes the
//     gate through a tunnel;
//   - Launch -> card.open on the TV (by alexa) -> Attempt answered < 1 s (pending_bee) -> early
//     HowDidIDo answered < 7 s with Bee's verdict (merged line, as on the real device) -> TV saw
//     attempt.verified and attempt.graded -> Stop ends the session;
//   - HowDidIDo said into the catch-all slot is rescued;
//   - HowAmIDoing speaks GET /api/coach/now and, once packet A's engine runs, reflects the recap of
//     a demo conversation (plan Verification item 3). Until then those parts report as waiting.
import { readFileSync } from "node:fs";
import { resolveSkillId } from "../../src/alexa/verify.js";
import { clip } from "../../src/alexa/speech.js";
import type { CheckCtx, CheckResult, Ev } from "./types.js";

export async function run(ctx: CheckCtx): Promise<CheckResult> {
  const skillId = resolveSkillId(process.env);
  const notes: string[] = [];
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../alexa/fixtures/${name}.json`, import.meta.url), "utf8")).request;
  const envelope = (name: string, o: { attrs?: Record<string, unknown>; slot?: string; skill?: string; ts?: number } = {}) => {
    const e = fx(name);
    const id = o.skill ?? skillId;
    e.session.application.applicationId = id;
    e.context.System.application.applicationId = id;
    delete e.context.System.apiEndpoint; // no progressive response from a check (the Alexa API is not ours to call)
    e.request.timestamp = new Date(o.ts ?? Date.now()).toISOString();
    if (o.attrs) e.session.attributes = o.attrs;
    if (o.slot !== undefined) e.request.intent.slots.attempt.value = o.slot;
    return e;
  };
  const alexa = async (body: unknown, headers: Record<string, string> = {}) => {
    const t0 = Date.now();
    const r = await ctx.raw("/alexa", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    let j: any = null;
    try {
      j = JSON.parse(r.text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: j, ms: Date.now() - t0, speech: (j?.response?.outputSpeech?.text as string | undefined) ?? "", attrs: (j?.sessionAttributes ?? {}) as Record<string, unknown> };
  };
  const tvFrom = (i: number, pred: (e: Ev) => boolean, ms = 5000) => waitList(() => ctx.tv.events.slice(i), pred, ms);
  const sseFrom = (i: number, pred: (e: Ev) => boolean, ms = 5000) => waitList(() => ctx.sse.slice(i), pred, ms);
  async function waitList(list: () => Ev[], pred: (e: Ev) => boolean, ms: number): Promise<Ev | null> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const e = list().find(pred);
      if (e) return e;
      await ctx.sleep(20);
    }
    return null;
  }

  // Request checks
  const wrong = await alexa(envelope("help", { skill: "amzn1.ask.skill.someone-else" }));
  ctx.check(wrong.status === 400 && wrong.body?.error === "alexa_rejected", "a wrong skill id -> 400 alexa_rejected");
  const stale = await alexa(envelope("help", { ts: Date.now() - 200_000 }));
  ctx.check(stale.status === 400 && stale.body?.error === "alexa_rejected" && /150 s/.test(stale.body?.message), "a timestamp 200 s old -> 400 alexa_rejected");
  const tunnel = await alexa(envelope("help"), { "x-forwarded-for": "203.0.113.9", host: "bee-coach.example.app" });
  ctx.check(tunnel.status === 200 && tunnel.body?.version === "1.0" && tunnel.speech.length > 0, "a valid request through the tunnel passes the gate and gets an Alexa envelope");

  // The two-turn drill
  await ctx.post("/api/session/end", {});
  let tvAt = ctx.tv.events.length;
  const launch = await alexa(envelope("launch"));
  const open = await tvFrom(tvAt, (e) => e.topic === "card.open" && e.payload.by === "alexa", 1500);
  let card = open?.payload.card;
  if (card) ctx.check(launch.status === 200 && launch.speech === `Speech coach. Say this: "${card.resay}"` && launch.attrs.cardId === card.id, "Launch: starts a session, speaks the card, and the TV gets card.open by alexa");
  else {
    // An earlier module drilled every due card: Launch must say so, and the drill goes on with a
    // practice card (opened over HTTP), which exercises the same two turns.
    ctx.check(launch.status === 200 && /^No cards are due/.test(launch.speech), "Launch with nothing due says so instead of failing");
    const any = (await ctx.get("/api/deck")).body.cards?.[0];
    card = any ? (await ctx.post("/api/card/open", { cardId: any.id, by: "alexa" })).body.card : null;
    launch.attrs.cardId = card?.id;
    notes.push("no card was due at Launch: drilled a practice card instead");
  }
  if (!card) return { name: "alexa", ...ctx.counts(), note: "no card could be opened; the rest of the drill was skipped" };

  await ctx.post("/api/demo/scenario", { scenario: "merged" });
  tvAt = ctx.tv.events.length;
  const att = await alexa(envelope("attempt", { attrs: launch.attrs, slot: card.resay }));
  const attemptId = att.attrs.attemptId as string | undefined;
  ctx.check(att.status === 200 && att.ms < 1000 && /^Got it, checking with Bee\./.test(att.speech) && att.body?.response?.shouldEndSession === false && !!attemptId, `Attempt answered in ${att.ms} ms (< 1 s): "checking with Bee", session kept open, attemptId kept`);
  const early = await ctx.get(`/api/attempts/${attemptId}`);
  ctx.check(early.body?.verdictReady === false && early.body?.attempt?.provisional?.source === "alexa", "right after the attempt the verdict is not ready (Alexa's text is provisional)");
  const how = await alexa(envelope("how-did-i-do", { attrs: att.attrs }));
  ctx.check(how.status === 200 && how.ms < 7000 && /^Bee heard it: a pass\./.test(how.speech), `early HowDidIDo waited for Bee and spoke the verdict in ${how.ms} ms (< 7 s): "${how.speech.slice(0, 40)}..."`);
  const verified = await tvFrom(tvAt, (e) => e.topic === "attempt.verified" && e.payload.attemptId === attemptId);
  const graded = await tvFrom(tvAt, (e) => e.topic === "attempt.graded" && e.payload.attempt?.id === attemptId);
  ctx.check(verified?.payload.status === "verified" && graded?.payload.attempt.counted === true && graded.payload.attempt.provisional.source === "alexa" && !!graded.payload.attempt.bee.extraText, "the TV saw attempt.verified then attempt.graded (Bee's merged line, extra sentence cut)");

  // Catch-all rescue on a second attempt, which Bee fails (an "um" Alexa's transcript dropped): the
  // card stays due, so the MCP check that follows still has a card to drill.
  const next = (await ctx.get("/api/session")).body.openCard;
  if (next) {
    await ctx.post("/api/demo/scenario", { scenario: "bee-hears-filler" });
    const a2 = await alexa(envelope("attempt", { attrs: how.attrs, slot: next.resay }));
    await ctx.sleep(400);
    const rescued = await alexa(envelope("how-did-i-do-in-catch-all", { attrs: a2.attrs }));
    ctx.check(rescued.speech === `Not yet: Bee heard a filler, "um". Say it again: "${next.resay}"` && rescued.body?.response?.shouldEndSession === false, `"how did I do" said into the catch-all slot is rescued; Bee overrules Alexa's clean transcript: "${rescued.speech.slice(0, 44)}..."`);
  } else notes.push("only one card was due: the catch-all rescue was not exercised");
  const sseAt = ctx.sse.length;
  const running = !!(await ctx.get("/api/session")).body.session;
  const stop = await alexa(envelope("stop", { attrs: how.attrs }));
  const ended = running ? await sseFrom(sseAt, (e) => e.topic === "session.ended") : true;
  ctx.check(stop.body?.response?.shouldEndSession === true && /Bye\.$/.test(stop.speech) && !!ended, "Stop ends the session (session.ended) and closes the skill session");

  // HowAmIDoing (needs packet A's /api/coach/now)
  const coach = await ctx.get("/api/coach/now");
  if (coach.status === 501) {
    const h = await alexa(envelope("how-am-i-doing"));
    ctx.check(h.status === 200 && h.speech === "The coach hub didn't answer. Try again in a moment.", "HowAmIDoing degrades to a short apology while /api/coach/now is a stub");
    notes.push("HowAmIDoing and live coaching wait for packet A (/api/coach/now and /api/live/mode answer 501)");
  } else {
    const demo = await ctx.post("/api/demo/live", { script: "story" });
    if (demo.status === 202) {
      const recap = await sseFrom(sseAt, (e) => e.topic === "recap.ready", 30_000);
      const now = await ctx.get("/api/coach/now");
      const h = await alexa(envelope("how-am-i-doing"));
      ctx.check(!!recap && now.body.lastRecap?.id === recap.payload.recap.id && h.speech === clip(now.body.narration, 3), "HowAmIDoing speaks /api/coach/now, which reflects the demo conversation's recap (plan item 3)");
    } else {
      const h = await alexa(envelope("how-am-i-doing"));
      ctx.check(h.speech === clip(coach.body.narration, 3), "HowAmIDoing speaks GET /api/coach/now");
      notes.push(`POST /api/demo/live answered ${demo.status}: the recap half of plan item 3 is waiting`);
    }
    const sseMode = ctx.sse.length;
    const on = await alexa(envelope("live-coach-on"));
    const mode = await sseFrom(sseMode, (e) => e.topic === "live.mode");
    ctx.check(on.status === 200 && mode?.payload.mode.enabled === true && mode.payload.mode.by === "alexa" && on.body?.response?.shouldEndSession === true, "LiveCoachOn: POST /api/live/mode by alexa -> live.mode enabled; the one-shot closes");
    await alexa(envelope("live-coach-off"));
  }
  return { name: "alexa", ...ctx.counts(), ...(notes.length ? { note: notes.join("; ") } : {}) };
}
