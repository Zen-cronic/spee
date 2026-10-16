// Public-access gate (contract v2, lead-owned). A tunnel (ngrok http 8791) would otherwise expose
// the wearer's own words (/api/*, SSE, the TV). A request is PUBLIC when it carries a proxy header
// (x-forwarded-for, forwarded, x-forwarded-host, x-real-ip, cf-connecting-ip) or its Host is not a
// loopback or LAN name. Public requests may only reach:
//   POST /alexa                                  (the skill checks its own skill id and timestamp)
//   GET|HEAD /p/* and /sim/*                     (static phone page and simulator)
//   /mcp                                         with Authorization: Bearer $MCP_TOKEN (OPTIONS without)
//   /ws (WebSocket upgrade)                      with ?k=$PAIR_TOKEN
// Everything else gets 403 {error:"forbidden"}; a refused upgrade gets its socket destroyed.
// LAN and loopback requests are not gated. When PAIR_TOKEN or MCP_TOKEN is unset, a random one is
// generated at startup and printed once on the console; tokens never appear in a response or a log.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";

export const PUBLIC_ROUTES = ["POST /alexa", "GET /p/*", "GET /sim/*", "/mcp (Authorization: Bearer $MCP_TOKEN)", "/ws upgrade (?k=$PAIR_TOKEN)"];
export const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"];

export interface GateTokens {
  pairToken: string;
  mcpToken: string;
  source: { pair: "env" | "generated"; mcp: "env" | "generated" };
}

// Tokens from the environment, or generated for this run (printed once through `print`).
export function resolveTokens(env: Record<string, string | undefined> = process.env, print: (line: string) => void = (l) => console.log(l)): GateTokens {
  const one = (name: string): [string, "env" | "generated"] => {
    const v = env[name]?.trim();
    if (v) {
      if (v.length < 16) print(`hub: warning: ${name} is shorter than 16 characters`);
      return [v, "env"];
    }
    const t = randomBytes(18).toString("base64url");
    print(`hub: ${name} is unset; generated for this run: ${t}  (export ${name} to keep it across restarts)`);
    return [t, "generated"];
  };
  const [pairToken, pair] = one("PAIR_TOKEN");
  const [mcpToken, mcp] = one("MCP_TOKEN");
  return { pairToken, mcpToken, source: { pair, mcp } };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export const tokenEquals = (given: string | null | undefined, want: string) => typeof given === "string" && given.length > 0 && timingSafeEqual(digest(given), digest(want));
export const bearerOk = (authorization: string | undefined, token: string) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return !!m && tokenEquals(m[1], token);
};

function ipv4Local(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 0 && ip === "0.0.0.0");
}

// True for a loopback or LAN host name/address (port and IPv6 brackets stripped).
export function hostIsLocal(hostHeader: string | undefined, extraLanHosts: string[] = []): boolean {
  if (!hostHeader) return false;
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  else if (h.split(":").length === 2) h = h.split(":")[0]!;
  h = h.replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.startsWith("::ffff:")) return ipv4Local(h.slice(7));
  if (ipv4Local(h)) return true;
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  if (h.endsWith(".local") || h.endsWith(".home.arpa")) return true;
  const me = hostname().toLowerCase();
  return h === me || h === me.split(".")[0] || extraLanHosts.map((x) => x.toLowerCase()).includes(h);
}

export function isPublicRequest(req: { headers: IncomingHttpHeaders }, extraLanHosts: string[] = []): boolean {
  if (PROXY_HEADERS.some((k) => req.headers[k] !== undefined)) return true;
  return !hostIsLocal(req.headers.host, extraLanHosts);
}

export type GateDecision = { allow: true; public: boolean } | { allow: false; public: true; reason: string };

// HTTP requests (not upgrades). `path` is the parsed pathname (WHATWG URL: dot segments resolved).
export function gateHttp(req: IncomingMessage, path: string, tokens: GateTokens, extraLanHosts: string[] = []): GateDecision {
  if (!isPublicRequest(req, extraLanHosts)) return { allow: true, public: false };
  const method = req.method ?? "GET";
  const under = (p: string) => path === p || path.startsWith(`${p}/`);
  if (path === "/alexa" && method === "POST") return { allow: true, public: true };
  if ((under("/p") || under("/sim")) && (method === "GET" || method === "HEAD")) return { allow: true, public: true };
  if (under("/mcp")) {
    if (method === "OPTIONS") return { allow: true, public: true };
    if (bearerOk(req.headers.authorization, tokens.mcpToken)) return { allow: true, public: true };
    return { allow: false, public: true, reason: "mcp needs Authorization: Bearer <MCP_TOKEN>" };
  }
  return { allow: false, public: true, reason: "not reachable through a public tunnel" };
}

export function gateUpgrade(req: IncomingMessage, tokens: GateTokens, extraLanHosts: string[] = []): GateDecision {
  if (!isPublicRequest(req, extraLanHosts)) return { allow: true, public: false };
  const url = new URL(req.url ?? "/", "http://hub");
  if (url.pathname === "/ws" && tokenEquals(url.searchParams.get("k"), tokens.pairToken)) return { allow: true, public: true };
  return { allow: false, public: true, reason: url.pathname === "/ws" ? "ws needs ?k=<PAIR_TOKEN>" : "no public upgrade here" };
}

// Runs before the bridge's own upgrade listener: a refused upgrade is answered 403 and destroyed,
// and the bridge then sees a dead socket and drops it.
export function installUpgradeGate(server: Server, tokens: GateTokens, log: (event: string, data?: Record<string, unknown>) => void, extraLanHosts: string[] = []) {
  server.prependListener("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const g = gateUpgrade(req, tokens, extraLanHosts);
    if (g.allow) return;
    log("gate.denied", { path: new URL(req.url ?? "/", "http://hub").pathname, upgrade: true, reason: g.reason });
    try {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n{\"error\":\"forbidden\"}");
    } catch {
      /* already closed */
    }
    socket.destroy();
  });
}
