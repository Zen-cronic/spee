// Contract test: every fixture (and, with BEE_SOURCE=cli, real `bee` CLI output) must match the
// zod schemas derived from bee-cli @84a6e8f.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationGetResponseSchema, JournalListResponseSchema } from "../src/bee/schemas.js";
import { CliBeeSource } from "../src/bee/source.js";
import { buildWorld } from "../src/sim/world.js";
import { loadRealCorpus } from "../src/real/corpus.js";

describe("bee contract: fixtures on disk", () => {
  for (const v of ["verbatim", "cleaned"]) {
    const dir = join("fixtures", v, "conversations");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    it(`${v}: has conversation fixtures`, () => expect(files.length).toBeGreaterThan(0));
    for (const f of files)
      it(`${v}/conversations/${f} matches ConversationGetResponse`, () => {
        const r = ConversationGetResponseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
        expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
      });
    it(`${v}/journals.json matches JournalListResponse`, () => {
      const r = JournalListResponseSchema.safeParse(JSON.parse(readFileSync(join("fixtures", v, "journals.json"), "utf8")));
      expect(r.success).toBe(true);
    });
  }
});

describe("bee contract: generator output (independent of the last poc run)", () => {
  const w = buildWorld({ en: { lang: "en", drilled: ["EN_HEDGE_STACK"], control: ["EN_RUN_ON"] }, fr: { lang: "fr", drilled: ["FR_GENDER"], control: ["FR_AUX_ETRE_AVOIR"] } });
  it("every conversation and journal validates", () => {
    for (const v of ["verbatim", "cleaned"] as const) {
      for (const c of w.conversations[v]) expect(ConversationGetResponseSchema.safeParse(c).success).toBe(true);
      expect(JournalListResponseSchema.safeParse({ journals: w.journals[v] }).success).toBe(true);
    }
  });
  it("timestamps follow real-device semantics: start/end seconds, spoken_at epoch ms in Oct 2026", () => {
    for (const c of w.conversations.verbatim)
      for (const u of c.conversation.transcriptions[0]!.utterances) {
        expect(u.start!).toBeLessThan(3600);
        expect(u.end!).toBeGreaterThanOrEqual(u.start!);
        expect(new Date(u.spoken_at!).toISOString().slice(0, 7)).toBe("2026-10");
        expect(u.speaker).toBe("Unknown");
      }
  });
});

describe.runIf(process.env.BEE_SOURCE === "cli")("bee contract: LIVE bee CLI output", () => {
  it("conversations and voice notes from the real CLI validate", async () => {
    const src = new CliBeeSource();
    const list = await src.conversations(Date.now() - 7 * 86_400_000);
    for (const s of list.slice(0, 5)) expect(await src.conversation(s.id)).not.toBeNull();
    await src.voiceNotes(0);
  }, 120_000);
  it("profile parses; journals list (and get, when any exist) validate", async () => {
    const src = new CliBeeSource();
    const me = await src.me();
    expect(typeof me.first_name).toBe("string");
    const all = await src.journalsAll();
    if (all.length) expect(await src.journal(all.at(-1)!.id)).not.toBeNull();
  }, 120_000);
  it("completed conversations label the wearer by profile name (labels and counts only)", async () => {
    const src = new CliBeeSource();
    const { corpus } = await loadRealCorpus(src, { sinceMs: Date.now() - 14 * 86_400_000, includeVoiceNotes: false });
    expect(corpus.wearer.method).toBe("profile-name");
    expect(corpus.sessions.some((s) => !s.skipped && s.wearerLines > 0)).toBe(true);
  }, 180_000);
});
