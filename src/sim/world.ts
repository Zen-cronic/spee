// Synthetic Bee world simulator. Produces Bee-shaped fixtures (verbatim + cleaned variants)
// and a hidden ground-truth key. Post-cutover sessions are conditioned on the pre-registered
// drill split (coaching can only affect speech AFTER it starts), with a planted effect:
// drilled + responsive types drop to 20% of baseline, drilled + stubborn and control types stay flat.
// The analyzer never imports this module or reads fixtures/_truth.
import { createHash } from "node:crypto";
import { splitSentences } from "../analyze/segment.js";
import type { Lang } from "../analyze/taxonomy.js";
import type { ConversationGetResponse, Journal } from "../bee/schemas.js";
import * as T from "./templates.js";

export type Variant = "verbatim" | "cleaned";
export type Role = "wearer" | "other";
export interface Split {
  lang: Lang;
  drilled: string[];
  control: string[];
}

export const CUTOVER_MS = Date.UTC(2026, 9, 7, 3, 59, 59); // 2026-10-06 23:59:59 EDT
export const TZ = "America/Toronto";

// Planted profiles (hidden from the analyzer)
const WEARER: Record<Lang, Record<string, number>> = {
  en: {
    EN_HEDGE_STACK: 1.5,
    EN_VAGUE_STATUS: 1.2,
    EN_NO_ETA: 1.0,
    EN_BURIED_BLOCKER: 0.8,
    EN_RUN_ON: 1.0,
    EN_OVER_APOLOGY: 0.8,
    EN_VAGUE_REFERENT: 1.0,
  },
  fr: {
    FR_AUX_ETRE_AVOIR: 1.5,
    FR_GENDER: 1.3,
    FR_DEPUIS_TENSE: 1.0,
    FR_PREPOSITION_PLACE: 1.0,
    FR_CONTRACTION: 0.8,
    FR_MISSING_NE: 1.0,
    FR_ANGLICISM: 1.0,
    FR_REFLEXIVE: 0.8,
  },
};
const STUBBORN: Record<Lang, string[]> = {
  en: ["EN_RUN_ON", "EN_VAGUE_STATUS"],
  fr: ["FR_GENDER", "FR_ANGLICISM", "FR_MISSING_NE"],
};
const OTHERS: Record<Lang, Record<string, Record<string, number>>> = {
  en: {
    Priya: { EN_HEDGE_STACK: 0.8 },
    Dan: { EN_VAGUE_STATUS: 0.8, EN_RUN_ON: 0.6 },
    Marcus: { EN_PASSIVE_NO_OWNER: 1.0 },
  },
  fr: {
    Tom: { FR_AGE_ETRE: 1.0, FR_GENDER: 0.8, FR_ANGLICISM: 0.5 },
    Aisha: { FR_PARTITIVE: 1.0, FR_MISSING_NE: 0.8, FR_PREPOSITION_PLACE: 0.5 },
  },
};
export const WEARER_NAME = { en: "Kai", fr: "Kai" };
export const RESPONSIVE_MULT = 0.2;

export function plantedEffect(lang: Lang, split: Split | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of Object.keys(WEARER[lang])) {
    const drilled = split?.drilled.includes(t) ?? false;
    out[t] = drilled && !STUBBORN[lang].includes(t) ? RESPONSIVE_MULT : 1;
  }
  return out;
}

