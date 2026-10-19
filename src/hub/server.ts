// Coach hub server: HTTP API + the tv-voice-bridge WebSocket hub (/ws) + Server-Sent Events.
//
//   npm run hub                       # live (port 8791): real gitignored data, spawned `bee stream`, Bee CLI
//   npm run hub -- --demo             # demo: synthetic fixtures + Bee replay (no Watch, no network)
//   npm run hub -- --demo --pace 0.1  # demo with Bee replay and timeouts 10x faster
//   npm run hub -- --no-bee           # live without the stream (attempts end "unverified")
//   npm run hub -- --demo --fixture-v2  # demo, and the v2 live routes answer from fixtures/contract-v2/
//   npm run hub -- --lan              # trust other devices on the LAN like this machine (real Fire TV stick)
//
// Logs are JSON lines with event names and ids only: never transcript text, never the Bee token,
// never a gate token. docs/CONTRACT.md is the contract for every endpoint and event.
//
// Request order: the public-access gate (gate.ts), fixture mode, the plugins (plugins.ts) for
// their prefixes, the generic OPTIONS answer, the v1 core routes, then 404.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { BridgeHub, type Room } from "tv-voice-bridge/hub";
import type { AppMsg, PeerInfo } from "tv-voice-bridge";
import { buildBrief } from "./brief.js";
import { parseHabitKey } from "./habits.js";
import { parseRange, parseSource } from "./stats.js";
import { demoSetup, liveSetup, type Setup } from "./setup.js";
import { DEMO_SCENARIOS, type DemoScenario } from "./demoData.js";
import type { HubEvent, ProvisionalSource } from "./core.js";
import { CONTRACT_VERSION, ROOM_RELAY_MAX_HZ, ROOM_TOPICS, type PluginInfo, type RoomTopic } from "./contract.js";
import { addressKind, bearerOk, gateHttp, installUpgradeGate, isPublicRequest, mustAuthenticate, originPolicy, PUBLIC_ROUTES, resolveTokens, tokenEquals, tunnelWarning, type GateOptions, type GateTokens, type UpgradeDecision } from "./gate.js";
import { guardBridge } from "./bridgeGuard.js";
import { installProcessGuards, killChildren } from "./processGuards.js";
import { underPrefix, type HubPlugin, type PluginCtx } from "./plugin.js";
import { createPlugins } from "./plugins.js";
import { createFixtureRouter } from "./fixtureV2.js";
import { serveHome, type HomeStatus } from "./home.js";

export { CONTRACT_VERSION };
export const DEFAULT_PORT = 8791; // Rack Board uses 8792, the bridge example 8800

export interface HubServerOptions {
  demo?: boolean;
  port?: number; // 0 = any free port
  host?: string;
  pace?: number;
  bee?: boolean;
  stateDir?: string | null;
  quiet?: boolean;
  setup?: Setup; // inject (tests)
  fixtureV2?: boolean; // demo only: the v2 live routes answer from fixtures/contract-v2/
  plugins?: HubPlugin[]; // inject (tests); default: the fixed registry (plugins.ts)
  pairToken?: string; // default: env PAIR_TOKEN, else saved in <stateDir>/tokens.json or generated
  mcpToken?: string; // default: env MCP_TOKEN, else saved in <stateDir>/tokens.json or generated
  rotateTokens?: boolean; // ignore the saved tokens and generate new ones (CLI --rotate-tokens)
  publicBaseUrl?: string | null; // default: env PUBLIC_BASE_URL (the tunnel's https origin)
  extraLanHosts?: string[]; // more Host names to treat as LAN (tests)
  trustLan?: boolean; // trust LAN devices like loopback (default: env HUB_TRUST_LAN=1, else false)
  allowedOrigins?: string[]; // extra browser origins (default: env HUB_ALLOWED_ORIGINS, comma-separated)
  roomGraceMs?: number; // a room with no screen is closed after this (default 60 s; tests)
}

