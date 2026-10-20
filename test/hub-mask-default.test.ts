// A hub started from code (as every test does) never reads the machine's coach/*.local.txt: masking
// is off unless the caller passes terms or a dir. Only the CLI entry loads the operator's files.
import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ dirs: [] as string[] }));
vi.mock("../src/hub/mask.js", async (orig) => {
  const m = await orig<typeof import("../src/hub/mask.js")>();
  return { ...m, loadMaskTerms: (dir: string) => (loaded.dirs.push(dir), m.loadMaskTerms(dir)) };
});

const { startHubServer } = await import("../src/hub/server.js");
const { demoSetup } = await import("../src/hub/setup.js");
const { maskStatus } = await import("../src/hub/mask.js");

describe("mask terms default", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });
  it("starts with masking off and reads no terms file when no terms are given", async () => {
    const s = await startHubServer({ port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
    close = () => s.close();
    expect(loaded.dirs).toEqual([]);
    expect(maskStatus()).toBe("off");
  });
  it("uses exactly the terms it is given", async () => {
    const s = await startHubServer({ maskTerms: ["Zephyrine"], port: 0, host: "127.0.0.1", quiet: true, setup: demoSetup({ pace: 0.01, stateDir: null }), pairToken: "p".repeat(20), mcpToken: "m".repeat(20), publicBaseUrl: null });
    close = () => s.close();
    expect(loaded.dirs).toEqual([]);
    expect(maskStatus()).toBe("on (1 term)");
  });
});
