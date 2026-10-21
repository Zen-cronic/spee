#!/usr/bin/env node
// The speaking-coach Agent Skill's one script: each command is one call to the Speaking Mirror hub on
// this machine (its /api routes answer loopback and LAN only). Node built-ins only.
//
//   status     GET  /api/coach/now     how the speaking is going, and whether live coaching is on
//   brief      GET  /api/brief         the next meeting (its time, never its title), the habit to watch, a warm-up line
//   goal       GET  /api/coach/facts   the coach's goal fact in Bee, and Bee's fact and insight counts
//   cue        POST /api/coach/cue     one if-then cue on the wrist (the hub picks the habit, caps and dedupes it)
//   heartbeat  GET  /api/brief?upcoming=1 (the next meeting that has not started), then
//              POST /api/coach/cue, 8 to 12 min before it, until a to-do is set for it
//
// Calendar titles never leave this script: no output line and no saved state carries one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_HUB = "http://127.0.0.1:8791";
export const CUE_WINDOW_MIN = { from: 8, to: 12 }; // minutes before the meeting starts
export const KEEP_SENT_MS = 24 * 60 * 60_000; // forget cued meetings after a day
const TIMEOUT_MS = 8000;

export const USAGE = `usage: coach.mjs <status|brief|goal|cue|heartbeat> [--hub URL] [--json]
  cue        [--in MINUTES]   the alarm this many minutes from now (default 0)
  heartbeat  [--dry-run] [--state FILE]
  --hub defaults to $COACH_HUB_URL, else ${DEFAULT_HUB}`;

// Decisions

/** A stable key for one meeting, from its start time only (never its title). */
export function eventKey(startsAt) {
  return createHash("sha256").update(String(startsAt)).digest("hex").slice(0, 16);
}

/**
 * Whether the heartbeat should send a cue now. `brief` is GET /api/brief; `sent` maps eventKey to
 * the time a cue went out. A cue goes out once per meeting, when it starts in 8 to 12 minutes. The
 * minutes come from the hub's own clock (brief.generatedAt), else `now`.
 */
export function decide(brief, sent = {}, now = Date.now()) {
  const ev = brief && typeof brief === "object" ? brief.event : null;
  const startsAt = ev && typeof ev.startsAt === "string" ? Date.parse(ev.startsAt) : NaN;
  if (!Number.isFinite(startsAt)) return { action: "wait", reason: "no-meeting", key: null, minutes: null };
  const at = typeof brief.generatedAt === "string" && Number.isFinite(Date.parse(brief.generatedAt)) ? Date.parse(brief.generatedAt) : now;
  const minutes = (startsAt - at) / 60_000;
  const key = eventKey(ev.startsAt);
  if (sent && Object.hasOwn(sent, key)) return { action: "wait", reason: "already-cued", key, minutes };
  if (minutes < 0) return { action: "wait", reason: "started", key, minutes };
  if (minutes < CUE_WINDOW_MIN.from) return { action: "wait", reason: "too-late", key, minutes };
  if (minutes > CUE_WINDOW_MIN.to) return { action: "wait", reason: "too-early", key, minutes };
  return { action: "cue", reason: "in-window", key, minutes };
}

/**
 * Whether a cue answer (`{status, body}` from POST /api/coach/cue) set a to-do for the meeting that
 * starts at `startsAt`: a cue sent now, or the same cue already set (deduped) whose alarm goes off in
 * that meeting's last CUE_WINDOW_MIN.to minutes before it starts. A refusal, a failed send, or a
 * deduped cue for an earlier meeting leaves the meeting open.
 */
export function cuedFor(res, startsAt) {
  const b = res && res.status === 200 && res.body && typeof res.body === "object" ? res.body : null;
  if (!b?.cue || b.wrist?.status === "failed") return false;
  if (!b.deduped) return true;
  const at = b.cue.alarmAt;
  return typeof at === "number" && Number.isFinite(startsAt) && at >= startsAt - CUE_WINDOW_MIN.to * 60_000 && at <= startsAt;
}

const WAIT_TEXT = {
  "no-meeting": "no meeting on the calendar soon",
  "already-cued": "this meeting already had its cue",
  started: "the meeting has started",
  "too-late": `the meeting starts in under ${CUE_WINDOW_MIN.from} min`,
  "too-early": `the cue goes out ${CUE_WINDOW_MIN.from} to ${CUE_WINDOW_MIN.to} min before`,
};

// Output (no line carries a calendar title)

const mins = (m) => `${Math.round(m)} min`;

/** The brief without the event's title (and without `nudge`, which quotes it). */
export function safeBrief(b) {
  if (!b || typeof b !== "object") return null;
  const ev = b.event && typeof b.event === "object" ? { startsAt: b.event.startsAt ?? null, startsInMin: b.event.startsInMin ?? null, source: b.event.source ?? null } : null;
  const top = b.topHabit && typeof b.topHabit === "object" ? { key: b.topHabit.key, label: b.topHabit.label, per100: b.topHabit.per100, range: b.topHabit.range } : null;
  return { dataLabel: b.dataLabel ?? null, generatedAt: b.generatedAt ?? null, event: ev, eventNote: b.eventNote ?? null, topHabit: top, warmup: b.warmup?.resay ? { resay: b.warmup.resay } : null };
}

