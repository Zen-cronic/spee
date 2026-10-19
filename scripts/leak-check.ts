// Leak check for files that could be committed (tracked + untracked-not-ignored).
//   npx tsx scripts/leak-check.ts
// 1. Other speakers' text, from the live Bee data (held in memory only), searched for in each file:
//    - every 5-word shingle of every non-wearer utterance;
//    - every whole non-wearer utterance of 3 or 4 words, as an exact phrase (a short line has no
//      5-word shingle), unless it is made only of function words or has fewer than 2 content words.
//    Prints counts, never the text.
// 2. Location: conversation addresses' street tokens.
// 3. Credentials: JWT-shaped strings (the bee token is a JWT) and "Bearer " headers.
// 4. Wearer excerpts: 5-word shingles of the wearer's own lines; the report may hold <= 10 short
//    excerpts, so hits should appear only in REAL_DATA_REPORT.md and stay small.
// 5. Meeting transcripts (optional): `--wearer "<name>" --tactiq <file.txt> [--tactiq <file2.txt>]`
//    adds every other speaker's text (as in 1), colleagues' name tokens and the meeting title
//    (all held in memory only; pass the paths on the command line so no meeting name is tracked).
// 6. Bee live-stream captures (optional): `--stream <capture.log>` (lines of `bee stream --json`
//    output). Lines Bee tagged as the wearer count as the wearer's; every other line (untagged,
//    or tagged as someone else) counts as other-speaker text, conservatively.
// 7. What counts as the wearer's: only lines a source labels as the wearer (Bee's profile-name label,
//    BEE_WEARER_LABELS, a wearer-tagged stream line, the --wearer meeting speaker). When `bee me`
//    fails and BEE_WEARER_LABELS is unset, nothing is the wearer's. A shingle some other speaker said
//    stays on the other-speaker list unless the wearer said it EARLIER, in a SEPARATE recording.
//    The hub's own state (real/hub-attempts.json, real/live/**/*.json, gitignored) is never treated
//    as the wearer's: it is screened like a committable file, and other-speaker text found there is
//    reported as a privacy-invariant warning (those files must only hold Bee-wearer-tagged lines).
//    Phrases that are the product's own Alexa commands (sample utterances in the committed
//    interaction model, e.g. "how did I do") are set aside: users say them to the coach.
// 8. Private outputs: real/, out/, cache/, the hub's state files, the live-coaching state, the
//    private coach principles and the build outputs must be git-ignored.
// 9. Files: read as a stream (any size; 5 MB and up included), with JSON escapes undone first (so
//    "x\nnext" is two words). Audio files (mp3, wav, m4a, ...) that could be committed FAIL: Bee
//    stores no audio, and a recording would carry other speakers' voices. Images (png, jpg, ...)
//    cannot be text-screened but can show drill or live text, so each one FAILS unless a person has
//    looked at it and its sha256 is in leak-check-images.txt (`--approve-images` records the current
//    images after that look; a changed image needs a new look). Other binary files (archives, fonts)
//    are listed by count.
// 10. Coach principles (contract v2): when coach/principles.local.md exists, any of its 5-word
//    shingles in a committable file FAILS the check, whatever the file's age. Shingles also in the
//    committed generic template, or made only of function words, are not private. When
//    coach/private-terms.local.txt exists, every non-empty line not starting with "#" is a banned
//    term (case-insensitive, whole words); any hit FAILS. Counts only are printed, never the text.
// Provenance: a file committed before a conversation or meeting started, and unchanged since, cannot
// contain its text, so such a shingle hit is reported as "predates" and does not fail the check
// (generic phrases in synthetic fixtures written before a later recording). The date is the file's
// last commit, not its mtime (cp -p, tar and rsync -t keep an old mtime on new content); an
// untracked file, or one with uncommitted changes, dates from now. Files written before the repo
// existed can only be dated by mtime: a person vouches for those with `--approve-predates`, which
// records each file whose hits all predate the recording by mtime in leak-check-predates.txt
// (sha256 + path). Only an approved, unchanged file has its mtime believed.
// Exit code 1 when 1-3, 5, 6 (other-speaker), 8, 9 (audio, unreviewed images) or 10 find anything.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { parseStreamLine, toMs } from "../src/hub/bee.js";
import { matchesProfile } from "../src/real/wearer.js";
import { CliBeeSource, pickUtterances } from "../src/bee/source.js";
import { parseTactiq, sameSpeaker, zonedToEpoch } from "../src/real/tactiq.js";
import { discoverWearerLabels, isWearer, type WearerLabels } from "../src/real/wearer.js";

