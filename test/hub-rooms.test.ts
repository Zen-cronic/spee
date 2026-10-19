// Room lifetime: the bridge alone closes a room whose TV left (after the grace period) and the hub
// drops that room's relay state in onRoomClose. A phone that comes back with the old code is told
// the room is gone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHubServer, type HubServer } from "../src/hub/server.js";
import { demoSetup } from "../src/hub/setup.js";

let s: HubServer;
beforeAll(async () => {
  s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null, roomGraceMs: 100 });
});
afterAll(async () => s.close());

function hello(frame: Record<string, unknown>): Promise<{ ws: WebSocket; first: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, ...frame })));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "welcome" || m.type === "error") resolve({ ws, first: m });
    });
    ws.on("error", reject);
  });
}

describe("rooms", () => {
  it("a room whose TV left is closed by the bridge after the grace period", async () => {
    const tv = await hello({ role: "screen", clientId: "tv-rooms", name: "tv" });
    expect(tv.first.type).toBe("welcome");
    const code = tv.first.code as string;
    tv.ws.close();
    await new Promise((r) => setTimeout(r, 400));
    const phone = await hello({ role: "mic", clientId: "phone-rooms", name: "phone", code });
    expect(phone.first).toMatchObject({ type: "error", code: "unknown-code" });
    phone.ws.close();
  });
});