export function briefLines(b) {
  const s = safeBrief(b);
  if (!s) return ["The hub sent no brief."];
  const lines = [];
  if (s.event && typeof s.event.startsInMin === "number") lines.push(s.event.startsInMin >= 0 ? `Next meeting in ${mins(s.event.startsInMin)}.` : `A meeting started ${mins(-s.event.startsInMin)} ago.`);
  else lines.push(s.eventNote ? `No meeting on the calendar soon (${s.eventNote}).` : "No meeting on the calendar soon.");
  if (s.topHabit) lines.push(`The habit to watch this ${s.topHabit.range === "week" ? "week" : "time"}: ${s.topHabit.label} (${s.topHabit.per100} per 100 words).`);
  else lines.push("Bee hasn't heard enough speech yet to pick a habit.");
  if (s.warmup) lines.push(`Warm up: say "${s.warmup.resay}" once, cleanly.`);
  if (s.dataLabel && /synthetic/i.test(s.dataLabel)) lines.push(`(${s.dataLabel})`);
  return lines;
}

export function statusLines(c) {
  if (!c || typeof c !== "object") return ["The hub sent no status."];
  const lines = [typeof c.narration === "string" && c.narration ? c.narration : "No speech to report yet."];
  lines.push(c.mode?.enabled ? `Live coaching: on${typeof c.mode.expiresAt === "number" ? ` until ${new Date(c.mode.expiresAt).toTimeString().slice(0, 5)}` : ""}.` : "Live coaching: off (wrist nudges only when it is on).");
  if (typeof c.drills?.dueNow === "number") lines.push(`Practice lines due: ${c.drills.dueNow}.`);
  if (c.dataLabel && /synthetic/i.test(c.dataLabel)) lines.push(`(${c.dataLabel})`);
  return lines;
}

/**
 * The goal fact, as GET /api/coach/facts reports it. `stopped`: the coach gave up on a create Bee
 * never listed, so the goal may or may not be in Bee (a create that exited 0 without an id did land),
 * as the TV says it (an older hub sends no `stopped`: read as false).
 */
export function goalLines(m) {
  if (!m || typeof m !== "object") return ["The hub sent no Bee memory."];
  const lines = [];
  if (m.stopped === true) {
    if (m.goal?.text) lines.push(`Goal the coach tried to save in Bee: ${m.goal.text}`);
    lines.push("Bee never listed it, so the coach stopped trying (it never makes a second copy). It may or may not be in Bee; docs/live.md (Bee memory) says how to check and start over.");
  } else if (m.goal?.text) lines.push(`Goal in Bee: ${m.goal.text}`, m.goal.confirmed ? "It is a confirmed Bee fact." : "Bee has not confirmed it yet.");
  else if (!m.enabled || m.status === "off") lines.push("Bee memory is off on this hub (COACH_FACTS=1 turns it on), so there is no goal fact.");
  else lines.push(`No goal fact yet (status: ${m.status}). It is written after a practice line Bee checked.`);
  const counts = [m.facts ? `${m.facts.count} facts` : null, m.insights ? `${m.insights.count} insights` : null].filter(Boolean);
  if (counts.length) lines.push(`Bee holds ${counts.join(" and ")} (counts only).`);
  if (m.note) lines.push(m.note);
  return lines;
}

export function cueLines(r) {
  if (!r || typeof r !== "object" || !r.cue) return ["The hub sent no cue."];
  const lines = [r.narration || `Cue: ${r.cue.text}`];
  // the hub dedupes on the alarm, not on when a cue was asked for (docs/live.md "Wrist cue")
  if (r.deduped) lines.push("A cue for the same habit has its alarm within 10 minutes of this one, so this is that cue and nothing new reached the wrist.");
  else if (r.wrist?.status === "failed") lines.push(`The wrist call failed${r.wrist.error ? `: ${r.wrist.error}` : ""}.`);
  else if (r.wrist?.status === "replay") lines.push("Demo hub: the cue was replayed, not sent to a wrist.");
  return lines;
}

// Heartbeat state: which meetings already had their cue (keys and times only)

export function defaultStatePath(env = process.env) {
  if (env.COACH_SKILL_STATE) return env.COACH_SKILL_STATE;
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "speaking-mirror", "coach-skill.json");
}
export function loadSent(path, now = Date.now()) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const sent = j && typeof j.sent === "object" && j.sent ? j.sent : {};
    return Object.fromEntries(Object.entries(sent).filter(([k, at]) => /^[0-9a-f]{16}$/.test(k) && typeof at === "number" && now - at < KEEP_SENT_MS));
  } catch {
    return {};
  }
}
export function saveSent(path, sent) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sent }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// Hub calls

