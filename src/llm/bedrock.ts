// Amazon Bedrock Converse (non-streaming) with forced tool use, a model fallback chain,
// and a content-addressed response cache so reruns are deterministic and free.
import { BedrockRuntimeClient, ConverseCommand, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_CHAIN = (
  process.env.LLM_MODEL_CHAIN ??
  [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    // Fallback when Anthropic models are gated by the account's use-case form. Not Nova:
    // Nova fails tool-use structured output.
    "openai.gpt-oss-120b-1:0",
    "qwen.qwen3-next-80b-a3b",
  ].join(",")
).split(",");

// Hard allowlist. Invoking any other third-party model on this account can auto-accept a paid
// Marketplace offer, so a model outside this set is never called, whatever MODEL_CHAIN says.
// (qwen stays in the default chain string only so the mock run's cache keys stay stable;
// it is skipped at call time.)
export const ALLOWED_MODELS = new Set([
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "openai.gpt-oss-120b-1:0",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CACHE_DIR = process.env.LLM_CACHE_DIR ?? "cache";
const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: fromIni({ profile: process.env.AWS_PROFILE ?? "hackathon-1" }),
});

export interface ToolCallResult {
  input: unknown;
  modelId: string;
  cached: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export const llmLog: { event: string; modelId?: string; error?: string; key?: string }[] = [];
const gated = new Set<string>();
export const usage = { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, byModel: {} as Record<string, number> };

// `sanitize` runs on the model's output BEFORE anything is cached: it returns what may be kept (for
// example with offending items removed), or null to reject it all. A rejected output is cached as a
// marker with no text, so private principles or other speakers' words the model echoed never reach
// cache/ (and the call is not repeated). A rejection returns { input: null }.
export type CallToolOpts = { system: string; user: string; tool: Tool; label: string; chain?: string[]; sanitize?: (input: unknown) => unknown | null };
export type CallToolFn = (opts: CallToolOpts) => Promise<ToolCallResult>;

export async function callTool(opts: CallToolOpts): Promise<ToolCallResult> {
  const chain = opts.chain ?? MODEL_CHAIN;
  const key = createHash("sha256")
    .update(JSON.stringify({ v: 1, chain, system: opts.system, user: opts.user, tool: opts.tool }))
    .digest("hex");
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    const hit = JSON.parse(readFileSync(file, "utf8"));
    usage.cacheHits++;
    usage.byModel[hit.modelId] = (usage.byModel[hit.modelId] ?? 0) + 1;
    if (hit.rejected) return { input: null, modelId: hit.modelId, cached: true, usage: hit.usage };
    // an entry written before sanitize existed is checked again on the way out
    const input = opts.sanitize ? opts.sanitize(hit.input) : hit.input;
    return { input, modelId: hit.modelId, cached: true, usage: hit.usage };
  }
  const toolName = opts.tool.toolSpec!.name!;
  let lastErr = "";
  for (const modelId of chain) {
    if (gated.has(modelId)) continue;
    if (!ALLOWED_MODELS.has(modelId)) {
      llmLog.push({ event: "model_not_allowed_skipped", modelId });
      gated.add(modelId);
      continue;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        usage.calls++;
        const res = await client.send(
          new ConverseCommand({
            modelId,
            system: [{ text: opts.system }],
            messages: [{ role: "user", content: [{ text: opts.user }] }],
            toolConfig: { tools: [opts.tool], toolChoice: { tool: { name: toolName } } },
            inferenceConfig: { maxTokens: 4000, temperature: 0 },
          }),
        );
        const block = res.output?.message?.content?.find((b) => b.toolUse);
        let input: unknown = block?.toolUse?.input;
        if (input === undefined) {
          // Some non-Anthropic models occasionally answer in text despite toolChoice; accept a JSON object there.
          const text = (res.output?.message?.content ?? []).map((b) => b.text ?? "").join("");
          const m = text.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              input = JSON.parse(m[0]);
            } catch {
              /* fall through */
            }
          }
        }
        if (input === undefined) throw new Error(`no toolUse block (stopReason=${res.stopReason})`);
        const u = { inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
        usage.byModel[modelId] = (usage.byModel[modelId] ?? 0) + 1;
        const kept = opts.sanitize ? opts.sanitize(input) : input;
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify(kept === null ? { label: opts.label, modelId, rejected: true, usage: u, at: new Date().toISOString() } : { label: opts.label, modelId, input: kept, usage: u, at: new Date().toISOString() }, null, 1));
        return { input: kept, modelId, cached: false, usage: u };
      } catch (e) {
        const err = e as Error;
        lastErr = `${err.name}: ${err.message}`;
        if (/use case details|AccessDenied|end of its life|invalid/i.test(err.message)) {
          if (!gated.has(modelId)) llmLog.push({ event: "model_unavailable", modelId, error: lastErr });
          gated.add(modelId);
          break;
        }
        llmLog.push({ event: "call_error", modelId, error: lastErr, key: opts.label });
        // The account throttles: back off exponentially (2 s, 4 s, 8 s, 16 s) before retrying.
        if (/throttl|too many requests|rate exceeded|rate limit/i.test(lastErr) && attempt < 4) await sleep(2000 * 2 ** attempt);
        else if (attempt >= 2) break;
      }
    }
  }
  throw new Error(`All models failed for ${opts.label}: ${lastErr}`);
}

// Simple concurrency limiter
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}
