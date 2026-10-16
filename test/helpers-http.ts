// Raw HTTP and WebSocket helpers for the hub tests (custom Host, proxy headers, unnormalized paths).
import { request } from "node:http";
import WebSocket from "ws";

export const raw = (port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string; headers: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t, headers: res.headers as Record<string, unknown> }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });

export const wsOutcome = (port: number, query: string, headers: Record<string, string> = {}): Promise<{ result: "welcome" | "rejected" | "timeout"; welcome?: any }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
    const t = setTimeout(() => (ws.terminate(), resolve({ result: "timeout" })), 3000);
    const done = (result: "welcome" | "rejected", welcome?: any) => (clearTimeout(t), ws.terminate(), resolve({ result, welcome }));
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 1, role: "screen", clientId: `t-${Math.random()}` })));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "welcome") done("welcome", m);
    });
    ws.on("unexpected-response", () => done("rejected"));
    ws.on("error", () => done("rejected"));
  });
