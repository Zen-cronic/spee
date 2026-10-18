// Hub-side defences around the vendored tv-voice-bridge hub (lead-owned). The bridge package itself
// is never patched here: this wraps one BridgeHub instance from the outside.
//
// - Every WebSocket gets an `error` listener (a bad frame used to throw "Unhandled error event") and a
//   payload cap (WS_MAX_PAYLOAD).
// - Every frame is validated before the bridge sees it: field types and lengths for each message
//   type, one hello per socket, a screen's malformed room code is dropped (so it gets a fresh room
//   instead of a random code that may be someone else's), and a clientId already used in that room by
//   the other role is refused. A refused frame gets {type:"error",code:"bad-message"} and is dropped.
// - welcome.joinUrl carries ?k=<PAIR_TOKEN> only for a peer the gate marked `authenticated`
//   (src/hub/gate.ts). The joinUrl the bridge builds never has it; it is added here, so if the bridge
//   internals change and the wrapper cannot install, peers get the token-less URL (fail closed).
// - Backpressure: practice.meters frames are dropped for a peer with more than WS_DROP_METERS_AT
//   bytes queued, and a peer above WS_TERMINATE_AT is disconnected.
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { BridgeHub, Room } from "@rackboard/tv-voice-bridge/hub";
import type { UpgradeDecision } from "./gate.js";

export const WS_MAX_PAYLOAD = 256 * 1024;
export const WS_DROP_METERS_AT = 256 * 1024;
export const WS_TERMINATE_AT = 4 * 1024 * 1024;

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const normalizeCode = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const isPairingCode = (s: string) => s.length === 4 && [...s].every((c) => CODE_ALPHABET.includes(c));

type Log = (event: string, data?: Record<string, unknown>) => void;

const str = (v: unknown, max: number, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || v === null || str(v, max);
const hopsOk = (h: unknown) =>
  h === undefined || (Array.isArray(h) && h.length <= 32 && h.every((x) => !!x && typeof x === "object" && str((x as { hop?: unknown }).hop, 64, 1) && Number.isFinite((x as { at?: unknown }).at)));

export type FrameCheck = { ok: true; rewritten?: string } | { ok: false; reason: string };

// One inbound frame, before the bridge decodes it. Unparseable JSON and unknown types pass through:
// the bridge answers those with bad-message itself, without throwing.
export function checkFrame(text: string, st: { helloed: boolean }, rooms?: Map<string, Room>): FrameCheck {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return { ok: true };
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: true };
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "hello": {
      if (st.helloed) return { ok: false, reason: "one hello per connection" };
      if (o.role !== "mic" && o.role !== "screen") return { ok: true };
      if (!str(o.clientId, 128, 1)) return { ok: false, reason: "clientId must be a string of 1-128 characters" };
      if (!optStr(o.code, 16)) return { ok: false, reason: "code must be a string" };
      let changed = false;
      if (o.name !== undefined && !str(o.name, 64)) (delete o.name, (changed = true));
      if (o.code === null) (delete o.code, (changed = true));
      if (o.role === "screen" && typeof o.code === "string" && !isPairingCode(normalizeCode(o.code))) (delete o.code, (changed = true));
      const code = typeof o.code === "string" ? normalizeCode(o.code) : undefined;
      const other = code ? rooms?.get(code)?.peers.get(o.clientId as string) : undefined;
      if (other && other.role !== o.role) return { ok: false, reason: "clientId is in use in this room" };
      st.helloed = true;
      return changed ? { ok: true, rewritten: JSON.stringify(o) } : { ok: true };
    }
    case "transcript.partial":
    case "transcript.final":
      if (!str(o.text, 4000) || !str(o.utteranceId, 128, 1) || !hopsOk(o.hops)) return { ok: false, reason: `${o.type}: text, utteranceId or hops are malformed` };
      return { ok: true };
    case "app":
      if (!str(o.topic, 64, 1) || !optStr(o.utteranceId, 128) || !hopsOk(o.hops)) return { ok: false, reason: "app: topic, utteranceId or hops are malformed" };
      return { ok: true };
    case "ack":
      if (!str(o.utteranceId, 128, 1) || !hopsOk(o.hops)) return { ok: false, reason: "ack: utteranceId or hops are malformed" };
      return { ok: true };
    case "ping":
      if (!Number.isFinite(o.t0)) return { ok: false, reason: "ping: t0 must be a number" };
      return { ok: true };
    default:
      return { ok: true };
  }
}