const fold = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => fold(s).split(" ").filter(Boolean);
const shingles = (s: string, k = 5) => {
  const t = words(s);
  const out: string[] = [];
  for (let i = 0; i + k <= t.length; i++) out.push(t.slice(i, i + k).join(" "));
  return out;
};
// JSON and JS string escapes: "a\nb" is two words, "é" is "é".
const unescape = (s: string) =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrtbf]/g, " ")
    .replace(/\\(["'\\/])/g, "$1");

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => f !== "package-lock.json" && existsSync(f));

// When each committable file last changed, from git (see Provenance above).
const committedAt = new Map<string, number>();
{
  let t = 0;
  for (const line of execFileSync("git", ["-c", "core.quotePath=false", "log", "--format=%x00%ct", "--name-only", "--no-renames"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
    if (line.startsWith("\0")) t = Number(line.slice(1)) * 1000;
    else if (line && !committedAt.has(line)) committedAt.set(line, t);
  }
}
const uncommitted = new Set(execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean));
const changedAt = (f: string) => (uncommitted.has(f) ? Date.now() : (committedAt.get(f) ?? Date.now()));

// A shingle spoken by both the wearer and someone else is not evidence of a leak by itself, and
// neither is one made only of function words ("il n'y a pas de", "i don't know if the").
const FUNCTION = new Set(
  ("il elle on je j' tu vous nous ils n'y y a pas de du des le la les un une et est c'est ce que qui en ne n'est ca i you we it the a an and to of is that this in on for be do don't know if it's i'm so but " +
    // spoken fillers: a shingle like "um uh like you know" is a filler list, not anyone's words
    "um uh like yeah okay oh").split(" "),
);
const allFunction = (g: string) => g.split(" ").every((w) => FUNCTION.has(w));

// Occurrences: per phrase, the recordings it was said in and the earliest time in each.
type Occ = Map<string, number>; // recording id -> earliest start (epoch ms)
const other = new Map<string, Occ>(); // 5-word shingles
const otherShort = new Map<string, Occ>(); // whole 3-4 word lines
const mine = new Map<string, Occ>();
const mineShort = new Map<string, Occ>();
const add = (m: Map<string, Occ>, g: string, rec: string, t: number) => {
  const o = m.get(g) ?? new Map<string, number>();
  o.set(rec, Math.min(o.get(rec) ?? Infinity, t));
  m.set(g, o);
};
const shortLine = (text: string): string | null => {
  const t = words(text);
  if (t.length < 3 || t.length > 4) return null;
  return t.filter((w) => !FUNCTION.has(w)).length >= 2 ? t.join(" ") : null;
};
const addLine = (text: string, wearer: boolean, rec: string, t: number) => {
  for (const g of shingles(text)) add(wearer ? mine : other, g, rec, t);
  const s = shortLine(text);
  if (s) add(wearer ? mineShort : otherShort, s, rec, t);
};

const src = new CliBeeSource();
const me = await src.me().catch(() => null);
const convs = [];
for (const s of await src.conversations(0)) {
  const c = await src.conversation(s.id);
  if (c) convs.push(c);
}
const counts: Record<string, number> = {};
for (const c of convs) for (const u of pickUtterances(c)) counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
// Only a label the profile (or BEE_WEARER_LABELS) names is the wearer's; never a guess.
const found = discoverWearerLabels(counts, me);
const wearer: WearerLabels = found.method === "env" || found.method === "profile-name" ? found : { labels: [], method: "none", counts };
if (wearer.method === "none") console.log(`Wearer: no profile-name label (${me ? "bee me ok" : "bee me failed"}); every Bee line counts as another speaker's.`);
const streets = new Set<string>();
for (const c of convs) {
  for (const u of pickUtterances(c)) addLine(u.text, isWearer(u.speaker, wearer), `bee:${c.id}`, c.start_time);
  const addr = c.primary_location?.address;
  if (addr) for (const w of words(addr)) if (w.length >= 5 && !/^\d+$/.test(w) && !["toronto", "canada", "district", "gardens"].includes(w)) streets.add(w);
}

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
  for (const l of t.lines) addLine(l.text, sameSpeaker(l.speaker, meetWearer!), `tactiq:${f}`, t0);
  const wearerToks = new Set(words(meetWearer!));
  for (const p of [...t.participants, ...new Set(t.lines.map((l) => l.speaker))])
    if (!sameSpeaker(p, meetWearer!)) for (const w of words(p)) if (w.length >= 3 && !wearerToks.has(w)) names.add(w);
  const title = words(t.title ?? "").filter((w) => !GENERIC.has(w)).join(" ");
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
    addLine(e.utterance.text, wearerIds.has(e.utterance.id), `stream:${f}:${e.conversation_uuid ?? "?"}`, toMs(e.utterance.spoken_at ?? null) ?? 0);
  }
}

// Function-word-only shingles are nobody's words.
for (const m of [other, mine]) for (const g of [...m.keys()]) if (allFunction(g)) m.delete(g);
// The wearer's earlier line in a separate recording explains a shared phrase; nothing else does.
const explained = (theirs: Occ, ours: Occ | undefined) => {
  if (!ours) return false;
  const first = Math.min(...theirs.values());
  for (const [rec, t] of ours) if (!theirs.has(rec) && t < first) return true;
  return false;
};
let shared = 0;
for (const [m, w] of [
  [other, mine],
  [otherShort, mineShort],
] as const)
  for (const [g, occ] of [...m]) if (explained(occ, w.get(g))) (m.delete(g), shared++);
const earliest = (o: Occ) => Math.min(...o.values());
// The product's own command phrases (the committed Alexa interaction model's sample utterances, slots
// removed): people are expected to say "how did I do" to the coach, so hearing one in a recording
// is not someone's private words. Only exact commands (or shingles inside one) are set aside.
const commands = new Set<string>();
for (const f of ["alexa/skill-package/interactionModels/custom/en-US.json", "alexa/skill-package/interactionModels/custom/en-CA.json"]) {
  if (!existsSync(f)) continue;
  const lm = (JSON.parse(readFileSync(f, "utf8")) as { interactionModel?: { languageModel?: { intents?: { samples?: string[] }[] } } }).interactionModel?.languageModel;
  for (const i of lm?.intents ?? []) for (const s of i.samples ?? []) {
    const c = words(s.replace(/\{[^}]*\}/g, " ")).join(" ");
    if (c) commands.add(c);
  }
}
let product = 0;
for (const g of [...otherShort.keys()]) if (commands.has(g)) (otherShort.delete(g), product++);
for (const g of [...other.keys()]) if ([...commands].some((c) => ` ${c} `.includes(` ${g} `))) (other.delete(g), product++);