export interface HubServer {
  url: string;
  port: number;
  setup: Setup;
  plugins: HubPlugin[];
  tokens: GateTokens; // in-process only (tests); never served
  close(): Promise<void>;
}

// The first LAN IPv4 address. Container and VM bridges (docker0, br-*, veth*, virbr*, vboxnet*) are
// skipped by interface name, so a 172.16/12 Wi-Fi or hotspot address still qualifies.
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vboxnet|vmnet|cni|flannel|podman|lxc|lxd|tailscale|utun|zt)/i;
export function lanIp(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return "127.0.0.1";
}

// A JSON object body, at most 64 kB. Chunks are joined as bytes before decoding, so a multi-byte
// character split across chunks survives.
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    n += b.length;
    if (n > 64_000) throw new Error("body too large");
    parts.push(b);
  }
  const s = Buffer.concat(parts).toString("utf8");
  if (!s.trim()) return {};
  const o = JSON.parse(s);
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

const SOURCES = new Set<ProvisionalSource>(["phone", "alexa", "mcp", "typed"]);

export async function startHubServer(opts: HubServerOptions = {}): Promise<HubServer> {
  const log = (event: string, data: Record<string, unknown> = {}) => {
    if (!opts.quiet) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  };
  // Validate the options before anything spawns a child (`bee stream`) or a timer.
  if (opts.fixtureV2 && !opts.demo && !opts.setup) throw new Error("--fixture-v2 needs --demo (fixture payloads are synthetic)");
  const setup = opts.setup ?? (opts.demo ? demoSetup({ pace: opts.pace, stateDir: opts.stateDir }) : await liveSetup({ bee: opts.bee, stateDir: opts.stateDir ?? undefined, log }));
  try {
    return await startWithSetup(opts, setup, log);
  } catch (err) {
    if (!opts.setup) setup.stop();
    throw err;
  }
}

