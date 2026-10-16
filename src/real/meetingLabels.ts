// Labelling sheet for English communication coaching on meetings: every English drill the pipeline
// keeps, plus a seeded random sample of filler / hedge hits. The operator marks each entry
// R (real habit worth coaching), T (transcription artifact) or N (real but not worth coaching);
// `npm run meetings:score` turns the marks into precision. The sheet quotes the wearer's own lines
// only and lives in gitignored out/.
import { createHash } from "node:crypto";
import type { Drill } from "./analyze.js";
import type { WearerLine } from "./corpus.js";
import { FILLER_RE, HEDGE_RE } from "./text.js";

export interface LabelEntry {
  id: string; // D<n> for drills, H<n> for filler / hedge hits
  group: "drill" | "filler" | "hedge";
  type: string; // error type, EN_FILLERS, or the matched filler / hedge
  key: string;
  session: string;
  context: string; // the wearer's line (drills) or a window around the hit, hit marked «…»
  flagged: string;
  fix: string;
  resay?: string;
  why?: string;
}

const tidy = (s: string) =>
  s
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/([.?!]),/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+/, "")
    .trim();

function mark(text: string, needle: string): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  return i < 0 || !needle ? text : `${text.slice(0, i)}«${text.slice(i, i + needle.length)}»${text.slice(i + needle.length)}`;
}

// Every occurrence of a filler / hedge in the wearer's English lines, with a word window around it.
export interface Hit {
  group: "filler" | "hedge";
  match: string;
  key: string;
  session: string;
  at: number; // char offset in the line
  context: string;
  fix: string;
}

export function hits(lines: WearerLine[], window = 12): Hit[] {
  const out: Hit[] = [];
  for (const l of lines.filter((x) => x.dom === "en" && !x.uncertain)) {
    for (const [group, re] of [["filler", FILLER_RE.en], ["hedge", HEDGE_RE.en]] as const) {
      for (const m of l.text.matchAll(new RegExp(re.source, re.flags))) {
        const at = m.index!;
        const before = l.text.slice(0, at).split(/\s+/).filter(Boolean);
        const after = l.text.slice(at + m[0].length).split(/\s+/).filter(Boolean);
        const pre = before.slice(-window).join(" ");
        const post = after.slice(0, window).join(" ");
        const head = before.length > window ? "… " : "";
        const tail = after.length > window ? " …" : "";
        out.push({
          group,
          match: m[0].toLowerCase(),
          key: l.key,
          session: l.session,
          at,
          context: tidy(`${head}${pre} «${m[0]}» ${post}${tail}`),
          fix: tidy(`${head}${pre} ${post}${tail}`),
        });
      }
    }
  }
  return out;
}

const h = (seed: string, s: string) => createHash("sha256").update(`${seed}|${s}`).digest("hex");

export function buildLabelSample(drills: Drill[], lines: WearerLine[], opts: { fillers?: number; hedges?: number; seed?: string } = {}): LabelEntry[] {
  const seed = opts.seed ?? "meetings-v1";
  const en = drills.filter((d) => d.lang === "en");
  const entries: LabelEntry[] = en.map((d, i) => ({
    id: `D${i + 1}`,
    group: "drill",
    type: d.type,
    key: d.key,
    session: d.session,
    context: d.kind === "filler" ? d.line : mark(d.line, d.said),
    flagged: d.kind === "filler" ? "fillers in this line" : d.said,
    fix: d.fix,
    resay: d.kind === "filler" ? undefined : d.resay,
    why: d.why,
  }));
  const all = hits(lines);
  const pick = (g: Hit["group"], n: number) =>
    all
      .filter((x) => x.group === g)
      .sort((a, b) => (h(seed, `${a.key}|${a.at}`) < h(seed, `${b.key}|${b.at}`) ? -1 : 1))
      .slice(0, n);
  const sampled = [...pick("filler", opts.fillers ?? 10), ...pick("hedge", opts.hedges ?? 5)].sort((a, b) => (h(seed, `o|${a.key}|${a.at}`) < h(seed, `o|${b.key}|${b.at}`) ? -1 : 1));
  sampled.forEach((x, i) =>
    entries.push({ id: `H${i + 1}`, group: x.group, type: x.match, key: x.key, session: x.session, context: x.context, flagged: x.match, fix: x.fix }),
  );
  return entries;
}

