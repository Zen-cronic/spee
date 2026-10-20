// Public-access gate (contract v2). A tunnel (ngrok http 8791) would otherwise expose
// the wearer's own words (/api/*, SSE, the TV), and so would any web page the wearer visits while
// the hub runs (it can call http://127.0.0.1:8791 from the browser). Two independent checks:
//
// 1. Trust (who is connecting). A request is TRUSTED only when all of these hold:
//    - it carries no proxy header (x-forwarded-for, forwarded, x-forwarded-host, x-real-ip,
//      cf-connecting-ip; ngrok http adds x-forwarded-for),
//    - its Host is a loopback or LAN name,
//    - its socket comes from loopback, or from a LAN address when LAN trust is on (`--lan` or
//      HUB_TRUST_LAN=1; off by default, so other devices on shared Wi-Fi are public).
//    Everything else is PUBLIC and may only reach:
//      POST /alexa                                  (the skill checks its signature, skill id and timestamp)
//      GET|HEAD /p/* and /sim/*                     (static phone page and simulator)
//      /mcp                                         with Authorization: Bearer $MCP_TOKEN (OPTIONS without)
//      /ws (WebSocket upgrade)                      with the pair token: the subprotocol
//                                                   "k.<base64url(PAIR_TOKEN)>" (the phone page), or
//                                                   ?k=$PAIR_TOKEN (older clients)
//    Anything else gets 403 {error:"forbidden"}; a refused upgrade gets its socket destroyed.
//    A TCP tunnel (ngrok tcp, ssh -R) carries no proxy header and arrives from loopback, so it would
//    be trusted: use `ngrok http` only. With PUBLIC_BASE_URL set, /alexa and /mcp authenticate
//    loopback requests too (mustAuthenticate).
//
// 2. Origin (which web page is asking). Browsers attach `Origin` to cross-site requests and to every
//    WebSocket handshake. A request without Origin is a non-browser client (Alexa, the MCP SDK, curl,
//    the Vega app) and passes this check. A request whose Origin is not on the allow-list is refused
//    whatever its trust level: 403 {error:"forbidden_origin"} for HTTP (static page loads, and /mcp
//    with the bearer or its preflight, excepted), and a destroyed socket for /ws unless it presents
//    the pair token. The allow-list:
//      the hub's own origins (localhost, 127.0.0.1, [::1], the LAN IP and this host name, on the hub
//      port), the same origin as a loopback/LAN Host, PUBLIC_BASE_URL, the Vite dev servers
//      (ports 5183 tv/web, 5184 web/phone, 5175 web/sim) and HUB_ALLOWED_ORIGINS (comma-separated).
//    CORS answers echo an allowed Origin (never `*`) with `vary: origin`.
//
// When PAIR_TOKEN or MCP_TOKEN is unset, a random one is generated, saved to <stateDir>/tokens.json (git-ignored, mode 0600). Later starts reuse
// it, so a hub restart does not lock out every paired phone and MCP client. A generated pair token
// is printed in full once (the start that makes it); the MCP token is only ever shown by its last 4
// characters (read it from tokens.json, or export your own). Later starts print only the last 4. `--rotate-tokens` (rotateTokens) generates new ones and deletes the old
// copies (tokens.json.bak, tokens.json.corrupt-*), which unpairs every phone: do it after a recording
// or a shared log showed a token or the TV's pairing QR. Tokens never appear in a response or a log,
// with one exception by design: a WebSocket peer that presented the pair token, or a trusted one
// with an allowed (or no) Origin, gets `welcome.joinUrl` with #k= (a URL fragment) so the TV can show
// it as a QR code (src/hub/bridgeGuard.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { readJsonSafe, removeCopies, writeJsonAtomic } from "./atomic.js";
import { forwardedClient } from "tv-voice-bridge/hub";
import { WS_TOKEN_PREFIX } from "./contract.js";
import type { Duplex } from "node:stream";

