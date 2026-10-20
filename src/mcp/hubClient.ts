// Loopback hub client (packet C): a typed HTTP client over the v1 + v2 contract, used by the Alexa
// skill and the MCP tools so both obey docs/CONTRACT.md exactly instead of reaching into the hub's
// internals. It talks to ctx.selfUrl() (http://127.0.0.1:<port>), which the gate treats as LAN.
// Client headers are never forwarded. No model call anywhere in here.
import type {
  AttemptAccepted,
  Brief,
  CoachNow,
  ErrorBody,
  LiveModeRequest,
  LiveModeResponse,
  RecapList,
  SessionResponse,
  SessionStartResponse,
  SessionSummary,
  SourceSel,
  StatsResponse,
  TransferResponse,
  VerdictResponse,
  CardView,
} from "../hub/contract.js";

export type HubResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: ErrorBody & Record<string, unknown> };

// POST /api/session/next (the server adds narration to CoachHub.nextInSession()).
export interface SessionNextResponse {
  card: CardView | null;
  done: boolean;
  summary?: SessionSummary | null;
  narration: string;
}
export interface SessionEndResponse {
  summary: SessionSummary | null;
}

export interface HubClientOptions {
  timeoutMs?: number; // per request (default 5000: Alexa must answer within 8 s)
  fetch?: typeof fetch;
}

export class HubClient {
  readonly base: () => string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(base: string | (() => string), opts: HubClientOptions = {}) {
    this.base = typeof base === "string" ? () => base : base;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.doFetch = opts.fetch ?? fetch;
  }

  // One call. Never throws for an HTTP error status: a network failure or timeout comes back as
  // `{ok:false, status:0, body:{error:"hub_unreachable"}}`.
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<HubResult<T>> {
    try {
      const r = await this.doFetch(this.base() + path, {
        method,
        // Alexa and MCP answers are spoken: the hub masks private terms as "name", not "▒▒▒" (src/hub/mask.ts).
        headers: body === undefined ? { "x-hub-mask": "speech" } : { "content-type": "application/json", "x-hub-mask": "speech" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { error: "bad_json", message: `the hub answered ${r.status} with a body that is not JSON` };
      }
      if (r.status >= 400) {
        const b = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
        return { ok: false, status: r.status, body: { ...b, error: String(b.error ?? "http_error"), message: String(b.message ?? `HTTP ${r.status}`) } };
      }
      return { ok: true, status: r.status, body: parsed as T };
    } catch (err) {
      const e = err as Error;
      const timeout = e.name === "TimeoutError" || e.name === "AbortError";
      return { ok: false, status: 0, body: { error: timeout ? "hub_timeout" : "hub_unreachable", message: timeout ? `the hub did not answer in ${this.timeoutMs} ms` : "the hub is not reachable" } };
    }
  }

  // v1
  session = () => this.call<SessionResponse>("GET", "/api/session");
  startSession = (b: { by?: string; size?: number } = {}) => this.call<SessionStartResponse>("POST", "/api/session/start", b);
  nextCard = () => this.call<SessionNextResponse>("POST", "/api/session/next", {});
  endSession = () => this.call<SessionEndResponse>("POST", "/api/session/end", {});
  attempt = (b: { text: string; source: "alexa" | "mcp" | "phone" | "typed"; cardId?: string; speechEndAt?: number }) => this.call<AttemptAccepted>("POST", "/api/attempt", b);
  verdict = (id: string) => this.call<VerdictResponse>("GET", `/api/attempts/${encodeURIComponent(id)}`);
  stats = (q: { range?: string; source?: SourceSel } = {}) => this.call<StatsResponse>("GET", `/api/stats${qs(q)}`);
  transfer = (q: { habit?: string; source?: SourceSel } = {}) => this.call<TransferResponse>("GET", `/api/transfer${qs(q)}`);
  brief = () => this.call<Brief>("GET", "/api/brief");

  // v2
  coachNow = () => this.call<CoachNow>("GET", "/api/coach/now");
  liveMode = (b: LiveModeRequest) => this.call<LiveModeResponse>("POST", "/api/live/mode", b);
  recaps = (limit = 1) => this.call<RecapList>("GET", `/api/recaps?limit=${limit}`);
}

function qs(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
