import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Item } from "../src/analyze/extract.js";
import { leitner, registerSplit } from "../src/coach/coach.js";

const item = (type: string, session: string, startMs: number, uid = `u:${session}${type}`): Item => ({
  utterance_id: uid, error_type: type, excerpt: "x", correction: "y", resay_prompt: "z", explanation: "e",
  session_id: session, session_kind: "voice_note", lang: "en", startMs, citation_valid: true, excerpt_grounded: true,
});
const pre = ["A", "B", "C", "D"].flatMap((t) => [item(t, "s1", 1), item(t, "s2", 2)]).concat([item("E", "s1", 1)]);

describe("pre-registered split", () => {
  it("splits only recurring types (>=2 sessions), 50/50, deterministically", () => {
    const d1 = mkdtempSync(join(tmpdir(), "prereg-"));
    const d2 = mkdtempSync(join(tmpdir(), "prereg-"));
    const a = registerSplit("en", pre, 10, d1).prereg;
    const b = registerSplit("en", pre, 10, d2).prereg;
    expect(a.drilled.length + a.control.length).toBe(4);
    expect(a.drilled.length).toBe(2);
    expect(a.drilled).toEqual(b.drilled);
    expect([...a.drilled, ...a.control]).not.toContain("E");
  });
  it("reuses the file on identical evidence and refuses to re-split on changed evidence", () => {
    const d = mkdtempSync(join(tmpdir(), "prereg-"));
    registerSplit("en", pre, 10, d);
    expect(registerSplit("en", pre, 10, d).reused).toBe(true);
    expect(() => registerSplit("en", [...pre, item("E", "s2", 2)], 10, d)).toThrow(/Refusing to re-split/);
  });
});

describe("leitner", () => {
  it("promotes on review and demotes to box 1 when the error recurs in a later recording", () => {
    const start = Date.UTC(2026, 9, 7, 4);
    const card = { id: "c", lang: "en" as const, error_type: "A", source_utterance: "u", said: "", fix: "", resay: "", why: "" };
    const ev = leitner([card], [item("A", "post", start + 3 * 86_400_000 + 3_600_000)], start, start + 10 * 86_400_000);
    expect(ev[0]).toMatchObject({ event: "review", box: 2 });
    expect(ev.find((e) => e.event === "relapse")).toMatchObject({ day: "2026-10-10", box: 1 });
  });
});