export const PUBLIC_ROUTES = ["POST /alexa", "GET /p/*", "GET /sim/*", "/mcp (Authorization: Bearer $MCP_TOKEN)", "/ws upgrade (pair token as subprotocol k.<base64url> or ?k=)"];
export const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"];
// Vite dev servers that proxy /api, /ws and /mcp to the hub (tv/web, web/phone, web/sim).
export const DEV_ORIGIN_PORTS = [5183, 5184, 5175];

export interface GateTokens {
  pairToken: string;
  mcpToken: string;
  source: { pair: "env" | "generated"; mcp: "env" | "generated" };
}

export interface GateOptions {
  extraLanHosts?: string[]; // more Host names to treat as LAN (tests)
  trustLan?: boolean; // LAN socket addresses are trusted like loopback (default false)
  origins?: OriginPolicy; // the Origin allow-list (default: no Origin header is accepted)
  tunnel?: boolean; // PUBLIC_BASE_URL is set: /alexa and /mcp authenticate every request (mustAuthenticate)
}
const gopts = (o: GateOptions | string[] | undefined): GateOptions => (Array.isArray(o) ? { extraLanHosts: o } : (o ?? {}));

// Tokens from the environment, else the ones saved by an earlier start in `savePath` (unless
// `rotate`), else generated and saved there. A token is printed in full only when generated.
export function resolveTokens(env: Record<string, string | undefined> = process.env, print: (line: string) => void = (l) => console.log(l), savePath: string | null = null, opts: { rotate?: boolean } = {}): GateTokens {
  // A rotation also deletes the backup and any moved-aside copies, which still hold the old tokens.
  if (savePath && opts.rotate) {
    try {
      const gone = removeCopies(savePath);
      if (gone.length) print(`hub: --rotate-tokens removed ${gone.length} old copy(ies) of ${savePath}`);
    } catch (err) {
      print(`hub: warning: could not remove the old copies of ${savePath} (${(err as Error).message}); delete ${savePath}.bak and ${savePath}.corrupt-* by hand`);
    }
  }
  const saved = savePath && !opts.rotate ? readSavedTokens(savePath, print) : {};
  const toSave: Record<string, string> = {};
  const one = (name: "PAIR_TOKEN" | "MCP_TOKEN"): [string, "env" | "generated"] => {
    const v = env[name]?.trim();
    if (v) {
      if (v.length < 16) print(`hub: warning: ${name} is shorter than 16 characters`);
      return [v, "env"];
    }
    const old = saved[name];
    if (old) {
      toSave[name] = old;
      print(`hub: ${name} is unset; reusing the one saved in ${savePath} (…${old.slice(-4)}; --rotate-tokens makes a new one and unpairs every phone)`);
      return [old, "generated"];
    }
    const t = randomBytes(18).toString("base64url");
    toSave[name] = t;
    const shown = name === "MCP_TOKEN" ? `…${t.slice(-4)}` : t; // the MCP token is never printed in full
    print(`hub: ${name} is unset; generated: ${shown}  (${savePath ? `saved in ${savePath} for the next start; ` : ""}export ${name} to choose your own)`);
    return [t, "generated"];
  };
  const [pairToken, pair] = one("PAIR_TOKEN");
  const [mcpToken, mcp] = one("MCP_TOKEN");
  if (savePath && Object.keys(toSave).length && (toSave.PAIR_TOKEN !== saved.PAIR_TOKEN || toSave.MCP_TOKEN !== saved.MCP_TOKEN)) {
    try {
      writeJsonAtomic(savePath, { ...(opts.rotate ? {} : saved), ...toSave }, { mode: 0o600 });
    } catch (err) {
      print(`hub: warning: could not save the generated tokens (${(err as Error).message}); a restart will make new ones`);
    }
  }
  return { pairToken, mcpToken, source: { pair, mcp } };
}

