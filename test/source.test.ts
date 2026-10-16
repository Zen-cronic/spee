import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSource, MockBeeSource, pickUtterances } from "../src/bee/source.js";

function conv(id: number, words: number, speaker = "SPEAKER_1") {
  const text = Array.from({ length: words }, (_, i) => `w${i}`).join(" ");
  const u = (uid: number, t: string, realtime: boolean) => ({ id: uid, realtime, start: 0, end: 5, spoken_at: 1_791_000_000_000, text: t, speaker, created_at: 1_791_000_000_000 });
  return {
    conversation: {
      id, start_time: 1_791_000_000_000 + id, end_time: null, device_type: "unknown", summary: null, short_summary: null, state: "COMPLETED",
      created_at: 1, updated_at: 1,
      transcriptions: [
        { id: 1, realtime: true, utterances: [u(1, "realtime draft", true)] },
        { id: 2, realtime: false, utterances: [u(2, text, false)] },
      ],
      suggested_links: [], primary_location: null,
    },
    timezone: "America/Toronto",
  };
}

describe("MockBeeSource", () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-mock-"));
  mkdirSync(join(dir, "conversations"));
  writeFileSync(join(dir, "conversations", "1.json"), JSON.stringify(conv(1, 60)));
  writeFileSync(join(dir, "conversations", "2.json"), JSON.stringify(conv(2, 49)));
  writeFileSync(join(dir, "journals.json"), JSON.stringify({ journals: [{ id: "j1", text: "Hello there.", state: "READY", created_at: 5, updated_at: 6 }] }));
  const src = new MockBeeSource(dir);

  it("deletes conversations under 50 words (Bee noise rule)", async () => {
    expect(src.deleted).toEqual([2]);
    expect((await src.conversations(0)).map((c) => c.id)).toEqual([1]);
  });
  it("forces every speaker to Unknown (bee-cli issue 19)", async () => {
    const c = (await src.conversation(1))!;
    expect(c.transcriptions.flatMap((t) => t.utterances).every((u) => u.speaker === "Unknown")).toBe(true);
  });
  it("prefers the non-realtime transcription like bee-cli pickTranscription", async () => {
    expect(pickUtterances((await src.conversation(1))!)[0]!.id).toBe(2);
  });
  it("returns voice notes", async () => expect((await src.voiceNotes(0)).map((j) => j.id)).toEqual(["j1"]));
  it("BEE_SOURCE selects the implementation", () => {
    process.env.BEE_SOURCE = "cli";
    expect(makeSource().kind).toBe("cli");
    process.env.BEE_SOURCE = "nope";
    expect(() => makeSource()).toThrow();
    delete process.env.BEE_SOURCE;
  });
});
