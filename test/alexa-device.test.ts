// Which Alexa surfaces reached the skill (src/alexa/device.ts): the interfaces, the APL version and
// the viewport, logged once per kind of device as `alexa.device`, with no ids and no user data.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { deviceRecorder, deviceSurface } from "../src/alexa/device.js";
import { createAlexaPlugin } from "../src/alexa/plugin.js";
import type { AlexaRequestEnvelope } from "../src/alexa/types.js";
import type { PluginCtx } from "../src/hub/plugin.js";

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const FIRE_TV = {
  device: { deviceId: "amzn1.ask.device.SECRET-DEVICE", supportedInterfaces: { "Alexa.Presentation.APL": { runtime: { maxVersion: "2024.2" } }, AudioPlayer: {} } },
  viewport: { mode: "TV", shape: "RECTANGLE", pixelWidth: 1920, pixelHeight: 1080, dpi: 320 },
};

function env(over: { device?: unknown; viewport?: unknown } = {}): AlexaRequestEnvelope {
  const e = JSON.parse(read("alexa/fixtures/help.json")).request as AlexaRequestEnvelope;
  e.request.timestamp = new Date().toISOString();
  if (over.device) e.context!.System!.device = structuredClone(over.device) as never;
  if (over.viewport) e.context!.Viewport = structuredClone(over.viewport) as never;
  return e;
}

describe("deviceSurface", () => {
  it("a Fire TV: its interfaces, APL version and viewport", () => {
    expect(deviceSurface(env(FIRE_TV))).toEqual({ interfaces: ["Alexa.Presentation.APL", "AudioPlayer"], apl: "2024.2", viewport: "TV 1920x1080 RECTANGLE" });
  });
  it("a voice-only device: no interfaces, no APL, no viewport", () => {
    expect(deviceSurface(env())).toEqual({ interfaces: [], apl: null, viewport: null });
  });
  it("a character display (APLT) is not APL", () => {
    expect(deviceSurface(env({ device: { supportedInterfaces: { "Alexa.Presentation.APLT": { runtime: { maxVersion: "1.0" } } } } }))).toEqual({ interfaces: ["Alexa.Presentation.APLT"], apl: null, viewport: null });
  });
  it("drops odd values instead of logging them", () => {
    const d = deviceSurface(
      env({
        device: { supportedInterfaces: { "Alexa.Presentation.APL": { runtime: { maxVersion: "<script>" } }, "a b c": {}, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`X${i}`, {}])) } },
        viewport: { mode: "tv; drop", pixelWidth: -1, pixelHeight: 1080 },
      }),
    );
    expect(d.apl).toBeNull();
    expect(d.viewport).toBeNull();
    expect(d.interfaces).not.toContain("a b c");
    expect(d.interfaces.length).toBeLessThanOrEqual(12);
  });
  it("never carries the device id, the user id or the access token", () => {
    const text = JSON.stringify(deviceSurface(env(FIRE_TV)));
    for (const secret of ["SECRET-DEVICE", "amzn1.ask.account", "DEMO.ACCESS.TOKEN"]) expect(text).not.toContain(secret);
  });
});

describe("deviceRecorder", () => {
  it("reports each kind of device once", () => {
    const seen = deviceRecorder();
    expect(seen(env(FIRE_TV))).not.toBeNull();
    expect(seen(env(FIRE_TV))).toBeNull();
    expect(seen(env())).toEqual({ interfaces: [], apl: null, viewport: null });
    expect(seen(env())).toBeNull();
  });
  it("stops after its cap", () => {
    const seen = deviceRecorder(1);
    expect(seen(env())).not.toBeNull();
    expect(seen(env(FIRE_TV))).toBeNull();
  });
});

describe("the alexa plugin logs alexa.device once per kind of device", () => {
  function ctx(logs: { event: string; data?: Record<string, unknown> }[]): PluginCtx {
    return {
      log: (event: string, data?: Record<string, unknown>) => void logs.push({ event, data }),
      isPublic: () => false,
      selfUrl: () => "http://127.0.0.1:1",
      json: (res: ServerResponse, status: number) => void (res.statusCode = status),
    } as unknown as PluginCtx;
  }
  async function post(plugin: ReturnType<typeof createAlexaPlugin>, c: PluginCtx, body: unknown) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: {} }) as unknown as IncomingMessage;
    const res = { statusCode: 0 } as ServerResponse;
    await plugin.route!(req, res, new URL("http://127.0.0.1/alexa"), c);
    return res.statusCode;
  }
  it("after the request checks pass, without ids", async () => {
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const plugin = createAlexaPlugin({ skillId: SKILL, verifySignature: false });
    const c = ctx(logs);
    expect(await post(plugin, c, env(FIRE_TV))).toBe(200);
    expect(await post(plugin, c, env(FIRE_TV))).toBe(200);
    expect(await post(plugin, c, { ...env(FIRE_TV), request: { ...env().request, timestamp: "2001-01-01T00:00:00Z" } })).toBe(400);
    const lines = logs.filter((l) => l.event === "alexa.device");
    expect(lines).toEqual([{ event: "alexa.device", data: { interfaces: ["Alexa.Presentation.APL", "AudioPlayer"], apl: "2024.2", viewport: "TV 1920x1080 RECTANGLE" } }]);
    expect(JSON.stringify(logs)).not.toContain("SECRET-DEVICE");
  });
});
