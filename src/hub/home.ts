// The hub's home page (GET / and HEAD /): links to the TV, the Alexa+ simulator and phone pairing,
// with one plain status line. Loopback and LAN only: "/" is not a public route, so the gate refuses
// it through a tunnel (gate.ts). The page is static HTML (web/hub/index.html, no build step); the
// server fills in one JSON blob of status. The blob never carries a token, only the TV's 4-character
// pair code, which the TV already shows on screen.
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { REPO_ROOT } from "./static.js";

export const HOME_FILE = "web/hub/index.html";
export const HOME_SLOT = '<script id="hub-status" type="application/json"></script>';

export interface HomeStatus {
  demo: boolean;
  dataLabel: string | null; // shown in demo mode only
  bee: "replay" | "live" | "off";
  pairCode: string | null; // a TV's room code, when a TV is open
  screens: number;
  phones: number;
  drillsDue: number | null;
}

/** Fill the status slot. "<" is escaped so no value can close the script element. */
export function renderHome(template: string, status: HomeStatus): string {
  const json = JSON.stringify(status).replace(/</g, "\\u003c");
  return template.replace(HOME_SLOT, `<script id="hub-status" type="application/json">${json}</script>`);
}

export function serveHome(req: IncomingMessage, res: ServerResponse, status: HomeStatus, root: string = REPO_ROOT): void {
  const file = join(root, HOME_FILE);
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not_found", message: `${HOME_FILE} is missing` }));
    return;
  }
  const html = renderHome(readFileSync(file, "utf8"), status);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : html);
}
