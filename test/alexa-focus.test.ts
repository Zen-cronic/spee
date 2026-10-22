// The Alexa plugin asks the TV for a view on the intents in INTENT_FOCUS: "did it transfer?" shows
// Progress, live coaching on shows Live (src/alexa/skill.ts, src/alexa/plugin.ts). Other intents
// publish nothing, and the focus never carries what was said.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAlexaPlugin } from "../src/alexa/plugin.js";
import { INTENT_FOCUS } from "../src/alexa/skill.js";
import type { PluginCtx } from "../src/hub/plugin.js";

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const fixture = (name: string) => {
  const e = JSON.parse(readFileSync(new URL(`../alexa/fixtures/${name}.json`, import.meta.url), "utf8")).request;
  e.request.timestamp = new Date().toISOString();
  if (e.session?.application) e.session.application.applicationId = SKILL;
  if (e.context?.System?.application) e.context.System.application.applicationId = SKILL;
  return e;
};

async function post(name: string) {
  const published: { topic: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: () => {},
    isPublic: () => false,
    selfUrl: () => "http://127.0.0.1:9", // no hub: the skill answers "hub down", the focus still goes out
    json: (res: ServerResponse, status: number) => void (res.statusCode = status),
    publish: (topic: string, data: Record<string, unknown>) => (published.push({ topic, data }), { topic, payload: data }),
  } as unknown as PluginCtx;
  const plugin = createAlexaPlugin({ skillId: SKILL, verifySignature: false });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(fixture(name)))]), { method: "POST", headers: {} }) as unknown as IncomingMessage;
  const res = { statusCode: 0 } as ServerResponse;
  await plugin.route!(req, res, new URL("http://127.0.0.1/alexa"), ctx);
  return { status: res.statusCode, published };
}

describe("Alexa intents that ask the TV for a view", () => {
  it("did it transfer? focuses Progress (transfer), by alexa", async () => {
    const { status, published } = await post("did-it-transfer");
    expect(status).toBe(200);
    expect(published).toEqual([{ topic: "mirror.focus", data: { view: "transfer", by: "alexa", reason: "did it transfer?", recapId: null, takeId: null } }]);
  });
  it("live coaching on focuses Live", async () => {
    const { published } = await post("live-coach-on");
    expect(published.map((p) => p.data.view)).toEqual(["live"]);
  });
  it("other intents publish no focus", async () => {
    for (const name of ["help", "how-am-i-doing", "live-coach-off"]) expect((await post(name)).published).toEqual([]);
  });
  it("only the two intents have a view", () => {
    expect(Object.keys(INTENT_FOCUS).sort()).toEqual(["DidItTransferIntent", "LiveCoachOnIntent"]);
  });
});
