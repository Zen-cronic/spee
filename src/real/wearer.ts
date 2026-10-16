// Wearer filter. On real Bee data (verified 2026-10-15) the final transcription labels the
// wearer's utterances with their profile name (the full first name, or just its first token)
// and everyone else as "Unknown". Discover the wearer's labels from `bee me` plus the label
// frequencies; never hard-code a name.
import type { Me } from "../bee/schemas.js";

export const UNKNOWN_LABELS = new Set(["unknown", "", "speaker", "unidentified"]);

const toks = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export interface WearerLabels {
  labels: string[]; // exact speaker strings treated as the wearer
  method: "profile-name" | "env" | "single-named-label" | "cli-flag" | "none";
  counts: Record<string, number>; // every label seen, with counts (labels only, no text)
  note?: string;
}

// A label is the wearer's when every token of it is a token of the profile's first/last name
// ("Kaung", "Kaung Zin", "Kaung Zin Hein" all match a profile named that).
export function matchesProfile(label: string, me: Pick<Me, "first_name" | "last_name">): boolean {
  const name = new Set(toks(`${me.first_name ?? ""} ${me.last_name ?? ""}`));
  const t = toks(label);
  return name.size > 0 && t.length > 0 && t.every((x) => name.has(x));
}

export function discoverWearerLabels(counts: Record<string, number>, me: Pick<Me, "first_name" | "last_name"> | null, env = process.env.BEE_WEARER_LABELS): WearerLabels {
  if (env && env.trim()) {
    return { labels: env.split(",").map((s) => s.trim()).filter(Boolean), method: "env", counts };
  }
  const named = Object.keys(counts).filter((l) => !UNKNOWN_LABELS.has(l.trim().toLowerCase()));
  if (me) {
    const hits = named.filter((l) => matchesProfile(l, me));
    if (hits.length) return { labels: hits.sort(), method: "profile-name", counts };
  }
  // Fallback: exactly one named label across the corpus. Bee only names the enrolled wearer.
  if (named.length === 1) {
    return { labels: named, method: "single-named-label", counts, note: "inferred: the only non-Unknown label; set BEE_WEARER_LABELS to override" };
  }
  return { labels: [], method: "none", counts, note: named.length ? `ambiguous named labels: ${named.length}; set BEE_WEARER_LABELS` : "no named labels (realtime-only or pre-enrolment data)" };
}

export function isWearer(speaker: string, w: WearerLabels): boolean {
  return w.labels.includes(speaker);
}
