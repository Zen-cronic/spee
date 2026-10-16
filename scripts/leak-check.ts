// Leak check for files that could be committed (tracked + untracked-not-ignored).
//   npx tsx scripts/leak-check.ts
// 1. Other speakers' text: every 5-word shingle of every non-wearer utterance in the live Bee
//    data (held in memory only) is searched for in each file. Prints counts, never the text.
// 2. Location: conversation addresses' street tokens.
// 3. Credentials: JWT-shaped strings (the bee token is a JWT) and "Bearer " headers.
// 4. Wearer excerpts: 5-word shingles of the wearer's own lines; the report may hold <= 10 short
//    excerpts, so hits should appear only in REAL_DATA_REPORT.md and stay small.
// 5. Meeting transcripts (optional): `--wearer "<name>" --tactiq <file.txt> [--tactiq <file2.txt>]`
//    adds every other speaker's 5-word shingles, colleagues' name tokens and the meeting title
//    (all held in memory only; pass the paths on the command line so no meeting name is tracked).
// 6. Bee live-stream captures (optional): `--stream <capture.log>` (lines of `bee stream --json`
//    output). Lines Bee tagged as the wearer count as wearer shingles; every other line (untagged,
//    or tagged as someone else) counts as other-speaker text, conservatively.
// 7. Coach-hub attempts (real/hub-attempts.json, gitignored) are the wearer's own words: their
//    shingles count as wearer shingles.
// 8. Private outputs: real/, out/, cache/, the hub's state files, the live-coaching state, the
//    private coach principles and the build outputs must be git-ignored.
// 9. Live-coaching state (real/live/**/*.json, gitignored) holds the wearer's own words (recap
//    moments): every string in it counts as wearer shingles.
// 10. Coach principles (contract v2): when coach/principles.local.md exists, any of its 5-word
//    shingles in a committable file FAILS the check, whatever the file's age. Shingles also in the
//    committed generic template, or made only of function words, are not private. When
//    coach/private-terms.local.txt exists, every non-empty line not starting with "#" is a banned
//    term (case-insensitive, whole words); any hit FAILS. Counts only are printed, never the text.
// Provenance: a file last modified before a conversation or meeting started cannot contain its
// text, so such a shingle hit is reported as "predates" and does not fail the check (generic
// phrases in synthetic fixtures written before a later recording). A fresh checkout resets
// mtimes to now, which only makes the check stricter.
// Exit code 1 when 1-3, 5, 6 (other-speaker), 8 or 10 find anything.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStreamLine, toMs } from "../src/hub/bee.js";
import { matchesProfile } from "../src/real/wearer.js";
import { CliBeeSource, pickUtterances } from "../src/bee/source.js";
import { parseTactiq, sameSpeaker, zonedToEpoch } from "../src/real/tactiq.js";
import { discoverWearerLabels, isWearer } from "../src/real/wearer.js";

const fold = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const shingles = (s: string, k = 5) => {
  const t = fold(s).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + k <= t.length; i++) out.push(t.slice(i, i + k).join(" "));
  return out;
};

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => f !== "package-lock.json" && statSync(f).size < 5_000_000);

const src = new CliBeeSource();
const me = await src.me();
const convs = [];
for (const s of await src.conversations(0)) {
  const c = await src.conversation(s.id);
  if (c) convs.push(c);
}
const counts: Record<string, number> = {};
for (const c of convs) for (const u of pickUtterances(c)) counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
const wearer = discoverWearerLabels(counts, me);
const other = new Map<string, number>(); // shingle -> earliest start (epoch ms) of a recording that has it
const addOther = (g: string, startMs: number) => other.set(g, Math.min(other.get(g) ?? Infinity, startMs));
const mine = new Set<string>();
const streets = new Set<string>();
for (const c of convs) {
  for (const u of pickUtterances(c)) for (const g of shingles(u.text)) if (isWearer(u.speaker, wearer)) mine.add(g); else addOther(g, c.start_time);
  const addr = c.primary_location?.address;
  if (addr) for (const w of fold(addr).split(" ")) if (w.length >= 5 && !/^\d+$/.test(w) && !["toronto", "canada", "district", "gardens"].includes(w)) streets.add(w);
}
// A shingle spoken by both the wearer and someone else is not evidence of a leak by itself, and
// neither is one made only of function words ("il n'y a pas de", "i don't know if the").
const FUNCTION = new Set(
  ("il elle on je j' tu vous nous ils n'y y a pas de du des le la les un une et est c'est ce que qui en ne n'est ca i you we it the a an and to of is that this in on for be do don't know if it's i'm so but " +
    // spoken fillers: a shingle like "um uh like you know" is a filler list, not anyone's words
    "um uh like yeah okay oh").split(" "),
);

