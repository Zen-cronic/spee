// Process-level robustness for the hub (lead-owned).
//
// - trackChild(): every child the hub starts (`bee stream`, the wrist and poll CLI calls) is
//   registered, and killChildren() runs on shutdown and on process exit, so no `bee stream` outlives
//   the hub.
// - installProcessGuards(): an unhandled rejection or an uncaught exception is logged (name and
//   message only, never request data) and the hub keeps serving. A burst of uncaught exceptions
//   (more than MAX_UNCAUGHT in UNCAUGHT_WINDOW_MS) means the process is wedged: it exits with code 1
//   after killing its children, so a supervisor or the operator restarts it cleanly.
import type { ChildProcess } from "node:child_process";

const live = new Set<ChildProcess>();
let exitHook = false;

export function trackChild<C extends ChildProcess | null | undefined>(c: C): C {
  if (!c) return c;
  live.add(c);
  const forget = () => live.delete(c);
  c.once("exit", forget);
  c.once("error", forget);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => killChildren("SIGKILL"));
  }
  return c;
}

export const liveChildren = () => live.size;

// SIGTERM now; SIGKILL after `graceMs` for any child still running.
export function killChildren(signal: NodeJS.Signals = "SIGTERM", graceMs = 2000): void {
  for (const c of [...live]) {
    if (c.exitCode !== null || c.signalCode !== null) {
      live.delete(c);
      continue;
    }
    try {
      c.kill(signal);
    } catch {
      /* already gone */
    }
    if (signal !== "SIGKILL") {
      const t = setTimeout(() => {
        if (c.exitCode === null && c.signalCode === null) {
          try {
            c.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, graceMs);
      t.unref?.();
    }
  }
}

export const MAX_UNCAUGHT = 20;
export const UNCAUGHT_WINDOW_MS = 60_000;

type Log = (event: string, data?: Record<string, unknown>) => void;
const describe = (e: unknown) => (e instanceof Error ? { name: e.name, error: e.message } : { name: typeof e, error: String(e) });

export function installProcessGuards(log: Log, opts: { exit?: (code: number) => void; now?: () => number } = {}): () => void {
  const now = opts.now ?? (() => Date.now());
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const recent: number[] = [];
  const onRejection = (reason: unknown) => log("process.unhandled-rejection", describe(reason));
  const onException = (err: unknown) => {
    log("process.uncaught-exception", describe(err));
    const t = now();
    recent.push(t);
    while (recent.length && t - recent[0]! > UNCAUGHT_WINDOW_MS) recent.shift();
    if (recent.length > MAX_UNCAUGHT) {
      log("process.exit", { reason: `more than ${MAX_UNCAUGHT} uncaught exceptions in ${UNCAUGHT_WINDOW_MS / 1000} s` });
      killChildren("SIGKILL");
      exit(1);
    }
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