export interface BridgeGuard {
  authenticated(ws: WebSocket): boolean;
  installed: { upgrade: boolean; send: boolean };
}

export function guardBridge(bridge: BridgeHub, o: { log: Log; decisions: WeakMap<IncomingMessage, UpgradeDecision>; withToken: (joinUrl: string) => string; maxPayload?: number }): BridgeGuard {
  const auth = new WeakMap<WebSocket, boolean>();
  const installed = { upgrade: false, send: false };
  const guardSocket = (ws: WebSocket, req: IncomingMessage) => {
    const d = o.decisions.get(req);
    auth.set(ws, !!(d && d.allow && d.authenticated));
    ws.on("error", (err) => {
      o.log("ws.error", { error: String((err as Error)?.message ?? err) });
      ws.terminate();
    });
    const st = { helloed: false };
    const emit = ws.emit.bind(ws) as (event: string | symbol, ...args: unknown[]) => boolean;
    (ws as unknown as { emit: typeof emit }).emit = (event, ...args) => {
      if (event !== "message") return emit(event, ...args);
      const [data, isBinary] = args as [unknown, boolean];
      const reject = (reason: string) => {
        o.log("ws.refused", { reason });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", code: "bad-message", message: reason }));
        return true;
      };
      if (isBinary) return reject("binary frames are not part of the protocol");
      try {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString("utf8") : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : String(data);
        const c = checkFrame(text, st, bridge.rooms);
        if (!c.ok) return reject(c.reason);
        return emit("message", c.rewritten !== undefined ? Buffer.from(c.rewritten) : data, false);
      } catch (err) {
        o.log("ws.handler-error", { error: String((err as Error)?.message ?? err) });
        return true;
      }
    };
  };

  const wss = (bridge as unknown as { wss?: { handleUpgrade?: (...a: unknown[]) => void; options?: { maxPayload?: number } } }).wss;
  if (wss && typeof wss.handleUpgrade === "function") {
    if (wss.options) wss.options.maxPayload = o.maxPayload ?? WS_MAX_PAYLOAD;
    const handle = wss.handleUpgrade.bind(wss);
    wss.handleUpgrade = (req: unknown, socket: unknown, head: unknown, cb: unknown) =>
      handle(req, socket, head, (ws: WebSocket, ...rest: unknown[]) => {
        guardSocket(ws, req as IncomingMessage);
        (cb as (ws: WebSocket, ...r: unknown[]) => void)(ws, ...rest);
      });
    installed.upgrade = true;
  } else o.log("bridge.guard", { installed: false, reason: "BridgeHub.wss.handleUpgrade not found: frames reach the bridge unvalidated" });

  const send = bridge.send.bind(bridge);
  bridge.send = (socket, msg) => {
    const buffered = socket.bufferedAmount ?? 0;
    if (buffered > WS_TERMINATE_AT) {
      o.log("ws.backpressure", { action: "terminate", buffered });
      socket.terminate();
      return;
    }
    if (buffered > WS_DROP_METERS_AT && msg.type === "app" && msg.topic === "practice.meters") return;
    if (msg.type === "welcome" && typeof msg.joinUrl === "string" && auth.get(socket)) msg = { ...msg, joinUrl: o.withToken(msg.joinUrl) };
    send(socket, msg);
  };
  installed.send = true;
  return { authenticated: (ws) => !!auth.get(ws), installed };
}
