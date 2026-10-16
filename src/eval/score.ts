// Evaluation against the hidden truth key. The ONLY module allowed to read fixtures/_truth.
import { readFileSync } from "node:fs";
import type { Item, Session } from "../analyze/extract.js";
import type { Lang } from "../analyze/taxonomy.js";
import type { Truth } from "../sim/world.js";

export const loadTruth = (lang: Lang): Truth => JSON.parse(readFileSync(`fixtures/_truth/${lang}.json`, "utf8"));

export interface Score {
  items: number;
  citationValid: number;
  grounded: number;
  asrSuspect: number;
  tpWearer: number;
  tpOther: number;
  wrongTypeOnPlanted: number;
  fpOnWearerLine: number;
  fpOnOtherLine: number;
  onOtherSpeakerLine: number;
  wearerInstances: number;
  recalledWearer: number;
  allInstances: number;
  recalledAll: number;
}

export function score(truth: Truth, items: Item[], sessions: Session[]): Score {
  const sessionIds = new Set(sessions.map((s) => s.id));
  const its = items.filter((i) => sessionIds.has(i.session_id));
  const keys = new Set(sessions.flatMap((s) => s.segments.map((g) => g.key)));
  const inst = truth.instances.filter((t) => keys.has(t.key));
  const instBy = new Map<string, typeof inst>();
  for (const t of inst) instBy.set(t.key, [...(instBy.get(t.key) ?? []), t]);
  const s: Score = { items: its.length, citationValid: 0, grounded: 0, asrSuspect: 0, tpWearer: 0, tpOther: 0, wrongTypeOnPlanted: 0, fpOnWearerLine: 0, fpOnOtherLine: 0, onOtherSpeakerLine: 0, wearerInstances: 0, recalledWearer: 0, allInstances: inst.length, recalledAll: 0 };
  const hit = new Set<string>();
  for (const i of its) {
    if (i.citation_valid) s.citationValid++;
    if (i.excerpt_grounded) s.grounded++;
    if (i.asr_suspect) s.asrSuspect++;
    if (!i.citation_valid) continue;
    const who = truth.utterances[i.utterance_id];
    if (who?.role === "other") s.onOtherSpeakerLine++;
    const planted = instBy.get(i.utterance_id) ?? [];
    const match = planted.find((t) => t.type === i.error_type);
    if (match) {
      hit.add(`${match.key}|${match.type}`);
      if (match.role === "wearer") s.tpWearer++;
      else s.tpOther++;
    } else if (planted.length) s.wrongTypeOnPlanted++;
    else if (who?.role === "other") s.fpOnOtherLine++;
    else s.fpOnWearerLine++;
  }
  for (const t of inst) {
    if (t.role === "wearer") s.wearerInstances++;
    if (hit.has(`${t.key}|${t.type}`)) {
      s.recalledAll++;
      if (t.role === "wearer") s.recalledWearer++;
    }
  }
  return s;
}

export const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);

// Per-type recurrence: detections (or truth instances) per session, pre vs post cutover.
export interface Recurrence {
  type: string;
  arm: "drilled" | "control";
  pre: number;
  post: number;
  ratio: number | null;
}
export function recurrence(sessions: Session[], cutoverMs: number, types: Record<string, "drilled" | "control">, count: (type: string, s: Session) => number): Recurrence[] {
  const pre = sessions.filter((s) => s.startMs <= cutoverMs);
  const post = sessions.filter((s) => s.startMs > cutoverMs);
  const rate = (ss: Session[], t: string) => (ss.length ? ss.reduce((n, s) => n + count(t, s), 0) / ss.length : 0);
  return Object.entries(types).map(([type, arm]) => {
    const a = rate(pre, type);
    const b = rate(post, type);
    return { type, arm, pre: Math.round(a * 100) / 100, post: Math.round(b * 100) / 100, ratio: a > 0 ? Math.round((b / a) * 100) / 100 : null };
  });
}
export function armMean(rs: Recurrence[], arm: "drilled" | "control"): number | null {
  const xs = rs.filter((r) => r.arm === arm && r.ratio != null).map((r) => r.ratio!);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
}
export function truthCounter(truth: Truth) {
  return (type: string, s: Session) => {
    const keys = new Set(s.segments.map((g) => g.key));
    return truth.instances.filter((t) => t.role === "wearer" && t.type === type && keys.has(t.key)).length;
  };
}
