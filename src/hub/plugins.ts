// The fixed plugin registry (contract v2). Order matters: routing and onApp fall through in this
// order. Each plugin lives in its own module; the list itself does not change.
//   live    src/hub/live/plugin.ts  live coaching     /api/live, /api/recaps, /api/coach, /api/demo/live
//   mirror  src/hub/mirror.ts       practice mirror   /api/demo/mirror; practice.* and mirror.focus frames
//   static  src/hub/static.ts       hub               /tv/, /p/, /sim/
//   alexa   src/alexa/plugin.ts     Alexa skill       /alexa
//   mcp     src/mcp/plugin.ts       MCP server        /mcp
import { createAlexaPlugin } from "../alexa/plugin.js";
import { createMcpPlugin } from "../mcp/plugin.js";
import { createLivePlugin } from "./live/plugin.js";
import { createMirrorPlugin } from "./mirror.js";
import type { HubPlugin } from "./plugin.js";
import { createStaticPlugin } from "./static.js";

export const PLUGIN_NAMES = ["live", "mirror", "static", "alexa", "mcp"] as const;
export type PluginName = (typeof PLUGIN_NAMES)[number];

export const PLUGIN_MODULES: Record<PluginName, { file: string; owner: string; create: () => HubPlugin }> = {
  live: { file: "src/hub/live/plugin.ts", owner: "live coaching", create: createLivePlugin },
  mirror: { file: "src/hub/mirror.ts", owner: "practice mirror", create: createMirrorPlugin },
  static: { file: "src/hub/static.ts", owner: "hub", create: () => createStaticPlugin() },
  alexa: { file: "src/alexa/plugin.ts", owner: "Alexa skill", create: createAlexaPlugin },
  mcp: { file: "src/mcp/plugin.ts", owner: "MCP server", create: createMcpPlugin },
};

// Fresh plugin instances for one hub server, in registry order.
export function createPlugins(): HubPlugin[] {
  return PLUGIN_NAMES.map((n) => {
    const p = PLUGIN_MODULES[n].create();
    if (p.name !== n) throw new Error(`plugin module ${PLUGIN_MODULES[n].file} must create a plugin named "${n}" (got "${p.name}")`);
    return p;
  });
}
