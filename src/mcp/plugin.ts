// MCP plugin (packet C): /mcp, a stateless Streamable HTTP MCP server whose tools map 1:1 to hub
// routes (MCP_TOOLS in src/hub/contract.ts). STUB until packet C lands: answers 501. Packet C
// replaces this file's body and keeps the export name `createMcpPlugin`, the prefix and the
// routes (docs/CONTRACT.md v2). Public requests reach it only with Authorization: Bearer $MCP_TOKEN
// (src/hub/gate.ts).
import { stubPlugin, type HubPlugin } from "../hub/plugin.js";

export const MCP_PREFIXES = ["/mcp"];
export const MCP_ROUTES = ["POST /mcp", "GET /mcp", "DELETE /mcp"];

export function createMcpPlugin(): HubPlugin {
  return stubPlugin({ name: "mcp", owner: "packet C", prefixes: MCP_PREFIXES, routes: MCP_ROUTES });
}