// Coach principles and banned terms (held in memory only; never printed).
const principlesPath = "coach/principles.local.md";
const templatePath = "coach/principles.template.md";
const principles = new Set<string>();
if (existsSync(principlesPath)) {
  const generic = new Set(existsSync(templatePath) ? shingles(readFileSync(templatePath, "utf8")) : []);
  for (const g of shingles(readFileSync(principlesPath, "utf8"))) if (!generic.has(g) && !allFunction(g)) principles.add(g);
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

// Phrases looked up by length: every n-word window of a file is checked against these tables.
const tables = { other: [...other.keys()], short: [...otherShort.keys()], mine: [...mine.keys()], principle: [...principles], term: terms, name: [...names], street: [...streets] };
type Kind = keyof typeof tables;
const lookup = new Map<number, Map<string, Kind[]>>();
for (const [kind, list] of Object.entries(tables) as [Kind, string[]][])
  for (const p of list) {
    const n = p.split(" ").length;
    const m = lookup.get(n) ?? new Map<string, Kind[]>();
    const ks = m.get(p) ?? [];
    if (!ks.includes(kind)) ks.push(kind);
    m.set(p, ks);
    lookup.set(n, m);
  }
const lengths = [...lookup.keys()].sort((a, b) => a - b);
const maxN = Math.max(1, ...lengths);

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]{20,}/g;
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".avif"]);
const REVIEWED_IMAGES = "leak-check-images.txt";
const APPROVED_PREDATES = "leak-check-predates.txt";
const ledger = (path: string) => new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l && !l.startsWith("#")) : []);
const sha256 = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".aif", ".aiff", ".caf", ".amr", ".wma", ".weba", ".mka"]);
const isBinary = (f: string) => {
  const fd = openSync(f, "r");
  try {
    const b = Buffer.alloc(8192);
    const n = readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
};

type Hits = Record<Kind, Set<string>> & { jwt: number };
// Streams a file (any size): JSON escapes undone, folded, then every 1..maxN word window looked up.
async function scan(f: string): Promise<Hits> {
  const hits = Object.fromEntries(Object.keys(tables).map((k) => [k, new Set<string>()])) as unknown as Hits;
  hits.jwt = 0;
  let carry = ""; // the raw text after the last whitespace of the previous chunk
  let prev: string[] = []; // the last maxN-1 words of the previous chunk
  const eat = (raw: string, last: boolean) => {
    let text = carry + raw;
    if (!last) {
      const cut = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
      carry = cut >= 0 ? text.slice(cut + 1) : text;
      text = cut >= 0 ? text.slice(0, cut + 1) : "";
    } else carry = "";
    if (!text) return;
    hits.jwt += (text.match(JWT) ?? []).length + (text.match(BEARER) ?? []).length;
    const w = [...prev, ...words(unescape(text))];
    const start = prev.length;
    for (let i = 0; i < w.length; i++)
      for (const n of lengths) {
        const s = i - n + 1;
        if (s < 0 || i < start) continue;
        const ks = lookup.get(n)!.get(w.slice(s, i + 1).join(" "));
        if (ks) for (const k of ks) hits[k].add(w.slice(s, i + 1).join(" "));
      }
    prev = w.slice(Math.max(0, w.length - (maxN - 1)));
  };
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(f, { encoding: "utf8", highWaterMark: 1 << 20 });
    rs.on("data", (c) => eat(String(c), false));
    rs.on("end", () => (eat("", true), resolve()));
    rs.on("error", reject);
  });
  return hits;
}