// Meeting transcripts (Tactiq / Meet captions).
const argv = process.argv.slice(2);
const tactiq = argv.flatMap((a, i) => (a === "--tactiq" && argv[i + 1] ? [argv[i + 1]!] : []));
const meetWearer = argv[argv.indexOf("--wearer") + 1];
const names = new Set<string>(); // colleague name tokens and meeting-title phrases
if (tactiq.length && (!meetWearer || argv.indexOf("--wearer") < 0)) {
  console.error('--tactiq needs --wearer "<name>"');
  process.exit(2);
}
const GENERIC = new Set(["weekly", "daily", "sync", "up", "meeting", "standup", "stand", "call", "the", "and", "of", "team"]);
for (const f of tactiq) {
  const t = parseTactiq(readFileSync(f, "utf8"));
  const t0 = t.startedLocal ? zonedToEpoch(t.startedLocal, process.env.BEE_TZ ?? "America/Toronto") : 0;
  for (const l of t.lines) for (const g of shingles(l.text)) if (sameSpeaker(l.speaker, meetWearer!)) mine.add(g); else addOther(g, t0);
  const wearerToks = new Set(fold(meetWearer!).split(" "));
  for (const p of [...t.participants, ...new Set(t.lines.map((l) => l.speaker))])
    if (!sameSpeaker(p, meetWearer!)) for (const w of fold(p).split(" ")) if (w.length >= 3 && !wearerToks.has(w)) names.add(w);
  const title = fold(t.title ?? "").split(" ").filter((w) => w && !GENERIC.has(w)).join(" ");
  if (title) names.add(title);
}
// Bee live-stream captures.
const streams = argv.flatMap((a, i) => (a === "--stream" && argv[i + 1] ? [argv[i + 1]!] : []));
let streamLines = 0;
for (const f of streams) {
  const evs = readFileSync(f, "utf8").split("\n").map(parseStreamLine).filter((e) => e !== null);
  const wearerIds = new Set(evs.flatMap((e) => (e.type === "tagged-utterance" && me && e.person_first_name && matchesProfile(e.person_first_name, me) ? [e.utterance_id] : [])));
  for (const e of evs) {
    if (e.type !== "new-utterance") continue;
    streamLines++;
    for (const g of shingles(e.utterance.text)) if (wearerIds.has(e.utterance.id)) mine.add(g); else addOther(g, toMs(e.utterance.spoken_at ?? null) ?? 0);
  }
}
// Coach-hub attempts: the wearer's own words.
const hubAttempts = "real/hub-attempts.json";
let hubLines = 0;
if (existsSync(hubAttempts)) {
  for (const a of (JSON.parse(readFileSync(hubAttempts, "utf8")).attempts ?? []) as { provisional?: { text?: string } | null; bee?: { text?: string } | null }[]) {
    for (const t of [a.provisional?.text, a.bee?.text]) if (t) (hubLines++, shingles(t).forEach((g) => mine.add(g)));
  }
}
// Live-coaching state: the wearer's own words (recap moments and rephrases).
let liveStrings = 0;
const walkStrings = (v: unknown, f: (s: string) => void): void => {
  if (typeof v === "string") f(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, f));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => walkStrings(x, f));
};
const jsonFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? jsonFiles(join(dir, d.name)) : d.name.endsWith(".json") ? [join(dir, d.name)] : [])) : [];
for (const f of jsonFiles("real/live")) {
  try {
    walkStrings(JSON.parse(readFileSync(f, "utf8")), (t) => {
      const gs = shingles(t);
      if (gs.length) (liveStrings++, gs.forEach((g) => mine.add(g)));
    });
  } catch {
    /* a half-written file: skipped */
  }
}
// Coach principles and banned terms (held in memory only; never printed).
const principlesPath = "coach/principles.local.md";
const templatePath = "coach/principles.template.md";
const principles = new Set<string>();
if (existsSync(principlesPath)) {
  const generic = new Set(existsSync(templatePath) ? shingles(readFileSync(templatePath, "utf8")) : []);
  for (const g of shingles(readFileSync(principlesPath, "utf8"))) if (!generic.has(g)) principles.add(g);
}
const termsPath = "coach/private-terms.local.txt";
const terms = existsSync(termsPath)
  ? [...new Set(readFileSync(termsPath, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(fold).filter(Boolean))]
  : [];
// Private outputs must be git-ignored.
const PRIVATE = [
  "real/deck.json",
  "real/hub-attempts.json",
  "real/corpus.json",
  "real/live/recaps.json",
  "out/demo/deck.json",
  "out/contract-check/attempts.json",
  "out/alexa/skill.json",
  "cache/x.json",
  "fixtures/private/x.json",
  "coach/principles.local.md",
  "coach/private-terms.local.txt",
  "tv/web/dist/index.html",
  "tv/vega/build/x.js",
  "tv/vega/buildinfo.json",
  "tv/web/node_modules/x/index.js",
  "tv/vega/node_modules/x/index.js",
  "dist/web/phone/index.html",
  "dist/web/sim/index.html",
  "alexa/.ask/ask-states.json",
];
const notIgnored = PRIVATE.filter((p) => {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", p]);
    return false;
  } catch {
    return true;
  }
});
for (const s of [other, mine, principles]) for (const g of [...s.keys()]) if (g.split(" ").every((w) => FUNCTION.has(w))) s.delete(g);
for (const g of mine) other.delete(g);

