// Alexa plugin (packet C): POST /alexa, the custom skill endpoint (skill id + timestamp checked,
// intents mapped onto the hub routes through the loopback hub client; no model call in a
// request). STUB until packet C lands: answers 501. Packet C replaces this file's body and keeps
// the export name `createAlexaPlugin`, the prefix and the route (docs/CONTRACT.md v2).
import { stubPlugin, type HubPlugin } from "../hub/plugin.js";

export const ALEXA_PREFIXES = ["/alexa"];
export const ALEXA_ROUTES = ["POST /alexa"];

export function createAlexaPlugin(): HubPlugin {
  return stubPlugin({ name: "alexa", owner: "packet C", prefixes: ALEXA_PREFIXES, routes: ALEXA_ROUTES });
}
