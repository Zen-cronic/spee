// Zod schemas mirroring bee-cli types at commit 84a6e8fcb955a66fc15da63ce4c50289591959ec
// (sources/resources/conversations/index.ts ConversationDetail / ConversationSummary,
// sources/resources/journals/index.ts JournalSummary, sources/commands/stream/index.ts aiResponse).
// The CLI prints the raw server JSON for --json, so these describe the server payload.
import { z } from "zod";

export const UtteranceSchema = z.object({
  id: z.number().int(),
  realtime: z.boolean(),
  start: z.number().nullable(), // seconds into the conversation on real devices (community-reported)
  end: z.number().nullable(),
  spoken_at: z.number().nullable(), // epoch ms
  text: z.string(),
  speaker: z.string(), // final transcriptions: the wearer's profile name or "Unknown" (verified 2026-10-15); realtime: all "Unknown"
  created_at: z.number(),
});
export type Utterance = z.infer<typeof UtteranceSchema>;

export const TranscriptionSchema = z.object({
  id: z.number().int(),
  realtime: z.boolean(),
  utterances: z.array(UtteranceSchema),
});

export const ConversationDetailSchema = z.object({
  id: z.number().int(),
  start_time: z.number(),
  end_time: z.number().nullable(),
  device_type: z.string(),
  summary: z.string().nullable(),
  short_summary: z.string().nullable(),
  state: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  transcriptions: z.array(TranscriptionSchema),
  suggested_links: z.array(z.object({ url: z.string(), created_at: z.number() })),
  primary_location: z
    .object({
      address: z.string().nullable(),
      latitude: z.number(),
      longitude: z.number(),
      created_at: z.number(),
    })
    .nullable(),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

// `bee conversations get <id> --json`
export const ConversationGetResponseSchema = z.object({
  conversation: ConversationDetailSchema,
  timezone: z.string().optional(),
});
export type ConversationGetResponse = z.infer<typeof ConversationGetResponseSchema>;

export const ConversationSummarySchema = z
  .object({
    id: z.number().int(),
    start_time: z.number(),
    end_time: z.number().nullable(),
    created_at: z.number(),
    summary: z.string().nullable(),
    state: z.string(),
  })
  .passthrough(); // real list payloads also carry e.g. utterances_count (community-reported)
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

// `bee conversations list --json`
export const ConversationListResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
  next_cursor: z.string().nullable().optional(),
  timezone: z.string().optional(),
});

// aiResponse is only typed in the stream renderer; whether REST `journals get` returns it is UNVERIFIED.
export const JournalAiResponseSchema = z
  .object({
    message: z.string().nullable().optional(),
    cleanedUpText: z.string().nullable().optional(),
    followUp: z.string().nullable().optional(),
    todos: z.array(z.string()).nullable().optional(),
  })
  .nullable();

export const JournalSchema = z
  .object({
    id: z.string(),
    text: z.string().nullable(),
    state: z.enum(["PREPARING", "ANALYZING", "READY"]),
    created_at: z.number(),
    updated_at: z.number(),
    aiResponse: JournalAiResponseSchema.optional(),
  })
  .passthrough();
export type Journal = z.infer<typeof JournalSchema>;

// `bee journals get <id> --json` (journal fields at top level plus timezone)
export const JournalGetResponseSchema = JournalSchema.extend({ timezone: z.string().optional() });

// `bee journals list --json`
export const JournalListResponseSchema = z.object({
  journals: z.array(JournalSchema),
  next_cursor: z.string().nullable().optional(),
  timezone: z.string().optional(),
});

// `bee me --json` (verified 2026-10-15: id, first_name, last_name, timezone)
export const MeSchema = z
  .object({
    id: z.number(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
  })
  .passthrough();
export type Me = z.infer<typeof MeSchema>;