function readSavedTokens(path: string, print: (line: string) => void): Partial<Record<"PAIR_TOKEN" | "MCP_TOKEN", string>> {
  const j = readJsonSafe<Record<string, unknown>>(path, () => ({}), (m) => print(`hub: warning: ${m}`));
  const ok = (v: unknown) => (typeof v === "string" && v.length >= 16 ? v : undefined);
  return j && typeof j === "object" ? { PAIR_TOKEN: ok(j.PAIR_TOKEN), MCP_TOKEN: ok(j.MCP_TOKEN) } : {};
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export const tokenEquals = (given: string | null | undefined, want: string) => typeof given === "string" && given.length > 0 && timingSafeEqual(digest(given), digest(want));
export const bearerOk = (authorization: string | undefined, token: string) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return !!m && tokenEquals(m[1], token);
};

function ipv4Kind(ip: string): "loopback" | "lan" | "public" | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  const [a, b] = p as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 0 && ip === "0.0.0.0")) return "lan";
  return "public";
}
const ipv4Local = (ip: string) => {
  const k = ipv4Kind(ip);
  return k === "loopback" || k === "lan";
};

// What a socket's remote address is: loopback, LAN (private ranges, IPv6 ULA and link-local) or public.
export function addressKind(addr: string | undefined | null): "loopback" | "lan" | "public" {
  if (!addr) return "public";
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  const v4 = ipv4Kind(a);
  if (v4) return v4;
  if (a === "::1") return "loopback";
  if (/^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a)) return "lan";
  return "public";
}

// The key for the bridge's hello and wrong-code limits. Behind ngrok every peer arrives from the
// tunnel's loopback socket, so the key is the client address ngrok appends (the last
// x-forwarded-for entry), read only from a loopback socket (the tunnel agent): a direct peer that
// sends its own header is keyed on its socket, so a fresh header per upgrade buys no fresh budget.
// The rule is the bridge's own (forwardedClient), so a fix there reaches the hub too.
export function bridgeRateKey(req: IncomingMessage): string {
  return forwardedClient(req);
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

type ReqLike = { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string } | null };

// This machine's own interface addresses: a connection from one of them starts on this host (for
// example the hub's own client when the hub is bound to a LAN address).
let own: { at: number; set: Set<string> } | null = null;
export function isOwnAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (!own || Date.now() - own.at > 30_000) {
    const set = new Set<string>();
    for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) set.add(i.address.toLowerCase());
    own = { at: Date.now(), set };
  }
  const a = addr.toLowerCase();
  return own.set.has(a) || (a.startsWith("::ffff:") && own.set.has(a.slice(7)));
}

// Public = not trusted (see the header). A request object without a socket (unit tests) is judged on
// its headers alone; a real request whose socket address is unknown counts as public.
export function isPublicRequest(req: ReqLike, opts: GateOptions | string[] = {}): boolean {
  const o = gopts(opts);
  if (PROXY_HEADERS.some((k) => req.headers[k] !== undefined)) return true;
  if (!hostIsLocal(req.headers.host, o.extraLanHosts)) return true;
  if (!("socket" in req) || req.socket === undefined) return false;
  const addr = req.socket?.remoteAddress;
  const kind = isOwnAddress(addr) ? "loopback" : addressKind(addr);
  return !(kind === "loopback" || (kind === "lan" && !!o.trustLan));
}

// Whether /alexa (signature) and /mcp (bearer) must authenticate this request. A TCP tunnel (ngrok
// tcp, ssh -R) ends on this machine with no proxy header, so its traffic looks like loopback and no
// header can tell it apart (review H2). While a tunnel is declared (PUBLIC_BASE_URL), the two routes
// built for the internet therefore authenticate everyone, loopback included. /api, SSE, the TV and
// /ws cannot do the same (the TV on this machine holds no token), so only `ngrok http` (or another
// tunnel that adds x-forwarded-for) is supported: see docs/CONTRACT.md "Public access".
export function mustAuthenticate(req: ReqLike, opts: GateOptions | string[] = {}): boolean {
  return !!gopts(opts).tunnel || isPublicRequest(req, opts);
}

