// Review fixes for the verifier and the hub's state files: H9 (a hung poll must not keep other
// speakers' text in memory), M8 (polls only recent conversations), M11 (a failing verdict write
// surfaces), M12 (no Bee-only attempt long after a card opened), M9 (crash-safe state files).
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEE_ONLY_MAX_AGE_MS, BeeVerifier, POLL_MAX_CONVERSATIONS, type BeeAttempt, type BeeEvent, type BeeLine, type Verification } from "../src/hub/bee.js";
import { readJsonSafe, writeJsonAtomic } from "../src/hub/atomic.js";
import { wearerRule } from "../src/hub/setup.js";

const T0 = Date.parse("2026-10-20T17:30:00Z");
const ME = { first_name: "Ada", last_name: "Demo" };
const TARGET = "The billing export is ready for review today.";
const utt = (id: number, text: string, endMs: number, uuid = "conv-1"): BeeEvent => ({ type: "new-utterance", conversation_uuid: uuid, utterance: { id, sample_id: `s${id}`, start: 10, end: 13, text, spoken_at: new Date(endMs - 3000).toISOString() } });
const tag = (id: number, name = "Ada"): BeeEvent => ({ type: "tagged-utterance", utterance_id: id, person_id: 7, person_first_name: name, speaker_score: 0.82, conversation_uuid: "conv-1" });

function rig(o: { poll?: (q: { conversationIds: number[] }) => Promise<any[]>; onVerification?: (v: Verification) => void } = {}) {
  let now = T0;
  const lines: BeeLine[] = [];
  const beeOnly: BeeAttempt[] = [];
  const v = new BeeVerifier({ clock: () => now, rule: wearerRule(ME, ""), poll: o.poll as never, onVerification: o.onVerification ?? (() => {}), onBeeAttempt: (x) => beeOnly.push(x), onLine: (l) => lines.push(l) });
  v.openCard({ cardId: "c1", resay: TARGET, lang: "en", openedAt: T0 - 2000 });
  return { v, lines, beeOnly, set: (t: number) => (now = t), now: () => now };
}

describe("verifier", () => {
  it("purges other speakers' buffered text even while a poll hangs (H9)", async () => {
    let release!: () => void;
    const hung = new Promise<any[]>((r) => (release = () => r([])));
    const r = rig({ poll: () => hung });
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.v.ingest(utt(1, "a colleague says something private here", T0));
    r.set(T0 + 31_000);
    const tick = r.v.tick(); // starts the poll, which never returns
    r.set(T0 + 200_000);
    r.v.purge(); // what the server runs on every interval, outside its tick guard
    expect((r.v as any).utts.size).toBe(0);
    release();
    await tick;
  });
  it("the fallback poll asks only the most recent conversations (M8)", async () => {
    const asked: number[][] = [];
    const r = rig({ poll: async (q) => (asked.push(q.conversationIds), []) });
    for (let i = 1; i <= 12; i++) r.v.ingest({ type: "new-conversation", conversation: { id: i, conversation_uuid: `u${i}`, start_time: T0 - 3600_000 + i, state: "CAPTURING" } } as BeeEvent);
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.set(T0 + 31_000);
    await r.v.tick();
    expect(asked[0]).toEqual([10, 11, 12]);
    expect(asked[0]!.length).toBe(POLL_MAX_CONVERSATIONS);
  });
  it("a verdict that fails to record surfaces from tick instead of hiding in the poll's catch (M11)", async () => {
    const r = rig({
      poll: async () => [{ id: 9, text: TARGET, startMs: T0 - 3000, endMs: T0 }],
      onVerification: () => {
        throw new Error("EACCES");
      },
    });
    r.v.expect({ attemptId: "a1", cardId: "c1", text: TARGET, speechStartMs: T0 - 3000, speechEndMs: T0 });
    r.set(T0 + 31_000);
    await expect(r.v.tick()).rejects.toThrow("EACCES");
  });
  it("a matching wearer line long after the card opened is not a Bee-only attempt (M12)", () => {
    const r = rig();
    const late = T0 + BEE_ONLY_MAX_AGE_MS + 60_000;
    r.set(late);
    r.v.ingest(utt(5, TARGET, late));
    r.v.ingest(tag(5));
    expect(r.beeOnly).toHaveLength(0);
    r.v.ingest(utt(6, TARGET, T0 + 5000));
    r.v.ingest(tag(6));
    expect(r.beeOnly).toHaveLength(1);
  });
});

describe("state files (M9)", () => {
  it("writes atomically, keeps a backup, and survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-atomic-"));
    try {
      const p = join(dir, "hub-attempts.json");
      writeJsonAtomic(p, { attempts: [{ id: "a1" }] });
      expect(existsSync(`${p}.tmp`)).toBe(false);
      expect(readJsonSafe(p, () => ({ attempts: [] }))).toEqual({ attempts: [{ id: "a1" }] }); // also writes the .bak
      writeFileSync(p, '{"attempts": [{"id": "a'); // a torn write
      const warnings: string[] = [];
      expect(readJsonSafe(p, () => ({ attempts: [] }), (m) => warnings.push(m))).toEqual({ attempts: [{ id: "a1" }] });
      expect(warnings[0]).toMatch(/restored .*\.bak/);
      expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
      expect(JSON.parse(readFileSync(`${p}.bak`, "utf8"))).toEqual({ attempts: [{ id: "a1" }] });
      // the backup is written back, so the next start reads the file itself, not the fallback
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ attempts: [{ id: "a1" }] });
      const later: string[] = [];
      expect(readJsonSafe(p, () => ({ attempts: [] }), (m) => later.push(m))).toEqual({ attempts: [{ id: "a1" }] });
      expect(later).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a restored file keeps the backup's mode, and a leftover tmp is replaced, never written through", () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-atomic-"));
    try {
      const p = join(dir, "tokens.json");
      writeJsonAtomic(p, { PAIR_TOKEN: "a".repeat(20) }, { mode: 0o600 });
      readJsonSafe(p, () => ({}));
      writeFileSync(p, "{nope");
      readJsonSafe(p, () => ({}), () => {});
      expect(statSync(p).mode & 0o777).toBe(0o600);
      // a stale tmp that points elsewhere (a symlink) is removed, not followed
      const elsewhere = join(dir, "elsewhere.txt");
      writeFileSync(elsewhere, "untouched", { mode: 0o644 });
      symlinkSync(elsewhere, `${p}.tmp`);
      writeJsonAtomic(p, { PAIR_TOKEN: "b".repeat(20) }, { mode: 0o600 });
      expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
      expect(statSync(elsewhere).mode & 0o777).toBe(0o644);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(p, "utf8")).PAIR_TOKEN).toBe("b".repeat(20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
