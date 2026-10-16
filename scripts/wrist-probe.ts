// Wrist probe (OPERATOR-RUN; it creates real Bee to-dos). Measures how much alarm lead a Bee
// to-do needs to reach the Apple Watch. For each lead it waits for the next minute boundary (so
// each buzz is easy to tell apart), creates "[coach] probe <N>s" with an alarm N seconds ahead,
// and logs the id and times to real/live/wrist-probe.jsonl (gitignored). Then note on the Watch
// which probes buzzed, and when. --cleanup deletes the probe to-dos again.
//
//   npm run wrist:probe                       # leads 5, 10, 20, 30 s (about 4 minutes)
//   npm run wrist:probe -- --leads 10,30
//   npm run wrist:probe -- --dry-run          # print the commands only
//   npm run wrist:probe -- --cleanup          # delete every open "[coach] probe" to-do
//
// Before running: Bee recording on the Watch, the iPhone LOCKED (verified 2026-10-16: the alarm
// reaches the Watch only while Bee is recording and the iPhone is locked; otherwise it lands on
// the iPhone). The CLI is called with execFile (no shell); this script never reads the Bee token.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { alarmIso, parseTodo, parseTodoList } from "../src/hub/live/wrist.js";

const run = promisify(execFile);
const BIN = process.env.BEE_BIN ?? "bee";
const LOG = "real/live/wrist-probe.jsonl";
const TZ = process.env.BEE_TZ ?? "America/Toronto";
const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const dry = args.includes("--dry-run");
const local = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(ms));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bee = async (a: string[]) => {
  if (dry) return console.log(`  (dry run) ${BIN} ${a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}`), "{}";
  return (await run(BIN, a, { timeout: 15_000 })).stdout;
};

if (args.includes("--help")) {
  console.log("usage: npm run wrist:probe -- [--leads 5,10,20,30] [--dry-run] | --cleanup");
  process.exit(0);
}

if (args.includes("--cleanup")) {
  const ids = new Set<string>();
  if (existsSync(LOG)) for (const l of readFileSync(LOG, "utf8").split("\n").filter(Boolean)) ids.add(String(JSON.parse(l).id));
  const list = parseTodoList(await bee(["todos", "list", "--limit", "100", "--json"]));
  for (const t of list) if (t.text.startsWith("[coach] probe")) ids.add(t.id);
  let n = 0;
  for (const id of ids) {
    try {
      await bee(["todos", "delete", id, "--json"]);
      n++;
    } catch (e) {
      console.log(`  ${id}: ${(e as Error).message.split("\n")[0]} (already gone?)`);
    }
    await sleep(1500);
  }
  console.log(`Deleted ${n} probe to-do(s).`);
  process.exit(0);
}

const leads = (opt("--leads") ?? "5,10,20,30").split(",").map(Number).filter((x) => x > 0 && x <= 600);
if (!leads.length) throw new Error("--leads needs seconds, e.g. 5,10,20,30");
console.log(`Wrist probe: leads ${leads.join(", ")} s, one per minute. Bee recording on the Watch, iPhone LOCKED.`);
if (!dry) mkdirSync(dirname(LOG), { recursive: true });
for (const [i, lead] of leads.entries()) {
  const wait = 60_000 - (Date.now() % 60_000);
  if (!dry) await sleep(wait);
  const created = dry ? Date.now() + wait + i * 60_000 : Date.now();
  const alarm = alarmIso(created + lead * 1000);
  const text = `[coach] probe ${lead}s`;
  const out = await bee(["todos", "create", "--text", text, "--alarm-at", alarm, "--json"]);
  const t = parseTodo(out);
  const row = { id: t?.id ?? null, text, lead_s: lead, created_at: new Date(created).toISOString(), alarm_at: alarm, returned_at: new Date().toISOString() };
  if (!dry) appendFileSync(LOG, JSON.stringify(row) + "\n");
  console.log(`  lead ${String(lead).padStart(3)} s  id ${row.id ?? "-"}  created ${local(created)}  alarm ${local(Date.parse(alarm))}  ${dry ? "" : `(create took ${Date.now() - created} ms)`}`);
}
console.log(`\nLogged to ${LOG}. Note which probes buzzed on the Watch, then run: npm run wrist:probe -- --cleanup`);