let bad = 0;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;
if (streams.length || hubLines || liveStrings) console.log(`Also screened: ${streamLines} Bee stream line(s) from ${streams.length} capture(s), ${hubLines} hub attempt text(s), ${liveStrings} live-coaching string(s).`);
console.log(`Coach principles: ${existsSync(principlesPath) ? `${principles.size} private shingles` : "no local principles file"}; banned terms: ${existsSync(termsPath) ? terms.length : "no local terms file"}.`);
if (notIgnored.length) {
  bad++;
  console.log(`  private paths NOT git-ignored: ${notIgnored.join(", ")}`);
} else console.log(`Private output paths are git-ignored (${PRIVATE.length} checked).`);
console.log(`Checked ${files.length} files against ${other.size} other-speaker shingles, ${mine.size} wearer shingles, ${streets.size} address tokens (from ${convs.length} conversations${tactiq.length ? ` and ${tactiq.length} meeting transcripts` : ""}), ${names.size} colleague-name / title tokens.`);
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  const text = ` ${fold(raw)} `;
  const mtime = statSync(f).mtimeMs;
  const otherAll = [...other].filter(([g]) => text.includes(` ${g} `));
  const otherHits = otherAll.filter(([, t0]) => t0 < mtime).length;
  const predates = otherAll.length - otherHits;
  const mineHits = [...mine].filter((g) => text.includes(` ${g} `)).length;
  const addrHits = [...streets].filter((w) => text.includes(` ${w} `)).length;
  const jwt = (raw.match(JWT) ?? []).length + (raw.match(/Bearer\s+[A-Za-z0-9._-]{20,}/g) ?? []).length;
  const nameHits = [...names].filter((w) => text.includes(` ${w} `)).length;
  const principleHits = [...principles].filter((g) => text.includes(` ${g} `)).length;
  const termHits = terms.filter((t) => text.includes(` ${t} `)).length;
  if (otherHits || addrHits || jwt || nameHits || principleHits || termHits) bad++;
  if (otherHits || mineHits || addrHits || jwt || nameHits || principleHits || termHits)
    console.log(`  ${f}: other-speaker ${otherHits}, wearer ${mineHits}, address ${addrHits}, token-like ${jwt}, colleague-name/title ${nameHits}, private-principles ${principleHits}, banned-term ${termHits}${predates ? ` (+${predates} other-speaker shingle(s) in a file older than the recording: predates)` : ""}`);
  else if (predates) console.log(`  ${f}: predates ${predates} (other-speaker shingle(s) in a file last modified before the recording; not a leak)`);
}
console.log(bad ? `LEAK CHECK: FAIL (${bad} file(s))` : "LEAK CHECK: PASS (no other-speaker text, colleague name, meeting title, address, token, private principle or banned term in committable files)");
process.exit(bad ? 1 : 0);
