// BeeSource seam: MockBeeSource (fixtures) or CliBeeSource (shells out to the `bee` CLI).
import { execFile } from "node:child_process";
import { trackChild } from "../hub/processGuards.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ConversationGetResponseSchema,
  ConversationListResponseSchema,
  JournalGetResponseSchema,
  JournalListResponseSchema,
  MeSchema,
  type Me,
  type ConversationDetail,
  type ConversationSummary,
  type Journal,
  type Utterance,
} from "./schemas.js";

export interface BeeSource {
  readonly kind: string;
  conversations(sinceMs: number): Promise<ConversationSummary[]>;
  conversation(id: number): Promise<ConversationDetail | null>;
  voiceNotes(sinceMs: number): Promise<Journal[]>;
}

export const MIN_CONVERSATION_WORDS = 50; // Bee deletes conversations under ~50 words (Amazon staff, forum)

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// Mirrors bee-cli pickTranscription: prefer the non-realtime (final) transcription.
export function pickUtterances(c: ConversationDetail): Utterance[] {
  const final = c.transcriptions.find((t) => !t.realtime) ?? c.transcriptions[0];
  return final ? final.utterances : [];
}

export function conversationWords(c: ConversationDetail): number {
  return pickUtterances(c).reduce((n, u) => n + wordCount(u.text), 0);
}

export class MockBeeSource implements BeeSource {
  readonly kind = "mock";
  private convs = new Map<number, ConversationDetail>();
  private journals: Journal[] = [];
  readonly deleted: number[] = [];

  constructor(dir: string, extra: unknown[] = []) {
    const cdir = join(dir, "conversations");
    const raws: unknown[] = existsSync(cdir)
      ? readdirSync(cdir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => JSON.parse(readFileSync(join(cdir, f), "utf8")))
      : [];
    {
      for (const raw of [...raws, ...extra]) {
        const parsed = ConversationGetResponseSchema.parse(raw);
        const c = parsed.conversation;
        // Real Bee: every speaker label is "Unknown" (bee-cli issue 19). Force it.
        for (const t of c.transcriptions) for (const u of t.utterances) u.speaker = "Unknown";
        if (conversationWords(c) < MIN_CONVERSATION_WORDS) {
          this.deleted.push(c.id); // Bee would have deleted it as noise
          continue;
        }
        this.convs.set(c.id, c);
      }
    }
    const jfile = join(dir, "journals.json");
    if (existsSync(jfile)) {
      this.journals = JournalListResponseSchema.parse(JSON.parse(readFileSync(jfile, "utf8"))).journals;
    }
  }

  async conversations(sinceMs: number): Promise<ConversationSummary[]> {
    return [...this.convs.values()]
      .filter((c) => c.start_time >= sinceMs)
      .sort((a, b) => a.start_time - b.start_time)
      .map((c) => ({
        id: c.id,
        start_time: c.start_time,
        end_time: c.end_time,
        created_at: c.created_at,
        summary: c.summary,
        state: c.state,
        utterances_count: pickUtterances(c).length,
      }));
  }

  async conversation(id: number): Promise<ConversationDetail | null> {
    const c = this.convs.get(id);
    return c ? structuredClone(c) : null;
  }

  async voiceNotes(sinceMs: number): Promise<Journal[]> {
    return this.journals.filter((j) => j.created_at >= sinceMs).sort((a, b) => a.created_at - b.created_at);
  }
}

const execFileP = promisify(execFile);

// VERIFIED 2026-10-15 against the production API with @beeai/cli 0.8.0 (live contract test passes).
// Commands: `bee conversations list --limit N --cursor C --json`, `bee conversations get <id> --json`,
// `bee journals list --limit N --cursor C --json`, `bee journals get <id> --json`, `bee me --json`.
// Real-data notes: list payloads carry utterances_count and primary_location; a CAPTURING
// conversation has only a realtime transcription whose speakers are all "Unknown"; speaker
// labels for the wearer appear only on the final (non-realtime) transcription.
export class CliBeeSource implements BeeSource {
  readonly kind = "cli";
  // Every call has a timeout (BEE_CLI_TIMEOUT_MS, default 30 s): a hung CLI must not stall the
  // hub's verifier tick, which also runs the other-speaker purge.
  constructor(
    private bin = process.env.BEE_BIN ?? "bee",
    private timeoutMs = Number(process.env.BEE_CLI_TIMEOUT_MS) || 30_000,
  ) {}

  private async run(args: string[]): Promise<unknown> {
    const p = execFileP(this.bin, [...args, "--json"], { maxBuffer: 64 * 1024 * 1024, timeout: this.timeoutMs, killSignal: "SIGKILL" });
    trackChild(p.child);
    const { stdout } = await p;
    return JSON.parse(stdout);
  }

  async me(): Promise<Me> {
    return MeSchema.parse(await this.run(["me"]));
  }

  async conversations(sinceMs: number, untilMs = Number.POSITIVE_INFINITY): Promise<ConversationSummary[]> {
    const out: ConversationSummary[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 50; page++) {
      const args = ["conversations", "list", "--limit", "50", ...(cursor ? ["--cursor", cursor] : [])];
      const res = ConversationListResponseSchema.parse(await this.run(args));
      out.push(...res.conversations);
      cursor = res.next_cursor;
      if (!cursor || res.conversations.length === 0) break;
      const oldest = Math.min(...res.conversations.map((c) => c.start_time));
      if (oldest < sinceMs) break; // newest-first: later pages are older still
    }
    const seen = new Set<number>();
    return out
      .filter((c) => c.start_time >= sinceMs && c.start_time < untilMs && !seen.has(c.id) && !!seen.add(c.id))
      .sort((a, b) => a.start_time - b.start_time);
  }

  async conversation(id: number): Promise<ConversationDetail | null> {
    const res = ConversationGetResponseSchema.parse(await this.run(["conversations", "get", String(id)]));
    return res.conversation;
  }

  async journalsAll(): Promise<Journal[]> {
    const out: Journal[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 50; page++) {
      const args = ["journals", "list", "--limit", "50", ...(cursor ? ["--cursor", cursor] : [])];
      const res = JournalListResponseSchema.parse(await this.run(args));
      out.push(...res.journals);
      cursor = res.next_cursor;
      if (!cursor || res.journals.length === 0) break;
    }
    return out.sort((a, b) => epochMs(a.created_at) - epochMs(b.created_at));
  }

  async journal(id: string): Promise<Journal | null> {
    return JournalGetResponseSchema.parse(await this.run(["journals", "get", id]));
  }

  async voiceNotes(sinceMs: number): Promise<Journal[]> {
    return (await this.journalsAll()).filter((j) => j.state === "READY" && epochMs(j.created_at) >= sinceMs);
  }
}

// The journal created_at unit is unverified (bee-cli tests use seconds for journals and ms for
// conversations). Normalize either to epoch ms.
export const epochMs = (t: number) => (t < 1e12 ? t * 1000 : t);

export function makeSource(variantDir?: string): BeeSource {
  const mode = process.env.BEE_SOURCE ?? "mock";
  if (mode === "cli") return new CliBeeSource();
  if (mode !== "mock") throw new Error(`BEE_SOURCE must be mock|cli, got ${mode}`);
  return new MockBeeSource(variantDir ?? join("fixtures", process.env.BEE_FIXTURE_VARIANT ?? "verbatim"));
}
