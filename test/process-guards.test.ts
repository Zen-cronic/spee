// Process guards (src/hub/processGuards.ts): stray rejections and exceptions are logged and the hub
// keeps running; a burst means a wedged process, which exits; tracked children are killed.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installProcessGuards, killChildren, liveChildren, MAX_UNCAUGHT, trackChild } from "../src/hub/processGuards.js";

describe("process guards", () => {
  it("logs an unhandled rejection and an uncaught exception without exiting", () => {
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const exits: number[] = [];
    const off = installProcessGuards((event, data) => logs.push({ event, data }), { exit: (c) => exits.push(c) });
    try {
      process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
      process.emit("uncaughtException", new TypeError("s.trim is not a function"));
      expect(logs.map((l) => l.event)).toEqual(["process.unhandled-rejection", "process.uncaught-exception"]);
      expect(logs[1]!.data).toEqual({ name: "TypeError", error: "s.trim is not a function" });
      expect(exits).toEqual([]);
    } finally {
      off();
    }
  });
  it("exits after a burst of uncaught exceptions", () => {
    const exits: number[] = [];
    let t = 0;
    const off = installProcessGuards(() => {}, { exit: (c) => exits.push(c), now: () => t });
    try {
      for (let i = 0; i <= MAX_UNCAUGHT; i++) (t += 10, process.emit("uncaughtException", new Error(`e${i}`)));
      expect(exits).toEqual([1]);
    } finally {
      off();
    }
  });
  it("kills tracked children", async () => {
    const c = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
    expect(liveChildren()).toBeGreaterThanOrEqual(1);
    const exited = new Promise<string | null>((r) => c.once("exit", (_code, sig) => r(sig)));
    killChildren();
    expect(await exited).toBe("SIGTERM");
  });
});
