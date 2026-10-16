// Live coaching plugin (packet A): the realtime window, nudge policy, wrist, recaps and coachNow.
// STUB until packet A lands: every route answers 501 not_implemented. Packet A replaces this
// file's body and keeps the export name `createLivePlugin`, the prefixes and the routes. The
// payloads are frozen in src/hub/contract.ts and docs/CONTRACT.md (v2). In --demo --fixture-v2
// mode the server answers these routes from fixtures/contract-v2/ before this plugin is asked.
import { stubPlugin, type HubPlugin } from "../plugin.js";

export const LIVE_PREFIXES = ["/api/live", "/api/recaps", "/api/coach", "/api/demo/live"];
export const LIVE_ROUTES = ["GET /api/live", "POST /api/live/mode", "GET /api/recaps", "GET /api/recaps/<id>", "GET /api/coach/now", "POST /api/demo/live"];
export const LIVE_TOPICS = ["conversation.started", "live.window", "nudge.sent", "nudge.skipped", "conversation.ended", "recap.ready", "live.mode"];

export function createLivePlugin(): HubPlugin {
  return stubPlugin({ name: "live", owner: "packet A", prefixes: LIVE_PREFIXES, routes: LIVE_ROUTES, topics: LIVE_TOPICS });
}
