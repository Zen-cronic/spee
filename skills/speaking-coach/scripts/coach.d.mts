// Types for coach.mjs, so the TypeScript tests can import it.
export interface Decision {
  action: "cue" | "wait";
  reason: "in-window" | "no-meeting" | "already-cued" | "started" | "too-late" | "too-early";
  key: string | null;
  minutes: number | null;
}
export interface RunDeps {
  fetch?: typeof fetch;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
}
export const DEFAULT_HUB: string;
export const CUE_WINDOW_MIN: { from: number; to: number };
export const KEEP_SENT_MS: number;
export const USAGE: string;
export function eventKey(startsAt: string): string;
export function decide(brief: unknown, sent?: Record<string, number>, now?: number): Decision;
export function safeBrief(brief: unknown): Record<string, unknown> | null;
export function briefLines(brief: unknown): string[];
export function statusLines(coachNow: unknown): string[];
export function goalLines(memory: unknown): string[];
export function cueLines(response: unknown): string[];
export function cuedFor(response: { status: number; body: unknown } | null, startsAt: number): boolean;
export function defaultStatePath(env?: Record<string, string | undefined>): string;
export function loadSent(path: string, now?: number): Record<string, number>;
export function saveSent(path: string, sent: Record<string, number>): void;
export function run(argv: string[], deps?: RunDeps): Promise<number>;
