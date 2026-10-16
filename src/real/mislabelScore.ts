// Seeded mislabel sample + precision/recall scorer from the operator's labels.
import { createHash } from "node:crypto";
import type { WearerLine } from "./corpus.js";

// Blind labelling sample: every flagged line, plus a seeded sample of unflagged lines stratified
// so recall can be estimated where mislabels actually occur (sessions with any flag) and checked
// elsewhere.
export function sampleForLabelling(lines: WearerLine[], opts: { inFlaggedSessions?: number; elsewhere?: number; seed?: string } = {}): WearerLine[] {
  const seed = opts.seed ?? "mislabel-v1";
  const h = (l: WearerLine) => createHash("sha256").update(`${seed}|${l.key}`).digest("hex");
  const byHash = (a: WearerLine, b: WearerLine) => (h(a) < h(b) ? -1 : 1);
  const flagged = lines.filter((l) => l.uncertain);
  const hot = new Set(flagged.map((l) => l.session));
  const restHot = lines.filter((l) => !l.uncertain && hot.has(l.session)).sort(byHash).slice(0, opts.inFlaggedSessions ?? 20);
  const restCold = lines.filter((l) => !l.uncertain && !hot.has(l.session)).sort(byHash).slice(0, opts.elsewhere ?? 10);
  // Interleave deterministically so flagged lines are not clustered at the top.
  return [...flagged, ...restHot, ...restCold].sort(byHash);
}

export type Label = "me" | "not" | "mixed" | "skip";

export function parseLabels(md: string): Map<string, Label | "?"> {
  const out = new Map<string, Label | "?">();
  let key: string | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^## \d+\. (\S+)/);
    if (h) key = h[1]!;
    const m = line.match(/^label:\s*(\S+)/i);
    if (m && key) {
      const v = m[1]!.toLowerCase().replace(/[`*]/g, "");
      out.set(key, (["me", "not", "mixed", "skip"].includes(v) ? v : "?") as Label | "?");
      key = null;
    }
  }
  return out;
}

// Positive class = "not purely the wearer" (not or mixed). The detector should flag these.
export function scoreLabels(labels: Map<string, Label | "?">, flaggedKeys: Set<string>) {
  let tp = 0, fp = 0, fn = 0, tn = 0, unlabelled = 0;
  for (const [k, v] of labels) {
    if (v === "?" || v === "skip") {
      unlabelled++;
      continue;
    }
    const pos = v === "not" || v === "mixed";
    const flag = flaggedKeys.has(k);
    if (flag && pos) tp++;
    else if (flag && !pos) fp++;
    else if (!flag && pos) fn++;
    else tn++;
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return { labelled: tp + fp + fn + tn, unlabelled, tp, fp, fn, tn, precision: pct(tp, tp + fp), recallInSample: pct(tp, tp + fn), mislabelRateUnflagged: pct(fn, fn + tn) };
}