// Seeded RNG
function seedOf(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32LE(0);
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <X>(rng: Rng, xs: X[]): X => xs[Math.floor(rng() * xs.length)]!;
function shuffle<X>(rng: Rng, xs: X[]): X[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Template rendering
interface Rendered {
  verbatim: string;
  cleaned: string;
  corrected: string;
  excerpt: string | null;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[,\s]+/, "")
    .trim();

export function render(tpl: string, slots: Record<string, string>): Rendered {
  let s = tpl;
  for (const [k, v] of Object.entries(slots)) s = s.replaceAll(`{${k}}`, v);
  const spans = [...s.matchAll(/\[\[(.*?)\|\|(.*?)\]\]/g)];
  const excerpt = spans[0]?.[1] ?? null;
  const withWrong = s.replace(/\[\[(.*?)\|\|(.*?)\]\]/g, "$1");
  const withRight = s.replace(/\[\[(.*?)\|\|(.*?)\]\]/g, "$2");
  const fill = (x: string, keep: boolean) =>
    x.replace(/\{rep\}\s*(\S+)/g, (_m, w: string) => (keep ? `${w} ${w}` : w)).replace(/\{(\w+)\}/g, (_m, k: string) => {
      if (!(k in T.FILLERS)) throw new Error(`unknown marker {${k}} in ${tpl}`);
      return keep ? T.FILLERS[k]! : "";
    });
  const verbatim = cap(tidy(fill(withWrong, true)));
  const cleaned = cap(tidy(fill(withWrong, false)));
  const corrected = cap(tidy(fill(withRight, false)));
  if (excerpt && (!verbatim.toLowerCase().includes(excerpt.toLowerCase()) || !cleaned.toLowerCase().includes(excerpt.toLowerCase())))
    throw new Error(`excerpt not preserved: ${tpl}`);
  return { verbatim, cleaned, corrected, excerpt };
}

// Disfluency injection (calibrated after comparing with a real stand-up transcript: real
// speech carries far more mid-sentence fillers and word repetitions than clean templates).
// Never injects inside an error span, so planted excerpts stay intact.
interface Style {
  p: number;
  fillers: string[];
}
const STYLE: Record<string, Style> = {
  Kai_en: { p: 0.09, fillers: ["uh", "um", "like", "like", "youknow"] },
  Kai_fr: { p: 0.07, fillers: ["euh", "euh", "ben", "genre"] },
  Tom: { p: 0.05, fillers: ["euh", "ben"] },
  Aisha: { p: 0.05, fillers: ["euh", "bah"] },
  Priya: { p: 0.03, fillers: ["um", "like"] },
  Dan: { p: 0.04, fillers: ["uh", "like"] },
};
function disfluent(tpl: string, rng: Rng, speaker: string, lang: Lang): string {
  const st = STYLE[speaker === "Kai" ? `Kai_${lang}` : speaker];
  if (!st) return tpl;
  const toks = tpl.split(" ");
  const out: string[] = [];
  let inSpan = false;
  toks.forEach((tok, i) => {
    const opens = tok.includes("[[");
    if (i > 0 && !inSpan && !opens && !tok.startsWith("{")) {
      const r = rng();
      if (r < st.p) out.push(`{${pick(rng, st.fillers)}}`);
      else if (r < st.p * 1.5 && /^[\p{L}']+$/u.test(tok)) out.push("{rep}");
    }
    out.push(tok);
    if (opens) inSpan = true;
    if (tok.includes("]]")) inSpan = false;
  });
  return out.join(" ");
}

// Lines and sessions
interface Line {
  speaker: string;
  role: Role;
  r: Rendered;
  type: string | null;
}

function errorLines(lang: Lang, rng: Rng, speaker: string, role: Role, profile: Record<string, number>, mult: (t: string) => number, slotFn: () => Record<string, string>): Line[] {
  const bank = lang === "en" ? T.EN_ERRORS : T.FR_ERRORS;
  const out: Line[] = [];
  for (const [type, rate] of Object.entries(profile)) {
    const n = Math.floor(rate * mult(type) + rng());
    for (let i = 0; i < n; i++) out.push({ speaker, role, type, r: render(disfluent(pick(rng, bank[type]!), rng, speaker, lang), slotFn()) });
  }
  return out;
}

function neutral(rng: Rng, speaker: string, role: Role, pool: string[], n: number, slotFn: () => Record<string, string>, fillerP: number, fillers: string[], lang: Lang): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    let tpl = pick(rng, pool);
    if (rng() < fillerP) tpl = `{${pick(rng, fillers)}} ${tpl.charAt(0).toLowerCase()}${tpl.slice(1)}`;
    out.push({ speaker, role, type: null, r: render(disfluent(tpl, rng, speaker, lang), slotFn()) });
  }
  return out;
}

// EN: blocker goes last (buried), apology goes first.
function orderUpdate(lines: Line[], rng: Rng): Line[] {
  const rank = (l: Line) => (l.type === "EN_OVER_APOLOGY" ? 0 : l.type === "EN_BURIED_BLOCKER" ? 2 : 1);
  return shuffle(rng, lines).sort((a, b) => rank(a) - rank(b));
}

function standup(rng: Rng, mult: (t: string) => number): Line[] {
  const C = () => ({ C: pick(rng, T.EN_COMPONENTS) });
  const lead = (tpl: string, N = "") => ({ speaker: "Marcus", role: "other" as Role, type: null, r: render(tpl, { N }) });
  const lines: Line[] = [lead(pick(rng, T.EN_LEAD_OPEN))];
  const order = shuffle(rng, ["Priya", "Dan", WEARER_NAME.en]);
  for (const who of order) {
    lines.push(lead(pick(rng, T.EN_LEAD_TURN), who));
    if (who === WEARER_NAME.en) {
      const errs = errorLines("en", rng, who, "wearer", WEARER.en, mult, C);
      const neu = neutral(rng, who, "wearer", T.EN_NEUTRAL_WEARER, 2, C, 0.5, ["um", "uh", "like", "youknow"], "en");
      lines.push(...orderUpdate([...errs, ...neu], rng));
    } else {
      const errs = errorLines("en", rng, who, "other", OTHERS.en[who]!, () => 1, C);
      const neu = neutral(rng, who, "other", T.EN_NEUTRAL_OTHER, 3, C, 0.2, ["um", "uh"], "en");
      lines.push(...shuffle(rng, [...errs, ...neu]));
    }
  }
  // Lead's own update carries the passive/no-owner pattern
  lines.push(...errorLines("en", rng, "Marcus", "other", OTHERS.en.Marcus!, () => 1, C));
  lines.push(lead(pick(rng, T.EN_LEAD_CLOSE)));
  return lines;
}

function frClass(rng: Rng, mult: (t: string) => number): Line[] {
  const none = () => ({});
  const teacher = (tpl: string, N = "") => ({ speaker: "Mme Lefebvre", role: "other" as Role, type: null, r: render(tpl, { N }) });
  const lines: Line[] = [teacher(pick(rng, T.FR_TEACHER_OPEN)), teacher(T.FR_TEACHER[0]!)];
  // Two rounds; each student's planted errors are spread across rounds.
  const studentLines: Record<string, Line[]> = {};
  for (const who of ["Tom", "Aisha", WEARER_NAME.fr]) {
    if (who === WEARER_NAME.fr) {
      const errs = errorLines("fr", rng, who, "wearer", WEARER.fr, mult, none);
      studentLines[who] = shuffle(rng, [...errs, ...neutral(rng, who, "wearer", T.FR_NEUTRAL_WEARER, 2, none, 0.5, ["euh", "ben", "bah"], "fr")]);
    } else {
      const errs = errorLines("fr", rng, who, "other", OTHERS.fr[who]!, () => 1, none);
      studentLines[who] = shuffle(rng, [...errs, ...neutral(rng, who, "other", T.FR_NEUTRAL_STUDENT, 2, none, 0.4, ["euh", "ben"], "fr")]);
    }
  }
  for (let round = 0; round < 2; round++) {
    for (const who of shuffle(rng, ["Tom", "Aisha", WEARER_NAME.fr])) {
      lines.push(teacher(pick(rng, T.FR_TEACHER_TURN), who));
      const mine = studentLines[who]!;
      const half = round === 0 ? mine.slice(0, Math.ceil(mine.length / 2)) : mine.slice(Math.ceil(mine.length / 2));
      for (const l of half) {
        lines.push(l);
        if (rng() < 0.35) lines.push(teacher(pick(rng, T.FR_TEACHER.slice(1))));
      }
    }
    if (rng() < 0.6) {
      const r = render(pick(rng, T.FR_TEACHER_NE_DROP), {});
      lines.push({ speaker: "Mme Lefebvre", role: "other", type: "FR_MISSING_NE", r });
    }
  }
  lines.push(teacher(pick(rng, T.FR_TEACHER_CLOSE)));
  return lines;
}

function voiceNoteLines(lang: Lang, rng: Rng, mult: (t: string) => number): Line[] {
  const w = WEARER_NAME[lang];
  const C = lang === "en" ? () => ({ C: pick(rng, T.EN_COMPONENTS) }) : () => ({});
  const rate = (t: string) => mult(t) * 0.6;
  const errs = errorLines(lang, rng, w, "wearer", WEARER[lang], rate, C);
  const neu =
    lang === "en"
      ? neutral(rng, w, "wearer", T.EN_NEUTRAL_WEARER, 2, C, 0.5, ["um", "uh", "like"], "en")
      : neutral(rng, w, "wearer", T.FR_NEUTRAL_WEARER, 2, C, 0.5, ["euh", "ben"], "fr");
  const intro =
    lang === "en"
      ? render("{um} okay, quick rehearsal for standup.", {})
      : render("{euh} bon, je pratique un peu mon français ce soir.", {});
  const body = lang === "en" ? orderUpdate([...errs, ...neu], rng) : shuffle(rng, [...errs, ...neu]);
  return [{ speaker: w, role: "wearer", type: null, r: intro }, ...body];
}

// Schedule (all times America/Toronto, EDT = UTC-4)
const at = (day: number, h: number, m: number) => Date.UTC(2026, 9, day, h + 4, m);
interface SessionPlan {
  key: string;
  lang: Lang;
  kind: "conversation" | "voice_note";
  startMs: number;
  build: "standup" | "class" | "voice" | "short";
}
export function plan(lang: Lang): SessionPlan[] {
  const out: SessionPlan[] = [];
  if (lang === "en") {
    for (const d of [1, 2, 5, 6, 7, 8, 9, 13]) out.push({ key: `en-standup-10-${d}`, lang, kind: "conversation", startMs: at(d, 9, 30), build: "standup" });
    for (const d of [2, 5, 6, 7, 9, 13]) out.push({ key: `en-voice-10-${d}`, lang, kind: "voice_note", startMs: at(d, 8, 50), build: "voice" });
    out.push({ key: "en-hallway-10-5", lang, kind: "conversation", startMs: at(5, 12, 10), build: "short" });
  } else {
    for (const d of [1, 3, 6, 8, 10, 13]) out.push({ key: `fr-class-10-${d}`, lang, kind: "conversation", startMs: d === 3 || d === 10 ? at(d, 10, 0) : at(d, 18, 30), build: "class" });
    for (const d of [2, 4, 6, 9, 11, 13]) out.push({ key: `fr-voice-10-${d}`, lang, kind: "voice_note", startMs: at(d, 20, 0), build: "voice" });
    out.push({ key: "fr-drill-10-8", lang, kind: "conversation", startMs: at(8, 21, 0), build: "short" });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// Output types
export interface TruthInstance {
  key: string;
  session_key: string;
  kind: "conversation" | "voice_note";
  startMs: number;
  phase: "pre" | "post";
  type: string;
  speaker: string;
  role: Role;
  excerpt: string;
}
export interface Truth {
  lang: Lang;
  note: string;
  cutover_ms: number;
  split_used: Split | null;
  planted_effect: Record<string, number>;
  wearer_rates: Record<string, number>;
  stubborn: string[];
  others: Record<string, Record<string, number>>;
  sessions: { key: string; kind: string; id: string; startMs: number; phase: "pre" | "post"; deleted: boolean }[];
  utterances: Record<string, { speaker: string; role: Role; text: string }>;
  instances: TruthInstance[];
}
export interface World {
  conversations: Record<Variant, ConversationGetResponse[]>;
  journals: Record<Variant, Journal[]>;
  truth: Record<Lang, Truth>;
}

const WPS: Record<string, number> = { Kai_en: 2.5, Kai_fr: 1.6, "Mme Lefebvre": 2.6, Tom: 1.7, Aisha: 1.8, Marcus: 2.8, Priya: 2.7, Dan: 2.9 };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const jid = (key: string) => {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function buildWorld(splits: Partial<Record<Lang, Split>> = {}, opts: { includePost: boolean } = { includePost: true }): World {
  const world: World = { conversations: { verbatim: [], cleaned: [] }, journals: { verbatim: [], cleaned: [] }, truth: {} as Record<Lang, Truth> };
  for (const lang of ["en", "fr"] as Lang[]) {
    const split = splits[lang] ?? null;
    const effect = plantedEffect(lang, split);
    const truth: Truth = {
      lang,
      note: "SYNTHETIC ground truth for the PoC. Never read by the analyzer.",
      cutover_ms: CUTOVER_MS,
      split_used: split,
      planted_effect: effect,
      wearer_rates: WEARER[lang],
      stubborn: STUBBORN[lang],
      others: OTHERS[lang],
      sessions: [],
      utterances: {},
      instances: [],
    };
    let convSeq = lang === "en" ? 5101 : 6101;
    for (const p of plan(lang)) {
      const phase = p.startMs > CUTOVER_MS ? "post" : "pre";
      if (phase === "post" && !opts.includePost) continue;
      const rng = mulberry32(seedOf(`${p.key}|${phase === "post" ? JSON.stringify(split) : "pre"}`));
      const mult = (t: string) => (phase === "post" ? (effect[t] ?? 1) : 1);
      let lines: Line[];
      if (p.build === "standup") lines = standup(rng, mult);
      else if (p.build === "class") lines = frClass(rng, mult);
      else if (p.build === "voice") lines = voiceNoteLines(lang, rng, mult);
      else
        lines =
          lang === "en"
            ? [
                { speaker: "Dan", role: "other", type: null, r: render("Coffee run, you want anything?", {}) },
                { speaker: "Kai", role: "wearer", type: null, r: render("{um} yeah, an oat latte please, thanks.", {}) },
                { speaker: "Dan", role: "other", type: null, r: render("Sure, back in ten minutes.", {}) },
              ]
            : [
                { speaker: "Kai", role: "wearer", type: null, r: render("Je suis allé au marché samedi.", {}) },
                { speaker: "Kai", role: "wearer", type: null, r: render("Je suis resté à la maison hier soir.", {}) },
                { speaker: "Kai", role: "wearer", type: null, r: render("Je me lève à six heures et demie.", {}) },
              ];

      if (p.kind === "conversation") {
        const id = convSeq++;
        let t = 0.6;
        const utts: Record<Variant, ConversationGetResponse["conversation"]["transcriptions"][0]["utterances"]> = { verbatim: [], cleaned: [] };
        lines.forEach((l, i) => {
          const uid = id * 1000 + i + 1;
          const wps = WPS[l.speaker === "Kai" ? `Kai_${lang}` : l.speaker] ?? 2.5;
          const dur = Math.round((words(l.r.verbatim) / wps) * 100) / 100;
          const start = Math.round(t * 100) / 100;
          const end = Math.round((t + dur) * 100) / 100;
          const spoken_at = p.startMs + Math.round(start * 1000);
          for (const v of ["verbatim", "cleaned"] as Variant[])
            utts[v].push({ id: uid, realtime: false, start, end, spoken_at, text: l.r[v], speaker: "Unknown", created_at: spoken_at + 1800 + Math.floor(rng() * 1500) });
          const key = `u:${uid}`;
          truth.utterances[key] = { speaker: l.speaker, role: l.role, text: l.r.verbatim };
          if (l.type && l.r.excerpt)
            truth.instances.push({ key, session_key: p.key, kind: p.kind, startMs: p.startMs, phase, type: l.type, speaker: l.speaker, role: l.role, excerpt: l.r.excerpt });
          t = end + 0.4 + rng() * 1.2;
        });
        const endMs = p.startMs + Math.round(t * 1000);
        const isClass = p.build === "class";
        const summary =
          p.build === "standup"
            ? "Daily engineering stand-up with status updates, review requests and blockers."
            : isClass
              ? "French conversation class: weekend recap and passé composé practice."
              : "Short exchange.";
        for (const v of ["verbatim", "cleaned"] as Variant[])
          world.conversations[v].push({
            conversation: {
              id,
              start_time: p.startMs,
              end_time: endMs,
              device_type: "unknown",
              summary,
              short_summary: summary.split(":")[0]!,
              state: "COMPLETED",
              created_at: p.startMs,
              updated_at: endMs + 90_000,
              transcriptions: [{ id: id * 10 + 1, realtime: false, utterances: utts[v] }],
              suggested_links: [],
              primary_location: {
                address: isClass ? "Spadina Ave, Toronto, ON" : "King St W, Toronto, ON",
                latitude: isClass ? 43.6629 : 43.6447,
                longitude: isClass ? -79.4001 : -79.3958,
                created_at: p.startMs,
              },
            },
            timezone: TZ,
          });
        const deleted = lines.reduce((n, l) => n + words(l.r.verbatim), 0) < 50;
        truth.sessions.push({ key: p.key, kind: p.kind, id: String(id), startMs: p.startMs, phase, deleted });
      } else {
        const id = jid(p.key);
        for (const v of ["verbatim", "cleaned"] as Variant[]) {
          const text = lines.map((l) => l.r[v]).join(" ");
          if (splitSentences(text).length !== lines.length) throw new Error(`segmentation mismatch in ${p.key}/${v}`);
          world.journals[v].push({
            id,
            text,
            state: "READY",
            created_at: p.startMs,
            updated_at: p.startMs + 45_000,
            // Bee's AI clean-up rewrites the note; it would also erase the learner's errors.
            aiResponse: { message: null, cleanedUpText: lines.map((l) => l.r.corrected).join(" "), followUp: null, todos: [] },
          });
        }
        lines.forEach((l, i) => {
          const key = `v:${id}:${i}`;
          truth.utterances[key] = { speaker: l.speaker, role: l.role, text: l.r.verbatim };
          if (l.type && l.r.excerpt)
            truth.instances.push({ key, session_key: p.key, kind: p.kind, startMs: p.startMs, phase, type: l.type, speaker: l.speaker, role: l.role, excerpt: l.r.excerpt });
        });
        truth.sessions.push({ key: p.key, kind: p.kind, id, startMs: p.startMs, phase, deleted: false });
      }
    }
    world.truth[lang] = truth;
  }
  return world;
}
