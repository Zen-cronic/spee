// Coach hub server: HTTP API + the tv-voice-bridge WebSocket hub (/ws) + Server-Sent Events.
//
//   npm run hub                       # live (port 8791): real gitignored data, spawned `bee stream`, Bee CLI
//   npm run hub -- --demo             # demo: synthetic fixtures + Bee replay (no Watch, no network)
//   npm run hub -- --demo --pace 0.1  # demo with Bee replay and timeouts 10x faster
//   npm run hub -- --no-bee           # live without the stream (attempts end "unverified")
//
// Logs are JSON lines with event names and ids only: never transcript text, never the Bee token.
// docs/CONTRACT.md is the contract for every endpoint and event.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { BridgeHub, type Room } from "@rackboard/tv-voice-bridge/hub";
import type { PeerInfo } from "@rackboard/tv-voice-bridge";
import { buildBrief } from "./brief.js";
import { parseHabitKey } from "./habits.js";
import { parseRange, parseSource } from "./stats.js";
import { demoSetup, liveSetup, type Setup } from "./setup.js";
import { DEMO_SCENARIOS, type DemoScenario } from "./demoData.js";
import type { HubEvent, ProvisionalSource } from "./core.js";

export const CONTRACT_VERSION = 1;
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
}

export interface HubServer {
  url: string;
  port: number;
  setup: Setup;
  close(): Promise<void>;
}

function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && !i.address.startsWith("172.")) return i.address;
  return "127.0.0.1";
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 64_000) throw new Error("body too large");
  }
  if (!s.trim()) return {};
  const o = JSON.parse(s);
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

const SOURCES = new Set<ProvisionalSource>(["phone", "alexa", "typed"]);

export async function startHubServer(opts: HubServerOptions = {}): Promise<HubServer> {
  const log = (event: string, data: Record<string, unknown> = {}) => {
    if (!opts.quiet) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  };
  const setup = opts.setup ?? (opts.demo ? demoSetup({ pace: opts.pace, stateDir: opts.stateDir }) : await liveSetup({ bee: opts.bee, stateDir: opts.stateDir ?? undefined, log }));
  const { hub } = setup;
  const sse = new Set<ServerResponse>();

  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(data, null, 1));
  };
  const fail = (res: ServerResponse, status: number, error: string, message: string) => send(res, status, { error, message });

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("http.error", { path: req.url, error: (err as Error).message });
      if (!res.headersSent) fail(res, 400, "bad_request", (err as Error).message);
    });
  });

  const bridge = new BridgeHub({
    server,
    path: "/ws",
    clock: hub.clock,
    joinUrl: (code) => `http://${lanIp()}:${(server.address() as { port: number } | null)?.port ?? 0}/p/${code}`,
    log: (event, data) => log(`bridge.${event}`, data),
    onJoin: (room: Room, peer: PeerInfo) => {
      const p = room.peers.get(peer.clientId);
      if (p) bridge.send(p.socket, { type: "app", topic: "hub.state", payload: { seq: 0, at: hub.clock(), ...stateSnapshot() } });
    },
    onFinal: (_room, msg) => {
      const speechEnd = msg.hops.find((h) => h.hop === "speech.end")?.at;
      const r = hub.submit({ text: msg.text, source: "phone", speechEndAt: speechEnd });
      if ("error" in r) return { name: "attempt.rejected", ok: false, payload: { error: r.error, message: "open a card first" } };
      return { name: "attempt.provisional", ok: r.provisional!.grade.pass, payload: { attemptId: r.id, cardId: r.cardId, status: r.status, provisionalPass: r.provisional!.grade.pass } };
    },
    onApp: (_room, msg, from) => {
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
          return null;
      }
    },
  });

  // Fan every hub event out to every bridge peer (all rooms, all roles) and every SSE client.
  hub.on("event", (ev: HubEvent) => {
    log("hub.event", { topic: ev.topic, seq: ev.payload.seq, attemptId: (ev.payload.attempt as { id?: string } | undefined)?.id ?? ev.payload.attemptId, cardId: (ev.payload.card as { id?: string } | undefined)?.id ?? ev.payload.cardId, status: ev.payload.status });
    for (const room of bridge.rooms.values()) bridge.broadcast(room, { type: "app", topic: ev.topic, payload: ev.payload });
    const frame = `event: ${ev.topic}\nid: ${ev.payload.seq}\ndata: ${JSON.stringify(ev.payload)}\n\n`;
    for (const res of sse) res.write(frame);
  });

  const stateSnapshot = () => ({ mode: hub.mode, dataLabel: hub.dataLabel, ...hub.sessionState() });

  let ticking = false;
  const tick = setInterval(() => {
    if (ticking) return;
    ticking = true;
    hub.verifier.tick().finally(() => (ticking = false));
  }, 100);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://hub");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    const route = `${method} ${path}`;
    const attemptMatch = method === "GET" ? /^\/api\/attempts\/([\w-]+)$/.exec(path) : null;
    if (attemptMatch) {
      const v = hub.verdict(attemptMatch[1]!);
      return v ? send(res, 200, v) : fail(res, 404, "unknown_attempt", `no attempt ${attemptMatch[1]}`);
    }
    switch (route) {
      case "GET /api/health":
        return send(res, 200, { ok: true, contractVersion: CONTRACT_VERSION, ...setup.describe, dataLabel: hub.dataLabel, now: new Date(hub.clock()).toISOString(), bee: hub.sessionState().bee, ws: "/ws", sse: "/api/events" });
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
        if (!SOURCES.has(source)) return fail(res, 400, "bad_request", "source must be phone, alexa or typed (Bee attempts arrive through the stream)");
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
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`event: hub.state\ndata: ${JSON.stringify({ seq: 0, at: hub.clock(), ...stateSnapshot() })}\n\n`);
        sse.add(res);
        const ka = setInterval(() => res.write(": keepalive\n\n"), 15_000);
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantPort, opts.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(tick);
    setup.stop();
    bridge.close();
    throw new Error((err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${wantPort} is already in use: pass --port <n> or set COACH_PORT` : (err as Error).message);
  }
  const port = (server.address() as { port: number }).port;
  log("hub.listening", { port, ...setup.describe });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setup,
    close: async () => {
      clearInterval(tick);
      setup.stop();
      for (const r of sse) r.end();
      bridge.close();
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
  const s = await startHubServer({
    demo: args.includes("--demo"),
    port: opt("--port") !== undefined ? Number(opt("--port")) : undefined,
    host: opt("--host"),
    pace: opt("--pace") !== undefined ? Number(opt("--pace")) : undefined,
    bee: !args.includes("--no-bee"),
    stateDir: opt("--state-dir"),
  }).catch((err) => {
    console.error(`hub: ${(err as Error).message}`);
    process.exit(1);
  });
  const stop = () => void s.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
