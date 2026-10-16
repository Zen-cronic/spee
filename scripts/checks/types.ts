// The context scripts/contract-check.ts hands to each packet's check module (contract v2,
// lead-owned). A module is `export async function run(ctx: CheckCtx): Promise<CheckResult>` in
// scripts/checks/<name>.ts, runs against the same demo hub (pace 0.02) after the v1 and v2 core
// assertions, and returns `{ name, ...ctx.counts() }` (or `pending: true` while it is a stub).
import type WebSocket from "ws";

export type Ev = { topic: string; payload: Record<string, any> };

export interface BridgeClient {
  ws: WebSocket;
  events: Ev[]; // app frames received (sequenced and room-scoped), in arrival order
  intents: any[]; // bridge intents received
  welcome: Promise<any>; // the welcome frame (code, joinUrl, serverTime)
  hubNow(): number; // hub-clock now (welcome offset)
}

export interface HttpResult {
  status: number;
  body: any;
}

export interface CheckCtx {
  base: string; // http://127.0.0.1:<port> of the demo hub
  port: number;
  pace: number; // demo replay pace of the hub
  tokens: { pair: string; mcp: string }; // the hub's PAIR_TOKEN and MCP_TOKEN (set by the check)
  get(path: string, exampleKey?: string): Promise<HttpResult>;
  post(path: string, body?: unknown, exampleKey?: string): Promise<HttpResult>;
  // A raw HTTP request (custom Host, proxy headers, unnormalized paths).
  raw(path: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string; headers: Record<string, unknown> }>;
  check(ok: unknown, what: string): boolean; // records a pass or a failure (printed)
  counts(): { passed: number; failed: number }; // this module's tally so far
  sleep(ms: number): Promise<void>;
  tv: BridgeClient; // a screen ("tv-mirror") in room tvCode
  phone: BridgeClient; // a mic ("phone-1") paired to the TV's room
  tvCode: string;
  sse: Ev[]; // every SSE event since the start (hub.state excluded)
  waitFor(pred: (e: Ev) => boolean, what: string, ms?: number): Promise<Ev | null>; // on tv.events
  bridgeClient(role: "screen" | "mic", clientId: string, code?: string, opts?: { query?: string; headers?: Record<string, string> }): BridgeClient;
  fixtures: Record<string, any>; // fixtures/contract-v2/*.json by file name
  examples: Record<string, unknown>; // add entries to docs/contract-examples.json (--write-examples)
}

export interface CheckResult {
  name: string;
  passed: number;
  failed: number;
  pending?: boolean; // the packet has not landed; its flows are not checked yet
  note?: string;
}