async function call(io, method, path, body) {
  try {
    const r = await io.fetch(new URL(path, io.hub), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { status: r.status, body: json };
  } catch (err) {
    return { status: 0, body: { error: "hub_unreachable", message: `no answer from ${io.hub} (${err?.name === "TimeoutError" ? "timed out" : "is the hub running? npm run hub"})` } };
  }
}
const failed = (r) => r.status === 0 || r.status >= 400;
// 1: the hub is away or broke; 2: it refused (cues off, quiet hours, cap...) or a usage error.
const exitOf = (r) => (r.status === 0 || r.status >= 500 ? 1 : 2);
function refusal(io, r, what) {
  const msg = r.status === 404 && (!r.body || r.body.error === "not_found") ? `this hub has no ${what} route (update the hub)` : r.body?.message || r.body?.error || `HTTP ${r.status}`;
  io.err(`coach: ${msg}`);
  return exitOf(r);
}

// Commands

const commands = {
  async status(io) {
    const r = await call(io, "GET", "/api/coach/now");
    if (failed(r)) return refusal(io, r, "coach status");
    io.print(statusLines(r.body), { narration: r.body.narration, live: !!r.body.mode?.enabled, dueNow: r.body.drills?.dueNow ?? null, dataLabel: r.body.dataLabel ?? null });
    return 0;
  },
  async brief(io) {
    const r = await call(io, "GET", "/api/brief");
    if (failed(r)) return refusal(io, r, "brief");
    io.print(briefLines(r.body), safeBrief(r.body));
    return 0;
  },
  async goal(io) {
    const r = await call(io, "GET", "/api/coach/facts");
    if (failed(r)) return refusal(io, r, "Bee memory");
    io.print(goalLines(r.body), r.body);
    return 0;
  },
  async cue(io, opts) {
    const inMinutes = opts.in === undefined ? 0 : Number(opts.in);
    if (!Number.isInteger(inMinutes) || inMinutes < 0 || inMinutes > 180) {
      io.err("coach: --in takes whole minutes from 0 to 180");
      return 2;
    }
    const r = await call(io, "POST", "/api/coach/cue", { inMinutes, by: "skill" });
    if (failed(r)) return refusal(io, r, "cue");
    io.print(cueLines(r.body), r.body);
    return 0;
  },
  async heartbeat(io, opts) {
    // Only a meeting that has not started: one under way must not hide the next one's window.
    const r = await call(io, "GET", "/api/brief?upcoming=1");
    if (failed(r)) return refusal(io, r, "brief");
    const statePath = opts.state ? resolve(opts.state) : defaultStatePath(io.env);
    const sent = loadSent(statePath, io.now());
    const d = decide(r.body, sent, io.now());
    const when = d.minutes === null ? "" : ` (next meeting in ${mins(d.minutes)})`;
    if (d.action === "wait") {
      io.print([`No cue: ${WAIT_TEXT[d.reason]}${d.reason === "no-meeting" ? "" : when}.`], { action: "wait", reason: d.reason, minutes: d.minutes });
      return 0;
    }
    if (opts["dry-run"]) {
      io.print([`Would send a cue now${when}.`], { action: "cue", dryRun: true, minutes: d.minutes });
      return 0;
    }
    const c = await call(io, "POST", "/api/coach/cue", { inMinutes: 0, by: "skill:heartbeat" });
    // The meeting has its cue only when a to-do was set for it. Anything else (a refusal, a failed
    // send, a cue for an earlier meeting, a hub that is away) is asked again on the next heartbeat
    // while the window is open.
    if (cuedFor(c, Date.parse(r.body.event.startsAt))) saveSent(statePath, { ...sent, [d.key]: io.now() });
    if (failed(c)) return refusal(io, c, "cue");
    io.print([`Cue for the meeting in ${mins(d.minutes)}:`, ...cueLines(c.body)], { action: "cue", minutes: d.minutes, ...c.body });
    return 0;
  },
};

/** Runs one command. `deps` injects fetch, the clock and the output (tests); returns the exit code. */
export async function run(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s) => process.stderr.write(s + "\n"));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { hub: { type: "string" }, json: { type: "boolean" }, in: { type: "string" }, "dry-run": { type: "boolean" }, state: { type: "string" }, help: { type: "boolean", short: "h" } } });
  } catch (e) {
    err(`coach: ${e.message}\n${USAGE}`);
    return 2;
  }
  const [name] = parsed.positionals;
  if (parsed.values.help) {
    out(USAGE);
    return 0;
  }
  if (!name) {
    err(USAGE);
    return 2;
  }
  const cmd = Object.hasOwn(commands, name) ? commands[name] : null;
  if (!cmd) {
    err(`coach: unknown command "${name}"\n${USAGE}`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const hub = parsed.values.hub ?? env.COACH_HUB_URL ?? DEFAULT_HUB;
  if (!/^https?:\/\//.test(hub)) {
    err("coach: --hub must be an http(s) URL");
    return 2;
  }
  const json = !!parsed.values.json;
  const io = {
    hub: hub.endsWith("/") ? hub : `${hub}/`,
    fetch: deps.fetch ?? fetch,
    now: deps.now ?? (() => Date.now()),
    env,
    err,
    print: (lines, data) => out(json ? JSON.stringify(data, null, 2) : lines.join("\n")),
  };
  return cmd(io, parsed.values);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
