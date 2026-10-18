// A drill nobody drives is closed (review H13, M12): an Alexa session that timed out must not keep
// live nudges muted as "drill-active", and an old open card must not keep matching everyday speech.
import { describe, expect, it } from "vitest";
import type { HubEvent } from "../src/hub/core.js";
import { demoSetup } from "../src/hub/setup.js";

describe("idle drill expiry", () => {
  it("ends an idle session and closes a lone idle card; a busy one stays", () => {
    const { hub } = demoSetup({ pace: 0.01, stateDir: null });
    const topics: string[] = [];
    hub.on("event", (e: HubEvent) => topics.push(e.topic));
    hub.startSession({ by: "alexa" });
    expect(hub.drillActive()).toBe(true);
    expect(hub.expireIdle(60_000)).toBe(false); // just started
    expect(hub.expireIdle(0)).toBe(true);
    expect(hub.session).toBeNull();
    expect(topics.at(-1)).toBe("session.ended");
    expect(hub.drillActive(0)).toBe(false);
    hub.openCard({ by: "tv" });
    expect(hub.open).not.toBeNull();
    expect(hub.expireIdle(0)).toBe(true);
    expect(hub.open).toBeNull();
    expect(hub.expireIdle(0)).toBe(false); // nothing left to close
    hub.dispose();
  });
  it("hub.state identifies the hub process", () => {
    const a = demoSetup({ pace: 0.01, stateDir: null }).hub;
    const b = demoSetup({ pace: 0.01, stateDir: null }).hub;
    expect(a.bootId).toMatch(/^boot_/);
    expect(a.bootId).not.toBe(b.bootId);
    expect(a.lastSeq).toBe(0);
    a.startSession({ by: "tv" });
    expect(a.lastSeq).toBeGreaterThan(0);
    a.dispose();
    b.dispose();
  });
});