const q = (s: string) => s.replace(/\n/g, " ");

export function renderLabelSheet(entries: LabelEntry[], meta: { meetings: string[]; hitsTotal: { filler: number; hedge: number } }): string {
  const out = [
    "# Meetings: label the English coaching",
    "",
    "Private (gitignored). Your own lines only, from the meeting caption transcripts (" + meta.meetings.join(", ") + ").",
    "",
    "For each entry put one letter inside the brackets after `Mark:`:",
    "",
    "- `R`: real. You really said it, and it is a habit worth coaching.",
    "- `T`: transcription artifact. The captioner misheard you, so this was not what you said.",
    "- `N`: not worth coaching. You said it, but it is fine, too minor, or the fix is wrong.",
    "",
    "Leave `[ ]` blank to skip. Then run `npm run meetings:score`.",
    "",
    `Part 1 has every English drill the pipeline kept (D1–D${entries.filter((e) => e.group === "drill").length}). Part 2 is a seeded random sample of filler and hedge hits (of ${meta.hitsTotal.filler} filler and ${meta.hitsTotal.hedge} hedge hits in total); the hit is marked «like this».`,
    "",
    "## Part 1: drills",
    "",
  ];
  const one = (e: LabelEntry) => {
    out.push(`### ${e.id} · ${e.type} · ${e.session}`, "");
    out.push(`- Line \`${e.key}\`: ${q(e.context)}`);
    out.push(`- Flagged: "${q(e.flagged)}"`);
    out.push(`- Fix: "${q(e.fix)}"`);
    if (e.resay) out.push(`- Re-say: ${q(e.resay)}`);
    if (e.why) out.push(`- Why: ${q(e.why)}`);
    out.push("- Mark: [ ]", "");
  };
  const drills = entries.filter((e) => e.group === "drill");
  if (!drills.length) out.push("_No English drills were kept._", "");
  drills.forEach(one);
  out.push("## Part 2: filler and hedge hits", "");
  entries.filter((e) => e.group !== "drill").forEach((e) => {
    out.push(`### ${e.id} · ${e.group}: ${e.type} · ${e.session}`, "");
    out.push(`- Line \`${e.key}\`: ${q(e.context)}`);
    out.push(`- Fix: ${e.group === "filler" ? "pause silently instead" : "drop the hedge"}: "${q(e.fix)}"`);
    out.push("- Mark: [ ]", "");
  });
  return out.join("\n");
}

export type Mark = "R" | "T" | "N";

export function parseMarks(md: string): Map<string, Mark | null> {
  const out = new Map<string, Mark | null>();
  let id: string | null = null;
  for (const line of md.split("\n")) {
    const hd = line.match(/^###\s+([DH]\d+)\b/);
    if (hd) id = hd[1]!;
    const m = line.match(/^-\s*Mark:\s*\[\s*([^\]]*?)\s*\]/i);
    if (m && id) {
      const v = m[1]!.replace(/[`*]/g, "").toUpperCase();
      out.set(id, v === "R" || v === "T" || v === "N" ? v : null);
      id = null;
    }
  }
  return out;
}

export interface GroupScore {
  entries: number;
  labelled: number;
  R: number;
  T: number;
  N: number;
  precision: number | null; // R / labelled, %
  artifactRate: number | null; // T / labelled, %
}

export function scoreMarks(entries: Pick<LabelEntry, "id" | "group" | "type">[], marks: Map<string, Mark | null>) {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const score = (es: typeof entries): GroupScore => {
    const c = { R: 0, T: 0, N: 0 };
    for (const e of es) {
      const m = marks.get(e.id);
      if (m) c[m]++;
    }
    const labelled = c.R + c.T + c.N;
    return { entries: es.length, labelled, ...c, precision: pct(c.R, labelled), artifactRate: pct(c.T, labelled) };
  };
  const byType: Record<string, GroupScore> = {};
  for (const t of new Set(entries.filter((e) => e.group === "drill").map((e) => e.type))) byType[t] = score(entries.filter((e) => e.group === "drill" && e.type === t));
  return {
    drills: score(entries.filter((e) => e.group === "drill")),
    drillsByType: byType,
    fillers: score(entries.filter((e) => e.group === "filler")),
    hedges: score(entries.filter((e) => e.group === "hedge")),
    all: score(entries),
  };
}