// Printed at startup while a tunnel is declared: the one tunnel shape the gate cannot see.
export function tunnelWarning(publicBaseUrl: string, port: number): string {
  return `hub: warning: PUBLIC_BASE_URL is ${publicBaseUrl}. Expose the hub with \`ngrok http ${port}\` (or another HTTP tunnel that adds X-Forwarded-For) only. A TCP tunnel (ngrok tcp, ssh -R, cloudflared TCP) arrives as loopback, so /api, SSE and /ws (pair token included) would answer the internet like this machine; /mcp and /alexa still authenticate.`;
}

// The Origin allow-list. `allowed(origin, host)` is false for "null", malformed and foreign origins.
export interface OriginPolicy {
  allowed(origin: string, host?: string): boolean;
  list(): string[];
}
const originOf = (s: string): string | null => {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
};
// The fixed part of the list reads the network interfaces and the host name, so it is built at most
// once per ORIGIN_CACHE_MS (and again when the hub's port changes), not on every request.
export const ORIGIN_CACHE_MS = 30_000;
export function originPolicy(o: { port: () => number; publicBaseUrl?: string | null; lanHosts?: () => string[]; extra?: string[]; devPorts?: number[]; extraLanHosts?: string[]; now?: () => number }): OriginPolicy {
  const now = o.now ?? Date.now;
  let cache: { at: number; port: number; set: Set<string> } | null = null;
  const fixed = (): Set<string> => {
    const port = o.port();
    if (cache && cache.port === port && now() - cache.at < ORIGIN_CACHE_MS) return cache.set;
    cache = { at: now(), port, set: build(port) };
    return cache.set;
  };
  const build = (port: number): Set<string> => {
    const set = new Set<string>();
    const hosts = ["localhost", "127.0.0.1", "[::1]", ...(o.lanHosts?.() ?? [])];
    const ports = [port, ...(o.devPorts ?? DEV_ORIGIN_PORTS)].filter((p) => p > 0);
    for (const h of hosts) for (const p of ports) set.add(`http://${h}:${p}`.toLowerCase());
    for (const x of [o.publicBaseUrl ?? "", ...(o.extra ?? [])]) {
      const n = x.trim() ? originOf(x.trim()) : null;
      if (n) set.add(n);
    }
    return set;
  };
  return {
    allowed(origin, host) {
      const n = originOf(origin);
      if (!n) return false;
      if (fixed().has(n)) return true;
      // Same origin as the Host this request was sent to, for a loopback or LAN Host only (a public
      // Host would let a DNS-rebinding page pass; those are refused by the trust check anyway).
      if (host && hostIsLocal(host, o.extraLanHosts)) return n === `http://${host.toLowerCase()}` || n === `https://${host.toLowerCase()}`;
      return false;
    },
    list: () => [...fixed()],
  };
}

export type GateDecision = { allow: true; public: boolean } | { allow: false; public: boolean; reason: string; status?: number; error?: string };

const STATIC_PREFIXES = ["/tv", "/p", "/sim"];
const under = (path: string, p: string) => path === p || path.startsWith(`${p}/`);

