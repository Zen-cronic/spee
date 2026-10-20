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
// Spike check, READ-ONLY (operator-run; it writes nothing to Bee and never prints a fact's text):
//   npx tsx src/hub/live/factsParse.ts inspect
// runs `bee facts list --limit 5 --json`, the same with `--unconfirmed`, and `bee insights list
// --limit 5 --json` (execFile, no shell; BEE_BIN or `bee`), and prints for each only the JSON's
// shape (keys, value types, array lengths; jsonShape) and what these readers make of it (counts,
// confirmed flags, whether a cursor came back). Any saved output can be checked the same way:
//   npx tsx src/hub/live/factsParse.ts shape|fact|list|insights < output.json
import { fileURLToPath } from "node:url";
import { cliJson, defaultExec, type ExecFn } from "./wrist.js";

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

// The shape of a JSON value without any of its values: "string", "number", "boolean", "null",
// arrays as {array: length, of: <the first item's shape>}, objects as {key: shape}. A key that does
// not look like a field name (it could be data) is shown as "<key>". Depth-limited.
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
export function jsonShape(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return { array: v.length, ...(v.length && depth < 4 ? { of: jsonShape(v[0], depth + 1) } : {}) };
  if (typeof v === "object") {
    if (depth >= 4) return "object";
    const out: Record<string, unknown> = {};
    let odd = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FIELD.test(k)) out[k] = jsonShape(x, depth + 1);
      else odd++;
    }
    if (odd) out["<key>"] = `${odd} key(s) that are not field names`;
    return out;
  }
  return typeof v;
}
/** A CLI output's shape: the JSON's (jsonShape), or that there was none; notice lines are counted, never shown. */
export function outputShape(stdout: string): { json: boolean; shape: unknown; lines: number } {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim()).length;
  try {
    return { json: true, shape: jsonShape(cliJson(stdout)), lines };
  } catch {
    return { json: false, shape: null, lines };
  }
}

/** Bee may trim or re-space a fact's text: compare on collapsed whitespace. */
export const sameFactText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

const listSummary = (out: string) => {
  const l = parseFactList(out);
  return { count: l.items.length, confirmed: l.items.filter((f) => f.confirmed === true).length, unconfirmed: l.items.filter((f) => f.confirmed === false).length, unknown: l.items.filter((f) => f.confirmed === null).length, cursor: l.cursor != null };
};

// The read-only spike: shapes and counts only. Only `list` calls: it never writes to Bee.
export const INSPECT_CALLS = [
  ["facts", "list", "--limit", "5", "--json"],
  ["facts", "list", "--unconfirmed", "--limit", "5", "--json"],
  ["insights", "list", "--limit", "5", "--json"],
] as const;
export async function inspect(o: { exec?: ExecFn; bin?: string; print?: (line: string) => void } = {}): Promise<number> {
  const bin = o.bin ?? process.env.BEE_BIN ?? "bee";
  const print = o.print ?? ((l: string) => console.log(l));
  const [factsList, unconfirmedList, insightsList] = INSPECT_CALLS.map((a) => [...a]);
  const runs: { args: string[]; read: (out: string) => unknown }[] = [
    { args: factsList!, read: listSummary },
    { args: unconfirmedList!, read: listSummary },
    { args: insightsList!, read: (out) => parseInsightCount(out) ?? { parsed: false } },
  ];
  let bad = 0;
  for (const r of runs) {
    try {
      const { stdout } = await (o.exec ?? defaultExec)(bin, r.args, { timeout: 15_000 });
      print(JSON.stringify({ command: `bee ${r.args.join(" ")}`, ok: true, output: outputShape(stdout), parsed: r.read(stdout) }, null, 1));
    } catch (e) {
      bad++;
      const x = e as { code?: unknown; killed?: boolean };
      print(JSON.stringify({ command: `bee ${r.args.join(" ")}`, ok: false, error: x?.killed ? "timeout" : `exit ${String(x?.code ?? "?")}` }));
    }
  }
  return bad ? 1 : 0;
}

// npx tsx src/hub/live/factsParse.ts inspect | shape|fact|list|insights < output.json
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kind = process.argv[2];
  if (kind === "inspect") void inspect().then((code) => process.exit(code));
  else readStdin(kind);
}

function readStdin(kind: string | undefined) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const summary =
      kind === "shape"
        ? outputShape(input)
        : kind === "fact"
          ? (() => {
              const f = parseFact(input);
              return f ? { id: f.id, confirmed: f.confirmed, textChars: f.text.length } : { parsed: false, output: outputShape(input) };
            })()
          : kind === "insights"
            ? (parseInsightCount(input) ?? { parsed: false, output: outputShape(input) })
            : listSummary(input);
    console.log(JSON.stringify(summary));
  });
}
