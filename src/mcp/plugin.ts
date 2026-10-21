// MCP plugin: /mcp, a stateless Streamable HTTP MCP server whose tools map 1:1 to hub
// routes (MCP_TOOLS in src/hub/contract.ts, implemented in ./tools.ts over the loopback HubClient).
//   POST /mcp      JSON-RPC (initialize, tools/list, tools/call, ...); JSON responses, no session id
//   GET|DELETE     405 (stateless: no standalone SSE stream, no session to delete)
//   OPTIONS        204 preflight exposing mcp-session-id. No wildcard CORS: the hub echoes an allowed
//                  Origin (src/hub/gate.ts) and refuses a foreign one before this plugin runs.
// Public requests reach it only with Authorization: Bearer $MCP_TOKEN: the gate (src/hub/gate.ts)
// enforces that, and this plugin checks again. No model call in a request.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CONTRACT_VERSION } from "../hub/contract.js";
import type { HubPlugin, PluginCtx } from "../hub/plugin.js";
import { HubClient } from "./hubClient.js";
import { maskDeep } from "../hub/mask.js";
import { TOOL_DEFS } from "./tools.js";

export const MCP_PREFIXES = ["/mcp"];
export const MCP_ROUTES = ["POST /mcp", "GET /mcp", "DELETE /mcp"];

export const MCP_CORS: Record<string, string> = {
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, accept, mcp-session-id, mcp-protocol-version, last-event-id, ngrok-skip-browser-warning",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "600",
};

export const MCP_INSTRUCTIONS =
  "Spee, a speech coach. Drills take two turns: submit_attempt returns at once (status pending_bee) because Bee, the wearable, is the grader of record and its line lands 5-20 s later. End the turn, then call get_verdict when the user asks how they did. Never present a provisional grade as the result.";

// A fresh server per request (stateless), with every tool bound to the loopback hub client.
export function buildMcpServer(hub: HubClient, log?: PluginCtx["log"]): McpServer {
  const server = new McpServer({ name: "bee-speech-coach", version: `contract-v${CONTRACT_VERSION}` }, { instructions: MCP_INSTRUCTIONS });
  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.input }, async (args: Record<string, unknown>) => {
      const t0 = Date.now();
      const o = await def.run(hub, args ?? {});
      log?.("mcp.tool", { tool: def.name, route: o.route, status: o.result.status, ms: Date.now() - t0 });
      const b = o.result.body;
      const structured = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : { value: b };
      // An assistant reads this aloud: private terms come out as "name" (src/hub/mask.ts).
      const out = maskDeep({ text: o.text || (o.result.ok ? "Done." : "The hub refused that."), structured }, "speech");
      return { content: [{ type: "text" as const, text: out.text }], structuredContent: out.structured, ...(o.result.ok ? {} : { isError: true }) };
    });
  }
  return server;
}

export interface McpPluginOptions {
  hub?: HubClient; // default: a loopback client on ctx.selfUrl()
}

export function createMcpPlugin(opts: McpPluginOptions = {}): HubPlugin {
  let hub: HubClient | null = opts.hub ?? null;
  let requests = 0;
  const client = (ctx: PluginCtx) => (hub ??= new HubClient(() => ctx.selfUrl()));
  return {
    name: "mcp",
    prefixes: MCP_PREFIXES,
    attach(ctx) {
      client(ctx);
    },
    async route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PluginCtx) {
      if (url.pathname !== "/mcp") return false;
      const method = req.method ?? "GET";
      if (method === "OPTIONS") {
        res.writeHead(204, MCP_CORS);
        res.end();
        return true;
      }
      // Defence in depth: the gate already refuses a public /mcp request without the bearer token.
      if (ctx.isPublic(req) && !ctx.auth.mcpBearerOk(req.headers.authorization)) {
        res.writeHead(403, { "content-type": "application/json", ...MCP_CORS });
        res.end(JSON.stringify({ error: "forbidden", message: "mcp needs Authorization: Bearer <MCP_TOKEN>" }));
        return true;
      }
      if (method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST, OPTIONS", ...MCP_CORS });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless (POST only)" }, id: null }));
        return true;
      }
      for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
      const server = buildMcpServer(client(ctx), ctx.log);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close().then(() => server.close()).catch(() => undefined));
      await server.connect(transport);
      await transport.handleRequest(req, res);
      requests++;
      return true;
    },
    describe: () => ({
      owner: "MCP server",
      status: "ready",
      routes: MCP_ROUTES,
      note: `stateless Streamable HTTP; ${TOOL_DEFS.length} tools (MCP_TOOLS); ${requests} requests served`,
    }),
  };
}