// HTTP requests (not upgrades). `path` is the parsed pathname (WHATWG URL: dot segments resolved).
export function gateHttp(req: IncomingMessage, path: string, tokens: GateTokens, opts: GateOptions | string[] = {}): GateDecision {
  const o = gopts(opts);
  const method = req.method ?? "GET";
  const pub = isPublicRequest(req, o);
  const origin = req.headers.origin;
  if (origin !== undefined && !(o.origins?.allowed(origin, req.headers.host) ?? false)) {
    const staticLoad = (method === "GET" || method === "HEAD") && STATIC_PREFIXES.some((p) => under(path, p));
    const bearer = under(path, "/mcp") && bearerOk(req.headers.authorization, tokens.mcpToken);
    // A browser's CORS preflight never carries Authorization, so the /mcp preflight is answered for
    // any Origin (it returns no data); the request that follows still needs the bearer.
    const mcpPreflight = method === "OPTIONS" && under(path, "/mcp");
    if (!staticLoad && !bearer && !mcpPreflight) return { allow: false, public: pub, reason: "this Origin may not call the hub", status: 403, error: "forbidden_origin" };
  }
  if (!pub) return { allow: true, public: false };
  if (path === "/alexa" && method === "POST") return { allow: true, public: true };
  if ((under(path, "/p") || under(path, "/sim")) && (method === "GET" || method === "HEAD")) return { allow: true, public: true };
  if (under(path, "/mcp")) {
    if (method === "OPTIONS") return { allow: true, public: true };
    if (bearerOk(req.headers.authorization, tokens.mcpToken)) return { allow: true, public: true };
    return { allow: false, public: true, reason: "mcp needs Authorization: Bearer <MCP_TOKEN>" };
  }
  return { allow: false, public: true, reason: "not reachable through a public tunnel" };
}

// The pair token offered as a WebSocket subprotocol ("k.<base64url>", next to WS_PROTOCOL), or null.
export function protocolToken(header: string | string[] | undefined): string | null {
  const all = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((s) => s.trim());
  const t = all.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  if (!t) return null;
  const v = Buffer.from(t.slice(WS_TOKEN_PREFIX.length), "base64url").toString("utf8");
  return v || null;
}

export type UpgradeDecision = { allow: true; public: boolean; authenticated: boolean } | { allow: false; public: boolean; reason: string; path: string };

// `authenticated`: the peer presented the pair token, or it is trusted and its Origin is allowed or
// absent. Only authenticated peers get the pair token back in welcome.joinUrl.
export function gateUpgrade(req: IncomingMessage, tokens: GateTokens, opts: GateOptions | string[] = {}): UpgradeDecision {
  const o = gopts(opts);
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://hub");
  } catch {
    return { allow: false, public: true, reason: "unparseable request target", path: "?" };
  }
  const pub = isPublicRequest(req, o);
  if (url.pathname !== "/ws") return { allow: false, public: pub, reason: "no upgrade here", path: url.pathname };
  const tokenOk = tokenEquals(url.searchParams.get("k"), tokens.pairToken) || tokenEquals(protocolToken(req.headers["sec-websocket-protocol"]), tokens.pairToken);
  const origin = req.headers.origin;
  const originOk = origin === undefined || (o.origins?.allowed(origin, req.headers.host) ?? false);
  if (!originOk && !tokenOk) return { allow: false, public: pub, reason: "ws from a foreign Origin needs the pair token", path: url.pathname };
  if (pub && !tokenOk) return { allow: false, public: true, reason: "ws needs the pair token", path: url.pathname };
  return { allow: true, public: pub, authenticated: tokenOk || (!pub && originOk) };
}

// Runs before the bridge's own upgrade listener. A refused upgrade is answered 403 and destroyed, and
// its request target is rewritten so the bridge (which parses it unguarded) skips it. `decisions`
// records each accepted upgrade for the bridge guard (src/hub/bridgeGuard.ts).
export function installUpgradeGate(server: Server, tokens: GateTokens, log: (event: string, data?: Record<string, unknown>) => void, opts: GateOptions | string[] = {}, decisions?: WeakMap<IncomingMessage, UpgradeDecision>) {
  const listener = (req: IncomingMessage, socket: Duplex) => {
    let g: UpgradeDecision;
    try {
      g = gateUpgrade(req, tokens, opts);
    } catch {
      g = { allow: false, public: true, reason: "gate error", path: "?" };
    }
    if (g.allow) {
      decisions?.set(req, g);
      return;
    }
    req.url = "/__refused";
    log("gate.denied", { path: g.path, upgrade: true, reason: g.reason });
    try {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n{\"error\":\"forbidden\"}");
    } catch {
      /* already closed */
    }
    socket.destroy();
  };
  server.prependListener("upgrade", listener);
  return () => server.off("upgrade", listener);
}
