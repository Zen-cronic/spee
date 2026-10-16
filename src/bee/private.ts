// Maps the operator's private real stand-up transcript (Tactiq / Google Meet captions ASR,
// gitignored under fixtures/private/) into the Bee `conversations get --json` shape so it flows
// through MockBeeSource exactly like Bee data. Raw text must never be copied into tracked files.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ConversationGetResponse } from "./schemas.js";

export const PRIVATE_STANDUP = "fixtures/private/real-standup-2026-10-13.json";
export const PRIVATE_ARTIFACTS = "fixtures/private/real-standup-asr-artifacts.json";
export const PRIVATE_CONV_ID = 9000001;

const PrivateSchema = z.object({
  source: z.string(),
  asr: z.string(),
  speaker_true: z.string(),
  utterances: z.array(z.object({ idx: z.number(), start: z.number(), end: z.number(), spoken_at: z.number(), text: z.string() })),
});

export function loadPrivateStandup(path = PRIVATE_STANDUP): ConversationGetResponse | null {
  if (!existsSync(path)) return null;
  const d = PrivateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const u = d.utterances;
  const t0 = u[0]!.spoken_at - u[0]!.start * 1000;
  return {
    conversation: {
      id: PRIVATE_CONV_ID,
      start_time: u[0]!.spoken_at,
      end_time: u.at(-1)!.spoken_at + (u.at(-1)!.end - u.at(-1)!.start) * 1000,
      device_type: "unknown",
      summary: null,
      short_summary: null,
      state: "COMPLETED",
      created_at: t0,
      updated_at: t0,
      transcriptions: [
        {
          id: PRIVATE_CONV_ID * 10 + 1,
          realtime: false,
          utterances: u.map((x) => ({
            id: PRIVATE_CONV_ID * 1000 + x.idx + 1,
            realtime: false,
            start: x.start,
            end: x.end,
            spoken_at: x.spoken_at,
            text: x.text,
            speaker: "Unknown",
            created_at: x.spoken_at,
          })),
        },
      ],
      suggested_links: [],
      primary_location: null,
    },
    timezone: "America/Toronto",
  };
}

// Known/likely ASR mishearings, kept in the gitignored private dir.
export function loadArtifactTokens(path = PRIVATE_ARTIFACTS): string[] {
  if (!existsSync(path)) return [];
  return z.array(z.string()).parse(JSON.parse(readFileSync(path, "utf8")));
}