// The hub's own state: other-speaker text there breaks the privacy invariant (never an allow-list).
const jsonFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? jsonFiles(join(dir, d.name)) : d.name.endsWith(".json") ? [join(dir, d.name)] : [])) : [];
const state = ["real/hub-attempts.json", ...jsonFiles("real/live")].filter((f) => existsSync(f));

let bad = 0;
if (streams.length) console.log(`Also screened: ${streamLines} Bee stream line(s) from ${streams.length} capture(s).`);
console.log(`Coach principles: ${existsSync(principlesPath) ? `${principles.size} private shingles` : "no local principles file"}; banned terms: ${existsSync(termsPath) ? terms.length : "no local terms file"}.`);
if (notIgnored.length) {
  bad++;
  console.log(`  private paths NOT git-ignored: ${notIgnored.join(", ")}`);
} else console.log(`Private output paths are git-ignored (${PRIVATE.length} checked).`);
console.log(
  `Checked ${files.length} files against ${other.size} other-speaker shingles and ${otherShort.size} short other-speaker lines (${shared} shared phrase(s) explained by an earlier wearer recording, ${product} product command phrase(s) set aside), ${mine.size} wearer shingles, ${streets.size} address tokens (from ${convs.length} conversations${tactiq.length ? ` and ${tactiq.length} meeting transcripts` : ""}), ${names.size} colleague-name / title tokens.`,
);
const binaries: string[] = [];
const images = files.filter((f) => IMAGES.has(extname(f).toLowerCase()));
if (argv.includes("--approve-images")) {
  writeFileSync(REVIEWED_IMAGES, `# Images a person has looked at for drill, live or other-speaker text (scripts/leak-check.ts --approve-images).\n${images.map((f) => `${sha256(f)}  ${f}`).join("\n")}\n`);
  console.log(`Recorded ${images.length} image(s) as reviewed in ${REVIEWED_IMAGES}. Run this only after looking at every one.`);
}
const reviewed = ledger(REVIEWED_IMAGES);
const approved = ledger(APPROVED_PREDATES);
const approvable: string[] = [];
let unreviewed = 0;
let largest = 0;
for (const f of files) {
  const st = statSync(f);
  largest = Math.max(largest, st.size);
  if (AUDIO.has(extname(f).toLowerCase())) {
    bad++;
    console.log(`  ${f}: committable AUDIO file (${st.size} bytes): recordings carry other speakers' voices; keep audio out of the repository`);
    continue;
  }
  if (IMAGES.has(extname(f).toLowerCase())) {
    if (!reviewed.has(`${sha256(f)}  ${f}`)) (bad++, unreviewed++, console.log(`  ${f}: image not reviewed (new or changed): look at it for drill, live or other-speaker text, then run with --approve-images`));
    continue;
  }
  if (isBinary(f)) {
    binaries.push(f);
    continue;
  }
  const h = await scan(f);
  const fresh = (set: Set<string>, occ: Map<string, Occ>, since: number) => [...set].filter((g) => earliest(occ.get(g)!) < since).length;
  let since = changedAt(f);
  if (h.other.size + h.short.size && st.mtimeMs < since) {
    const byMtime = fresh(h.other, other, st.mtimeMs) + fresh(h.short, otherShort, st.mtimeMs);
    const key = `${sha256(f)}  ${f}`;
    if (approved.has(key)) since = st.mtimeMs;
    else if (byMtime === 0) approvable.push(key);
  }
  const otherHits = fresh(h.other, other, since);
  const shortHits = fresh(h.short, otherShort, since);
  const predates = h.other.size + h.short.size - otherHits - shortHits;
  const [mineHits, addrHits, nameHits, principleHits, termHits] = [h.mine.size, h.street.size, h.name.size, h.principle.size, h.term.size];
  if (otherHits || shortHits || addrHits || h.jwt || nameHits || principleHits || termHits) bad++;
  if (otherHits || shortHits || mineHits || addrHits || h.jwt || nameHits || principleHits || termHits)
    console.log(
      `  ${f}: other-speaker ${otherHits}, short other-speaker line ${shortHits}, wearer ${mineHits}, address ${addrHits}, token-like ${h.jwt}, colleague-name/title ${nameHits}, private-principles ${principleHits}, banned-term ${termHits}${predates ? ` (+${predates} other-speaker hit(s) in a file older than the recording: predates)` : ""}`,
    );
  else if (predates) console.log(`  ${f}: predates ${predates} (other-speaker hit(s) in a file dated before the recording by git or an approved mtime; not a leak)`);
}
console.log(`Images: ${images.length - unreviewed} of ${images.length} reviewed (${REVIEWED_IMAGES}).`);
if (approvable.length && argv.includes("--approve-predates")) {
  writeFileSync(APPROVED_PREDATES, `# Files whose other-speaker hits all predate the recording by mtime, vouched for by a person (scripts/leak-check.ts --approve-predates).\n${[...approved, ...approvable].sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
  console.log(`Recorded ${approvable.length} file(s) in ${APPROVED_PREDATES}; re-run the check to apply. Approve only files you know were not copied in with an old mtime.`);
} else if (approvable.length) console.log(`${approvable.length} failing file(s) above predate the recording by mtime only (written before their first commit): if none was copied in with an old mtime, run with --approve-predates.`);
if (binaries.length) console.log(`Binary files not text-screened (archives, fonts): ${binaries.length}.`);
console.log(`Largest committable file: ${largest} bytes (every size is screened).`);
let stateWarn = 0;
for (const f of state) {
  const h = await scan(f);
  const n = h.other.size + h.short.size;
  if (n) (stateWarn++, console.log(`  WARNING ${f} (hub state, git-ignored): other-speaker ${h.other.size}, short other-speaker line ${h.short.size}. Only Bee-wearer-tagged lines may persist: check the attempt sources.`));
}
if (state.length) console.log(`Hub state screened: ${state.length} file(s), ${stateWarn} with other-speaker text.`);
console.log(bad ? `LEAK CHECK: FAIL (${bad} file(s))` : "LEAK CHECK: PASS (no other-speaker text, colleague name, meeting title, address, token, private principle, banned term, audio or unreviewed image in committable files)");
process.exit(bad ? 1 : 0);
