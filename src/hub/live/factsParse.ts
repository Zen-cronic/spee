// Readers for the JSON that `bee facts ...` and `bee insights list` print, kept apart from the
// facts logic (live/facts.ts) because the shape is UNVERIFIED: bee-cli 0.8.0 types these calls as
// `unknown`, and no fact has been written on this account yet. The docs say a new fact is `{text}`
// and comes back `confirmed: false`. Until the operator's consented spike (docs/live.md "Bee
// memory"), every reader accepts the likely shapes and returns null or [] for anything else:
//   one fact   {id, text, confirmed} | {fact: {...}} | {data: {...}}; id a number or a string
//   a list     [...] | {facts|insights|items|data|results: [...]}, with an optional next cursor
//              (next_cursor | nextCursor | cursor | next)
// A notice line before or after the JSON is read past (cliJson, as for to-dos).
//
// Privacy: other facts and insights are Bee's text about the wearer's life. The readers keep their
// text only so the caller can match its own goal fact by exact text; callers keep counts only.
//
// Spike check (prints ids, flags and counts, never text):
//   bee facts create --text "<the goal text>" --json > /tmp/fact.json
//   npx tsx src/hub/live/factsParse.ts fact < /tmp/fact.json
//   bee facts list --unconfirmed --json | npx tsx src/hub/live/factsParse.ts list
import { fileURLToPath } from "node:url";
import { cliJson } from "./wrist.js";

export interface ParsedFact {
  id: string;
  text: string;
  confirmed: boolean | null; // null: the output did not say
}
export interface ParsedList<T> {
  items: T[];
  cursor: string | null; // the next page, when the output names one
}

const isId = (v: unknown): v is number | string => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "");
const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const flag = (v: unknown): boolean | null => (v === true || v === 1 || v === "true" ? true : v === false || v === 0 || v === "false" ? false : null);

function factOf(v: unknown): ParsedFact | null {
  const o = asObj(v);
  if (!o) return null;
  const inner = asObj(o.fact) ?? (asObj(o.data) && isId(asObj(o.data)!.id) ? asObj(o.data) : null) ?? o;
  if (!isId(inner.id)) return null;
  return { id: String(inner.id), text: typeof inner.text === "string" ? inner.text : "", confirmed: flag(inner.confirmed ?? inner.is_confirmed ?? inner.isConfirmed) };
}

/** One fact from `bee facts create|update|confirm|get --json`, or null. */
export function parseFact(stdout: string): ParsedFact | null {
  try {
    return factOf(cliJson(stdout));
  } catch {
    return null;
  }
}

function listOf(stdout: string, keys: string[]): { arr: unknown[]; cursor: string | null } {
  const o = cliJson(stdout);
  if (Array.isArray(o)) return { arr: o, cursor: null };
  const r = asObj(o) ?? {};
  let arr: unknown = undefined;
  for (const k of keys) if (Array.isArray(r[k])) (arr ??= r[k]);
  const c = r.next_cursor ?? r.nextCursor ?? r.cursor ?? r.next;
  return { arr: Array.isArray(arr) ? arr : [], cursor: typeof c === "string" && c ? c : typeof c === "number" ? String(c) : null };
}

/** The facts in `bee facts list --json` (each with an id), and the next cursor. [] on anything else. */
export function parseFactList(stdout: string): ParsedList<ParsedFact> {
  try {
    const { arr, cursor } = listOf(stdout, ["facts", "items", "data", "results"]);
    return { items: arr.map(factOf).filter((f): f is ParsedFact => !!f), cursor };
  } catch {
    return { items: [], cursor: null };
  }
}

/** How many insights `bee insights list --json` printed (entries with an id), and the next cursor. */
export function parseInsightCount(stdout: string): { count: number; cursor: string | null } | null {
  try {
    const { arr, cursor } = listOf(stdout, ["insights", "items", "data", "results"]);
    return { count: arr.filter((x) => isId(asObj(x)?.id)).length, cursor };
  } catch {
    return null;
  }
}

/** Bee may trim or re-space a fact's text: compare on collapsed whitespace. */
export const sameFactText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// npx tsx src/hub/live/factsParse.ts fact|list|insights < output.json
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kind = process.argv[2];
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const summary =
      kind === "fact"
        ? (() => {
            const f = parseFact(input);
            return f ? { id: f.id, confirmed: f.confirmed, textChars: f.text.length } : { parsed: false };
          })()
        : kind === "insights"
          ? (parseInsightCount(input) ?? { parsed: false })
          : (() => {
              const l = parseFactList(input);
              return { count: l.items.length, confirmed: l.items.filter((f) => f.confirmed === true).length, unconfirmed: l.items.filter((f) => f.confirmed === false).length, unknown: l.items.filter((f) => f.confirmed === null).length, cursor: l.cursor != null };
            })();
    console.log(JSON.stringify(summary));
  });
}
