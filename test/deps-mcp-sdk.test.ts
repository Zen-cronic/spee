// Smoke test: the pinned MCP SDK works with this repo's zod (4.x) over stateless Streamable HTTP,
// the transport packet C uses at /mcp. One tool with a zod input schema and structuredContent.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let http: Server;
let url: string;

function mcp() {
  const server = new McpServer({ name: "smoke", version: "0.0.0" });
  server.registerTool(
    "echo_habit",
    { description: "Echo a habit key", inputSchema: { habit: z.string().min(1) }, outputSchema: { habit: z.string(), per100: z.number() } },
    async ({ habit }) => ({ content: [{ type: "text", text: `${habit} at 1.4 per 100 words` }], structuredContent: { habit, per100: 1.4 } }),
  );
  return server;
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const server = mcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => http.close(() => r())));

describe("MCP SDK with zod 4", () => {
  it("lists and calls a tool over stateless Streamable HTTP", async () => {
    const client = new Client({ name: "smoke-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["echo_habit"]);
    expect(tools.tools[0]!.inputSchema.properties).toHaveProperty("habit");
    const r = await client.callTool({ name: "echo_habit", arguments: { habit: "hedges" } });
    expect(r.structuredContent).toEqual({ habit: "hedges", per100: 1.4 });
    expect((r.content as { text: string }[])[0]!.text).toContain("hedges");
    const bad = await client.callTool({ name: "echo_habit", arguments: { habit: "" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