async function startWithSetup(opts: HubServerOptions, setup: Setup, log: (event: string, data?: Record<string, unknown>) => void): Promise<HubServer> {
  const { hub } = setup;
  const sse = new Set<ServerResponse>();
  if (opts.fixtureV2 && !setup.demo) throw new Error("--fixture-v2 needs --demo (fixture payloads are synthetic)");
  const print = (line: string) => {
    if (!opts.quiet) console.log(line);
  };
  const tokens = resolveTokens({ PAIR_TOKEN: opts.pairToken ?? process.env.PAIR_TOKEN, MCP_TOKEN: opts.mcpToken ?? process.env.MCP_TOKEN }, print, setup.stateDir ? join(setup.stateDir, "tokens.json") : null, { rotate: !!opts.rotateTokens });
  const publicBaseUrl = ((opts.publicBaseUrl === undefined ? process.env.PUBLIC_BASE_URL : opts.publicBaseUrl) ?? "").trim().replace(/\/+$/, "") || null;
  const extraLanHosts = opts.extraLanHosts ?? [];
  const trustLan = opts.trustLan ?? process.env.HUB_TRUST_LAN === "1";
  const plugins = opts.plugins ?? createPlugins();
  let listeningPort = 0;
  const lanHosts = () => {
    const me = hostname().toLowerCase();
    return [...new Set([lanIp(), me, me.split(".")[0]!, `${me.split(".")[0]}.local`])];
  };
  const origins = originPolicy({
    port: () => listeningPort,
    publicBaseUrl,
    lanHosts,
    extra: opts.allowedOrigins ?? (process.env.HUB_ALLOWED_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    extraLanHosts,
  });
  const gateOpts: GateOptions = { extraLanHosts, trustLan, origins, tunnel: !!publicBaseUrl };
  // The address the in-process hub client (Alexa, MCP) dials: loopback unless bound to one address.
  const selfHost = !opts.host || opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;

  // No wildcard CORS: an allowed Origin is echoed by handle() before routing (res.setHeader), so the
  // JSON writer, SSE and the plugins all inherit it.
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data, null, 1));
  };
  const fail = (res: ServerResponse, status: number, error: string, message: string) => send(res, status, { error, message });
  const pathOf = (u: string | undefined) => {
    try {
      return new URL(u ?? "/", "http://hub").pathname;
    } catch {
      return "?";
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("http.error", { path: pathOf(req.url), error: String((err as Error)?.message ?? err) });
      if (!res.headersSent) fail(res, 400, "bad_request", String((err as Error)?.message ?? err));
      else if (!res.writableEnded) res.end();
    });
  });

  // App callbacks never throw into the bridge (a throw there used to be an unhandled rejection).
  const guarded =
    <A extends unknown[], R>(name: string, fallback: R, f: (...a: A) => R) =>
    (...a: A): R => {
      try {
        return f(...a);
      } catch (err) {
        log("bridge.callback-error", { callback: name, error: String((err as Error)?.message ?? err) });
        return fallback;
      }
    };

  // The bridge closes a room that has had no screen for ROOM_GRACE_MS (a TV that reconnects in time
  // keeps its code) and calls onRoomClose, which drops the room's relay state here. One lifetime, the
  // bridge's: it logs room-close and counts roomsExpired.
  const ROOM_GRACE_MS = opts.roomGraceMs ?? 60_000;
  const dropRoomState = (code: string) => {
    for (const k of [...lastRelay.keys()]) if (k.startsWith(`${code}:`)) lastRelay.delete(k);
    for (const [k, t] of trailing) if (k.startsWith(`${code}:`)) (clearTimeout(t.timer), trailing.delete(k));
  };

  const baseJoinUrl = (code: string) => `${publicBaseUrl ?? `http://${lanIp()}:${listeningPort || ((server.address() as { port: number } | null)?.port ?? 0)}`}/p/${code}`;
  const bridge = new BridgeHub({
    server,
    path: "/ws",
    clock: hub.clock,
    joinUrl: baseJoinUrl, // ?k= is added only for authenticated peers (bridgeGuard.ts)
    log: (event, data) => log(`bridge.${event}`, data),
    roomGraceMs: ROOM_GRACE_MS,
    // Behind ngrok every peer arrives from the tunnel's loopback socket, so key the hello and
    // wrong-code limits on the client address ngrok appends (the last x-forwarded-for entry). Only a
    // loopback socket (the tunnel agent) may name it: a direct peer that sends its own header is
    // keyed on its socket, so a fresh header per upgrade buys no fresh budget (review L40).
    rateKey: (req) => {
      const addr = req.socket.remoteAddress ?? "unknown";
      if (addressKind(addr) !== "loopback") return addr;
      const xff = req.headers["x-forwarded-for"];
      const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop();
      return last ? `fwd:${last}` : addr;
    },
    onRoomClose: guarded("onRoomClose", undefined, (room: Room) => dropRoomState(room.code)),
    onJoin: guarded("onJoin", undefined, (room: Room, peer: PeerInfo) => {
      const p = room.peers.get(peer.clientId);
      if (p) bridge.send(p.socket, { type: "app", topic: "hub.state", payload: { seq: 0, at: hub.clock(), ...stateSnapshot() } });
    }),
    onFinal: guarded("onFinal", null, (_room: Room, msg: { text: string; hops: { hop: string; at: number }[] }) => {
      const speechEnd = msg.hops.find((h) => h.hop === "speech.end")?.at;
      const r = hub.submit({ text: msg.text, source: "phone", speechEndAt: speechEnd });
      if ("error" in r) return { name: "attempt.rejected", ok: false, payload: { error: r.error, message: "open a card first" } };
      return { name: "attempt.provisional", ok: r.provisional!.grade.pass, payload: { attemptId: r.id, cardId: r.cardId, status: r.status, provisionalPass: r.provisional!.grade.pass } };
    }),
    onApp: guarded("onApp", null, (room: Room, msg: AppMsg, from: PeerInfo) => {
      const p = (msg.payload ?? {}) as Record<string, unknown>;
      const by = from.name ?? from.role;
      switch (msg.topic) {
        case "card.request": {
          const c = hub.openCard({ cardId: typeof p.cardId === "string" ? p.cardId : undefined, by });
          return { name: "card.request", ok: !!c, payload: { card: c } };
        }
        case "attempt.submit": {
          if (typeof p.text !== "string") return { name: "attempt.rejected", ok: false, payload: { error: "bad_request", message: "text is required" } };
          const src = SOURCES.has(p.source as ProvisionalSource) ? (p.source as ProvisionalSource) : "typed";
          const r = hub.submit({ text: p.text, source: src, cardId: typeof p.cardId === "string" ? p.cardId : undefined });
          if ("error" in r) return { name: "attempt.rejected", ok: false, payload: { error: r.error } };
          return { name: "attempt.provisional", ok: r.provisional!.grade.pass, payload: { attemptId: r.id, cardId: r.cardId, status: r.status } };
        }
        case "session.start":
          return { name: "session.start", ok: true, payload: hub.startSession({ by, size: typeof p.size === "number" ? p.size : undefined }) };
        case "session.next":
          return { name: "session.next", ok: true, payload: hub.nextInSession() };
        case "session.end":
          return { name: "session.end", ok: true, payload: { summary: hub.endSession() } };
        default:
          for (const pl of plugins) {
            if (!pl.onApp) continue;
            const r = pl.onApp(room, msg, from, ctx);
            if (r !== undefined) return r;
          }
          return null;
      }
    }),
  });
  const upgrades = new WeakMap<IncomingMessage, UpgradeDecision>();
  const removeUpgradeGate = installUpgradeGate(server, tokens, log, gateOpts, upgrades);
  const guard = guardBridge(bridge, { log, decisions: upgrades, withToken: (u) => `${u}#k=${encodeURIComponent(tokens.pairToken)}` }); // a fragment: never sent to a server or logged by a tunnel

  // Room-scoped relay: one room's screens only, at most ROOM_RELAY_MAX_HZ per room and topic. A frame
  // inside the window is not lost: the latest one is sent when the window ends (trailing edge).
  const lastRelay = new Map<string, number>();
  const trailing = new Map<string, { timer: ReturnType<typeof setTimeout>; payload: unknown }>();
  const relayTo = (r: Room, topic: RoomTopic, payload: unknown) => {
    let n = 0;
    for (const p of r.peers.values()) if (p.role === "screen") (bridge.send(p.socket, { type: "app", topic, payload }), n++);
    return n;
  };
  const broadcastToScreens = (room: Room | string | null, topic: RoomTopic, payload: unknown): number => {
    if (!(ROOM_TOPICS as readonly string[]).includes(topic)) throw new Error(`${topic} is not a room topic`);
    const rooms = room == null ? [...bridge.rooms.values()] : [typeof room === "string" ? bridge.rooms.get(room.toUpperCase()) : room].filter((r): r is Room => !!r);
    let n = 0;
    const gap = 1000 / ROOM_RELAY_MAX_HZ;
    for (const r of rooms) {
      const key = `${r.code}:${topic}`;
      const now = Date.now();
      const wait = gap - (now - (lastRelay.get(key) ?? -Infinity));
      if (wait > 0) {
        const held = trailing.get(key);
        if (held) held.payload = payload;
        else {
          const entry = { payload, timer: setTimeout(() => {
            trailing.delete(key);
            lastRelay.set(key, Date.now());
            if (bridge.rooms.get(r.code) === r) relayTo(r, topic, entry.payload);
          }, wait) };
          entry.timer.unref?.();
          trailing.set(key, entry);
        }
        continue;
      }
      lastRelay.set(key, now);
      n += relayTo(r, topic, payload);
    }
    return n;
  };

  const ctx: PluginCtx = {
    hub,
    setup,
    bridge,
    stateDir: setup.stateDir,
    pace: setup.pace,
    demo: !!setup.demo,
    fixtureV2: !!opts.fixtureV2,
    log,
    publish: (topic, data) => hub.publish(topic, data),
    broadcastToScreens,
    selfUrl: () => `http://${selfHost}:${listeningPort}`,
    auth: { mcpBearerOk: (h) => bearerOk(h, tokens.mcpToken), pairTokenOk: (k) => tokenEquals(k, tokens.pairToken) },
    isPublic: (req) => mustAuthenticate(req, gateOpts),
    json: (res, status, data) => send(res, status, data),
    readJson: (req) => body(req),
  };
  for (const pl of plugins) pl.attach?.(ctx);
  const fixture = opts.fixtureV2 ? createFixtureRouter(ctx) : null;
  const pluginInfo = (): PluginInfo[] =>
    plugins.map((pl) => {
      const d = pl.describe?.() ?? { owner: "unknown", status: "ready" as const, routes: [] };
      return { name: pl.name, prefixes: pl.prefixes, ...d, ...(fixture && fixture.owns(pl.name) ? { status: "stub" as const, note: `fixture mode: ${fixture.routes.join(", ")} answer from fixtures/contract-v2/` } : {}) };
    });

  // Fan every hub event out to every bridge peer (all rooms, all roles) and every SSE client.
  hub.on("event", (ev: HubEvent) => {
    log("hub.event", { topic: ev.topic, seq: ev.payload.seq, attemptId: (ev.payload.attempt as { id?: string } | undefined)?.id ?? ev.payload.attemptId, cardId: (ev.payload.card as { id?: string } | undefined)?.id ?? ev.payload.cardId, status: ev.payload.status });
    for (const room of bridge.rooms.values()) bridge.broadcast(room, { type: "app", topic: ev.topic, payload: ev.payload });
    const frame = `event: ${ev.topic}\nid: ${ev.payload.seq}\ndata: ${JSON.stringify(ev.payload)}\n\n`;
    for (const res of sse) sseWrite(res, frame);
  });
  // A change with no contract topic (a lone card closed for idling): every peer rebases on a fresh
  // hub.state, the same frame a join gets.
  hub.on("state.changed", (why: { reason: string; cardId?: string }) => {
    log("hub.state-changed", why);
    const payload = { seq: 0, at: hub.clock(), ...stateSnapshot() };
    for (const room of bridge.rooms.values()) bridge.broadcast(room, { type: "app", topic: "hub.state", payload });
    const frame = `event: hub.state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sse) sseWrite(res, frame);
  });
  // An SSE client that stops reading is dropped once 1 MB is queued for it.
  const sseWrite = (res: ServerResponse, frame: string) => {
    if (res.writableLength > 1_000_000) {
      sse.delete(res);
      log("sse.backpressure", { action: "end", queued: res.writableLength });
      res.destroy();
      return;
    }
    res.write(frame);
  };

  const stateSnapshot = () => ({ mode: hub.mode, dataLabel: hub.dataLabel, bootId: hub.bootId, lastSeq: hub.lastSeq, ...hub.sessionState() });
  // The home page's status line (home.ts): never a token, only counts and a TV's pair code.
  const homeStatus = (): HomeStatus => {
    const rooms = [...bridge.rooms.values()];
    const roles = (r: (typeof rooms)[number], role: string) => [...r.peers.values()].filter((p) => p.role === role).length;
    const tv = rooms.find((r) => roles(r, "screen") > 0);
    const beeStream = String(setup.describe.beeStream ?? "");
    return {
      demo: !!setup.demo,
      dataLabel: setup.demo ? hub.dataLabel : null,
      bee: setup.demo ? "replay" : beeStream.startsWith("bee stream") ? "live" : "off",
      pairCode: tv?.code ?? null,
      screens: rooms.reduce((n, r) => n + roles(r, "screen"), 0),
      phones: rooms.reduce((n, r) => n + roles(r, "mic"), 0),
      drillsDue: hub.deckSummary().dueNow,
    };
  };

  let ticking = false;
  const tick = setInterval(() => {
    try {
      hub.expireIdle();
      hub.verifier.purge(); // outside the guard: a hung poll must not keep other speakers' text in memory
    } catch (err) {
      log("hub.expire-error", { error: String((err as Error)?.message ?? err) });
    }
    if (ticking) return;
    ticking = true;
    hub.verifier
      .tick()
      .catch((err) => log("verifier.tick-error", { error: String((err as Error)?.message ?? err) }))
      .finally(() => (ticking = false));
  }, 100);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://hub");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const g = gateHttp(req, path, tokens, gateOpts);
    res.setHeader("vary", "origin");
    if (!g.allow) {
      log("gate.denied", { method, path, reason: g.reason, ...(g.error ? { origin: true } : {}) });
      return fail(res, g.status ?? 403, g.error ?? "forbidden", g.reason);
    }
    const origin = req.headers.origin;
    // an allowed Origin, or /mcp from any Origin with the bearer (or its preflight, which carries none)
    const mcpOk = underPrefix(path, "/mcp") && (method === "OPTIONS" || bearerOk(req.headers.authorization, tokens.mcpToken));
    if (origin && (origins.allowed(origin, req.headers.host) || mcpOk)) res.setHeader("access-control-allow-origin", origin);
    if (fixture && (await fixture.route(req, res, url))) return;
    for (const pl of plugins) {
      if (!pl.route || !pl.prefixes.some((px) => underPrefix(path, px))) continue;
      try {
        if (await pl.route(req, res, url, ctx)) return;
      } catch (err) {
        log("plugin.error", { plugin: pl.name, path, error: (err as Error).message });
        if (!res.headersSent) return fail(res, 500, "plugin_error", `${pl.name}: ${(err as Error).message}`);
        return void res.end();
      }
    }
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
        "access-control-expose-headers": "mcp-session-id",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    const route = `${method} ${path}`;
    const attemptMatch = method === "GET" ? /^\/api\/attempts\/([\w-]+)$/.exec(path) : null;
    if (attemptMatch) {
      const v = hub.verdict(attemptMatch[1]!);
      return v ? send(res, 200, v) : fail(res, 404, "unknown_attempt", `no attempt ${attemptMatch[1]}`);
    }
    switch (route) {
      case "GET /":
      case "HEAD /":
        return serveHome(req, res, homeStatus());
      case "GET /api/health":
        return send(res, 200, {
          ok: true,
          contractVersion: CONTRACT_VERSION,
          ...setup.describe,
          dataLabel: hub.dataLabel,
          now: new Date(hub.clock()).toISOString(),
          bee: hub.sessionState().bee,
          ws: "/ws",
          sse: "/api/events",
          fixtureV2: !!fixture,
          publicBaseUrl,
          plugins: pluginInfo(),
          gate: { publicRoutes: PUBLIC_ROUTES, pairToken: tokens.source.pair, mcpToken: tokens.source.mcp },
        });
      case "GET /api/state":
      case "GET /api/session":
        return send(res, 200, { ...stateSnapshot(), lastSessionSummary: hub.lastSession ? hub.sessionSummary(hub.lastSession) : null, currentSessionSummary: hub.session ? hub.sessionSummary(hub.session) : null });
      case "GET /api/deck": {
        const today = hub.today();
        return send(res, 200, { dataLabel: hub.dataLabel, summary: hub.deckSummary(), cards: hub.deck.cards.map((c) => hub.view(c)).sort((a, b) => Number(b.dueNow) - Number(a.dueNow) || a.box - b.box), today });
      }
      case "GET /api/deck/next": {
        const c = hub.nextCard();
        return send(res, 200, { card: c ? hub.view(c) : null, open: hub.sessionState().openCard, summary: hub.deckSummary() });
      }
      case "POST /api/card/open": {
        const b = await body(req);
        if (b.cardId !== undefined && (typeof b.cardId !== "string" || !hub.card(b.cardId))) return fail(res, 404, "unknown_card", `no card ${String(b.cardId)}`);
        const c = hub.openCard({ cardId: b.cardId as string | undefined, by: typeof b.by === "string" ? b.by : "http" });
        return c ? send(res, 200, { card: c }) : fail(res, 404, "nothing_due", "no card is due; pass a cardId to practise one anyway");
      }
      case "POST /api/attempt": {
        const b = await body(req);
        if (typeof b.text !== "string" || !b.text.trim()) return fail(res, 400, "bad_request", "text (string) is required");
        const source = (b.source ?? "typed") as ProvisionalSource;
        if (!SOURCES.has(source)) return fail(res, 400, "bad_request", "source must be phone, alexa, mcp or typed (Bee attempts arrive through the stream)");
        if (b.beeScenario !== undefined) {
          if (!setup.demo) return fail(res, 400, "demo_only", "beeScenario is only accepted in demo mode");
          if (!(String(b.beeScenario) in DEMO_SCENARIOS)) return fail(res, 400, "bad_request", `beeScenario must be one of ${Object.keys(DEMO_SCENARIOS).join(", ")}`);
          setup.demo.forceNext = b.beeScenario as DemoScenario;
        }
        const r = hub.submit({ text: b.text, source, cardId: typeof b.cardId === "string" ? b.cardId : undefined, speechEndAt: typeof b.speechEndAt === "number" ? b.speechEndAt : undefined });
        if (setup.demo && "error" in r) setup.demo.forceNext = null;
        if ("error" in r) return fail(res, r.error === "unknown_card" ? 404 : 409, r.error, r.error === "no_open_card" ? "open a card first (POST /api/card/open or /api/session/start)" : "unknown cardId");
        return send(res, 202, { attempt: r, narration: hub.sessionState().narration, verdictUrl: `/api/attempts/${r.id}`, retryAfterMs: hub.retryAfterMs(r) });
      }
      case "GET /api/attempts": {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 20) || 20));
        return send(res, 200, { attempts: hub.attempts.slice(-limit).reverse() });
      }
      case "POST /api/session/start": {
        const b = await body(req);
        const r = hub.startSession({ by: typeof b.by === "string" ? b.by : "http", size: typeof b.size === "number" ? b.size : undefined });
        return send(res, 200, { ...r, narration: hub.sessionState().narration });
      }
      case "POST /api/session/next":
        return send(res, 200, { ...hub.nextInSession(), narration: hub.sessionState().narration });
      case "POST /api/session/end":
        return send(res, 200, { summary: hub.endSession() });
      case "GET /api/stats": {
        const range = parseRange(url.searchParams.get("range"));
        const source = parseSource(url.searchParams.get("source"));
        if (!range) return fail(res, 400, "bad_range", "range must be today, week, all, session:<id> or meeting:<id>");
        if (!source) return fail(res, 400, "bad_source", "source must be bee (default) or all");
        return send(res, 200, hub.stats(range, source));
      }
      case "GET /api/transfer": {
        const source = parseSource(url.searchParams.get("source"));
        if (!source) return fail(res, 400, "bad_source", "source must be bee (default) or all");
        const t = hub.transfer(source);
        if (!t) return fail(res, 503, "no_prereg", "prereg/transfer.json is missing: pre-register drilled and control habits first");
        const habit = url.searchParams.get("habit");
        if (habit) {
          if (!parseHabitKey(habit)) return fail(res, 400, "bad_habit", "unknown habit key");
          const h = t.habits.find((x) => x.habit === habit);
          if (!h) return send(res, 422, { error: "not_preregistered", message: `"${habit}" is not pre-registered as drilled or control, so no transfer result is reported for it`, prereg: t.prereg });
          return send(res, 200, { ...t, habits: [h] });
        }
        return send(res, 200, t);
      }
      case "GET /api/brief":
        return send(res, 200, await buildBrief(hub, setup.calendar));
      case "GET /api/events/recent":
        return send(res, 200, { events: hub.recent });
      case "GET /api/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: hub.state\ndata: ${JSON.stringify({ seq: 0, at: hub.clock(), ...stateSnapshot() })}\n\n`);
        sse.add(res);
        const ka = setInterval(() => sseWrite(res, ": keepalive\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ka);
          sse.delete(res);
        });
        return;
      }
      case "POST /api/demo/scenario": {
        if (!setup.demo) return fail(res, 400, "demo_only", "only in demo mode");
        const b = await body(req);
        if (!(String(b.scenario) in DEMO_SCENARIOS)) return fail(res, 400, "bad_request", `scenario must be one of ${Object.keys(DEMO_SCENARIOS).join(", ")}`);
        setup.demo.forceNext = b.scenario as DemoScenario;
        return send(res, 200, { replay: true, nextAttemptScenario: b.scenario, description: DEMO_SCENARIOS[b.scenario as DemoScenario] });
      }
      case "POST /api/demo/bee": {
        if (!setup.demo) return fail(res, 400, "demo_only", "only in demo mode");
        const b = await body(req);
        const r = setup.demo.replayBeeOnly(typeof b.text === "string" ? b.text : undefined);
        return r ? send(res, 202, { replay: true, scheduled: "new-utterance at +5.4 s, tagged-utterance at +5.9 s (scaled by --pace)", ...r }) : fail(res, 409, "no_open_card", "open a card first");
      }
      default:
        return fail(res, 404, "not_found", `${route} is not in the contract (docs/CONTRACT.md)`);
    }
  }

  const wantPort = opts.port ?? Number(process.env.COACH_PORT ?? DEFAULT_PORT);
  const bindHost = opts.host ?? "0.0.0.0";
  const closeAll = () => {
    clearInterval(tick);
    for (const t of trailing.values()) clearTimeout(t.timer);
    trailing.clear();
    fixture?.stop();
    for (const pl of plugins) {
      try {
        pl.stop?.();
      } catch (err) {
        log("plugin.stop-error", { plugin: pl.name, error: String((err as Error)?.message ?? err) });
      }
    }
    hub.dispose();
    setup.stop();
    for (const r of sse) r.end();
    sse.clear();
    bridge.close();
    removeUpgradeGate();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantPort, bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    closeAll();
    throw new Error((err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${wantPort} is already in use: pass --port <n> or set COACH_PORT` : (err as Error).message);
  }
  const port = (server.address() as { port: number }).port;
  listeningPort = port;
  log("hub.listening", { port, ...setup.describe, fixtureV2: !!fixture, plugins: plugins.map((pl) => pl.name), trustLan, bridgeGuard: guard.installed });
  if (publicBaseUrl) print(tunnelWarning(publicBaseUrl, port));
  print(`hub: open the TV at http://localhost:${port}/tv/ and the Alexa+ simulator at http://localhost:${port}/sim/${publicBaseUrl ? "#t=<MCP_TOKEN> (a tunnel is set, so MCP needs the token here too)" : ""} ; pair a phone by scanning the TV's QR.`);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setup,
    plugins,
    tokens,
    close: async () => {
      closeAll();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// CLI
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const plog = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  installProcessGuards(plog);
  const s = await startHubServer({
    demo: args.includes("--demo"),
    port: opt("--port") !== undefined ? Number(opt("--port")) : undefined,
    host: opt("--host"),
    pace: opt("--pace") !== undefined ? Number(opt("--pace")) : undefined,
    bee: !args.includes("--no-bee"),
    stateDir: opt("--state-dir"),
    fixtureV2: args.includes("--fixture-v2"),
    trustLan: args.includes("--lan") ? true : undefined,
    rotateTokens: args.includes("--rotate-tokens"),
  }).catch((err) => {
    console.error(`hub: ${(err as Error).message}`);
    killChildren("SIGKILL");
    process.exit(1);
  });
  // First signal: close cleanly (children get SIGTERM, then SIGKILL after 2 s), at most 5 s.
  // A second signal exits at once.
  let stopping = false;
  const stop = () => {
    if (stopping) {
      killChildren("SIGKILL");
      process.exit(130);
    }
    stopping = true;
    setTimeout(() => (killChildren("SIGKILL"), process.exit(0)), 5000).unref();
    void s
      .close()
      .catch((err) => plog("hub.close-error", { error: String((err as Error)?.message ?? err) }))
      .then(() => {
        killChildren();
        process.exit(0);
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}
