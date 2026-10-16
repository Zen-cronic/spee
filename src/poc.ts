// One-command PoC: fixtures -> analysis (pre) -> pre-registered split -> fixtures (post) ->
// analysis (all, both variants) -> evaluation vs hidden truth -> POC_REPORT.md + out/report.html.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractItems, genericBaseline, loadSessions, quotesTranscript, type AsrSuspect, type Item, type Session } from "./analyze/extract.js";
import { lexical, type Metrics } from "./analyze/metrics.js";
import type { Lang } from "./analyze/taxonomy.js";
import { loadArtifactTokens, loadPrivateStandup } from "./bee/private.js";
import { MockBeeSource } from "./bee/source.js";
import { drillCards, leitner, registerSplit, type Prereg } from "./coach/coach.js";
import { armMean, loadTruth, pct, recurrence, score, truthCounter, type Recurrence, type Score } from "./eval/score.js";
import { llmLog, MODEL_CHAIN, pool, usage } from "./llm/bedrock.js";
import { mdToHtml } from "./report/html.js";
import { verdict } from "./report/verdict.js";
import { buildWorld, CUTOVER_MS, type Split } from "./sim/world.js";
import { writeWorld } from "./sim/write.js";

const GUARD = process.env.ASR_GUARD !== "0";
const LANGS: Lang[] = ["en", "fr"];
type Variant = "cleaned" | "verbatim";
const PRIMARY: Variant = "cleaned"; // expected Bee condition (Bee ASR appears to strip most fillers)

interface Analysis {
  variant: Variant;
  sessions: Session[];
  items: Item[];
  rejected: number;
  deleted: number[];
}

async function analyze(variant: Variant, guard = GUARD): Promise<Analysis> {
  const src = new MockBeeSource(`fixtures/${variant}`);
  const sessions = await loadSessions(src);
  const res = await pool(sessions, 4, (s) => extractItems(s, { guard, label: variant }));
  return { variant, sessions, items: res.flatMap((r) => r.items), rejected: res.reduce((n, r) => n + r.rejected, 0), deleted: src.deleted };
}

const usable = (i: Item) => i.citation_valid && i.excerpt_grounded && !i.asr_suspect;
const edtDay = (ms: number) => new Date(ms - 4 * 3600_000).toISOString().slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;

function metricsFor(lang: Lang, sessions: Session[], kind: Session["kind"]): Metrics {
  const ss = sessions.filter((s) => s.lang === lang && s.kind === kind);
  const segs = ss.flatMap((s) => s.segments);
  return lexical(lang, segs.map((g) => g.text), kind === "conversation" ? segs : undefined);
}

function scoreLine(label: string, s: Score): string {
  const valid = s.citationValid;
  return `| ${label} | ${s.items} | ${pct(s.citationValid, s.items)} | ${pct(s.grounded, s.items)} | ${pct(s.tpWearer, valid)} | ${pct(s.tpWearer + s.tpOther, valid)} | ${pct(s.recalledWearer, s.wearerInstances)} (${s.recalledWearer}/${s.wearerInstances}) | ${pct(s.onOtherSpeakerLine, valid)} |`;
}
const SCORE_HEAD = [
  "| Slice | Items | Cites a real id | Excerpt verbatim in line | Precision (wearer's error) | Precision (any speaker's error) | Recall of wearer errors | Items on someone else's line |",
  "|---|---|---|---|---|---|---|---|",
];

async function main() {
  mkdirSync("out", { recursive: true });
  const t0 = Date.now();

  // Phase 1: pre-cutover world, analysis, pre-registration
  writeWorld(buildWorld({}, { includePost: false }));
  const pre = await analyze(PRIMARY);
  const prereg: Record<Lang, Prereg> = {} as Record<Lang, Prereg>;
  const reused: Record<string, boolean> = {};
  for (const lang of LANGS) {
    const r = registerSplit(lang, pre.items.filter((i) => i.lang === lang && i.startMs <= CUTOVER_MS), CUTOVER_MS);
    prereg[lang] = r.prereg;
    reused[lang] = r.reused;
  }

  // Phase 2: post-cutover world conditioned on the split, then full analysis of both variants
  const splits: Record<Lang, Split> = { en: { lang: "en", drilled: prereg.en.drilled, control: prereg.en.control }, fr: { lang: "fr", drilled: prereg.fr.drilled, control: prereg.fr.control } };
  writeWorld(buildWorld(splits));
  const A: Record<Variant, Analysis> = { cleaned: await analyze("cleaned"), verbatim: await analyze("verbatim") };
  for (const v of ["cleaned", "verbatim"] as Variant[]) writeFileSync(`out/items-${v}.json`, JSON.stringify(A[v].items, null, 1));

  const truth = { en: loadTruth("en"), fr: loadTruth("fr") };
  const md: string[] = [];
  const P = (...l: string[]) => md.push(...l);
  const sum: Record<string, unknown> = {};

  // Baselines (same day as the drills: cutover day 2026-10-06)
  const BASE_DAY = "2026-10-06";
  const baseline: Record<Lang, { insights: { title: string; insight: string; suggestion: string }[]; modelId: string }> = {} as never;
  for (const lang of LANGS) {
    const day = A[PRIMARY].sessions.filter((s) => s.lang === lang && edtDay(s.startMs) === BASE_DAY);
    baseline[lang] = await genericBaseline(day, lang, `baseline:${lang}:${BASE_DAY}`);
  }
  writeFileSync("out/baseline.json", JSON.stringify(baseline, null, 1));

  // Real stand-up (T6)
  const realConv = loadPrivateStandup();
  let t6: null | {
    session: Session;
    noGuard: Item[];
    guard: Item[];
    suspects: AsrSuspect[];
    metrics: Metrics;
    base: { title: string; insight: string; suggestion: string }[];
    artifactTokens: string[];
  } = null;
  if (realConv) {
    const src = new MockBeeSource("fixtures/__none__", [realConv]);
    const [session] = await loadSessions(src);
    if (session) {
      const ng = await extractItems(session, { guard: false, label: "real:noguard" });
      const g = await extractItems(session, { guard: true, label: "real:guard" });
      const base = await genericBaseline([session], "en", "real:baseline");
      t6 = { session, noGuard: ng.items, guard: g.items, suspects: g.asrSuspects, metrics: lexical("en", session.segments.map((s) => s.text), session.segments), base: base.insights, artifactTokens: loadArtifactTokens() };
    }
  }

  // Header
  P(
    "# Bee deliberate-practice speech coach: go/no-go PoC report",
    "",
    `Generated ${new Date().toISOString()} by \`npm run poc\` (${Math.round((Date.now() - t0) / 1000)} s this run).`,
    "",
    "> **All Bee data in T1 to T5 is SYNTHETIC.** It was authored by `src/sim/` in Bee's exact JSON shapes (bee-cli @84a6e8f). Every speaker label is \"Unknown\", and the mock deletes conversations under 50 words. The planted ground truth in `fixtures/_truth/` is read only by `src/eval/`. T6 uses one real stand-up transcript from Google Meet captions, not from Bee; its text stays out of this file. A submission must use real Bee data.",
    "",
    `Condition: the **cleaned** variant (fillers stripped) is the **expected Bee condition**. It is scored first. **Verbatim** is the optimistic case. Why: a published 9-day real-Bee log shows 0.10 to 0.34 fillers per 100 tokens, while real human-captioned speech shows about 4.7 (see T2).`,
    "",
    `LLM: Amazon Bedrock Converse (non-streaming), forced tool use plus zod validation, model chain \`${MODEL_CHAIN.join(" -> ")}\`. Models that actually answered: ${Object.entries(usage.byModel).map(([m, n]) => `\`${m}\` (${n} calls incl. cache)`).join(", ")}. ASR guard: ${GUARD ? "on" : "off"}.`,
    "",
  );
  const unavailable = llmLog.filter((l) => l.event === "model_unavailable");
  const answered = Object.keys(usage.byModel);
  const claudeAnswered = answered.some((m) => m.includes("anthropic"));
  if (claudeAnswered && answered.some((m) => !m.includes("anthropic"))) {
    const fallbackCalls = Object.entries(usage.byModel).filter(([m]) => !m.includes("anthropic")).reduce((a, [, n]) => a + n, 0);
    P(
      `**Partial fallback.** Claude served most calls. ${fallbackCalls} call(s) fell through the chain to a non-Anthropic model (typically Bedrock throttling on a new account's Anthropic quota). See \`out/llm-log.json\` for each call's model.`,
      "",
    );
  } else if (unavailable.length || !claudeAnswered) {
    P(
      "**Model deviation (blocker for the requested model).** Claude Haiku 4.5 and Sonnet 4.5 on this account return the following error:",
      "",
      "```",
      unavailable.length ? unavailable.map((u) => `${u.modelId}: ${u.error}`).join("\n") : "ResourceNotFoundException: Model use case details have not been submitted for this account. (recorded on first run; this run was served from cache)",
      "```",
      "The run therefore fell back to `openai.gpt-oss-120b-1:0` on Bedrock. Nova was avoided because it fails tool-use structured output. Fix: in the Bedrock console, open Model access and submit the Anthropic use-case form. Then rerun with `rm -rf cache prereg && npm run poc`. Expect different numbers, because the split is re-registered on the new evidence.",
      "",
    );
  }

  // T1
  P("## T1 Specificity: drills vs a generic \"Daily Insights\" baseline", "");
  P(...SCORE_HEAD);
  const t1: Record<string, Score> = {};
  for (const lang of LANGS) {
    for (const v of [PRIMARY, "verbatim"] as Variant[]) {
      const ss = A[v].sessions.filter((s) => s.lang === lang);
      for (const kind of ["conversation", "voice_note"] as const) {
        const sc = score(truth[lang], A[v].items, ss.filter((s) => s.kind === kind));
        t1[`${lang}-${v}-${kind}`] = sc;
        sum[`t1_${lang}_${v}_${kind}`] = { precisionWearer: r2(sc.tpWearer / (sc.citationValid || 1)), recallWearer: r2(sc.recalledWearer / (sc.wearerInstances || 1)) };
        P(scoreLine(`${lang.toUpperCase()} ${v} ${kind === "conversation" ? "group conversations" : "voice notes"}`, sc));
      }
    }
  }
  const sus = (lang: Lang) => A[PRIMARY].items.filter((i) => i.lang === lang);
  P(
    "",
    `ASR-guard cost on synthetic text, which has NO ASR errors: ${LANGS.map((l) => `${l.toUpperCase()} ${pct(sus(l).filter((i) => i.asr_suspect).length, sus(l).length)}`).join(", ")} of cleaned items were quarantined as "check the transcript". These are counted as items above, but they never become drills or recurrence counts.`,
    "",
    "Precision (wearer's error) is the product claim \"this is YOUR error\". Precision (any speaker) only checks that the error is real. A detection counts as a match only when it has the same line id and the same error type as a planted instance.",
    "",
  );
  for (const lang of LANGS) {
    const day = A[PRIMARY].sessions.filter((s) => s.lang === lang && edtDay(s.startMs) === BASE_DAY);
    const dayIds = new Set(day.map((s) => s.id));
    const drills = A[PRIMARY].items.filter((i) => dayIds.has(i.session_id) && usable(i));
    const vn = drills.filter((i) => i.session_kind === "voice_note");
    const top = [...vn, ...drills.filter((i) => i.session_kind !== "voice_note")].slice(0, 6);
    const b = baseline[lang].insights;
    const bq = b.filter((x) => quotesTranscript(`${x.insight} ${x.suggestion}`, day)).length;
    const dq = top.filter((i) => i.citation_valid && i.excerpt_grounded).length;
    sum[`t1_${lang}`] = { drills: drills.length, baselineInsights: b.length, baselineQuoting: bq };
    P(`### ${lang.toUpperCase()}, ${BASE_DAY} (cleaned)`, "", "**Drills (top 6, voice notes first)**", "", "| Line | Type | Said | Fix | Re-say prompt |", "|---|---|---|---|---|");
    for (const i of top) P(`| \`${i.utterance_id}\` | ${i.error_type} | ${esc(i.excerpt)} | ${esc(i.correction)} | ${esc(i.resay_prompt)} |`);
    P("", "**Generic baseline (same day, same model)**", "");
    for (const x of b) P(`- **${esc(x.title)}**: ${esc(x.insight)} *Suggestion:* ${esc(x.suggestion)}`);
    P(
      "",
      `Automated specificity: ${pct(dq, top.length)} of the drills cite a real line id AND quote an excerpt found verbatim in that line. ${pct(bq, b.length)} of the baseline insights quote any 4-word run of the transcript, and none can be traced to a line. Quoting a line does not make an insight the wearer's: the baseline also reads the teacher's or lead's lines as the user's own (see the first bullets above).`,
      "",
    );
  }

  // T2
  P("## T2 Filler robustness: verbatim vs cleaned", "");
  P(
    "**External evidence (COMMUNITY + INFERENCE, not official).** A public community project ran a real Bee for 9 days: 15,578 utterances and about 130k words. Its daily filler rate was **0.10 to 0.34 per 100 tokens**, using the list {um, uh, er, erm, ah, hmm, mm, mhm, uhm, hm}.",
    t6
      ? `The operator's real stand-up (Google Meet captions), scored with the same list, gives **${t6.metrics.crossSourceFillersPer100} per 100 tokens**, which is roughly 14 to 47 times higher.`
      : "",
    "That suggests Bee's ASR strips most filled pauses. Caveats: the speakers differ; that corpus mixes all-\"Unknown\" speakers; and there is no official Bee statement either way. **Filler-based coaching is therefore treated as likely unavailable on Bee until a Day-1 test proves otherwise.**",
    "",
    "| Lang | Channel | Variant | Fillers/100w | Cross-source-list fillers/100 tok | Hedges/100w | Repeats/100w | Median words/s |",
    "|---|---|---|---|---|---|---|---|",
  );
  const metricsDump: Record<string, Metrics> = {};
  for (const lang of LANGS)
    for (const kind of ["conversation", "voice_note"] as const)
      for (const v of ["verbatim", "cleaned"] as Variant[]) {
        const m = metricsFor(lang, A[v].sessions, kind);
        metricsDump[`${lang}-${kind}-${v}`] = m;
        P(`| ${lang.toUpperCase()} | ${kind === "conversation" ? "group (all speakers)" : "voice notes (wearer)"} | ${v} | ${m.fillersPer100} | ${m.crossSourceFillersPer100} | ${m.hedgesPer100} | ${m.repeatsPer100} | ${m.medianWordsPerSec ?? "n/a (no timing)"} |`);
      }
  P("", "| Lang | Items verbatim | Items cleaned | Overlap (same line id and type) | Jaccard | Recall of wearer errors, verbatim to cleaned |", "|---|---|---|---|---|---|");
  for (const lang of LANGS) {
    const key = (i: Item) => `${i.utterance_id}|${i.error_type}`;
    const a = new Set(A.verbatim.items.filter((i) => i.lang === lang && usable(i)).map(key));
    const b = new Set(A.cleaned.items.filter((i) => i.lang === lang && usable(i)).map(key));
    const inter = [...a].filter((x) => b.has(x)).length;
    const jac = inter / (a.size + b.size - inter || 1);
    const rv = score(truth[lang], A.verbatim.items, A.verbatim.sessions.filter((s) => s.lang === lang));
    const rc = score(truth[lang], A.cleaned.items, A.cleaned.sessions.filter((s) => s.lang === lang));
    sum[`t2_${lang}`] = { jaccard: r2(jac), recallV: rv.recalledWearer / rv.wearerInstances, recallC: rc.recalledWearer / rc.wearerInstances };
    P(`| ${lang.toUpperCase()} | ${a.size} | ${b.size} | ${inter} | ${r2(jac)} | ${pct(rv.recalledWearer, rv.wearerInstances)} to ${pct(rc.recalledWearer, rc.wearerInstances)} |`);
  }
  P(
    "",
    "What collapses on cleaned text: the filler rate drops to 0 by construction, and words per second falls because the time spans stay the same while words are removed. Hedge counts and the LLM error items do not depend on fillers. Overlap below 1.0 mostly reflects LLM run-to-run variance on different input text, not lost signal; compare recall. Voice notes carry **no timing** (journal text only), so pace can be measured only from group conversations, where the wearer cannot be isolated.",
    "",
  );
  writeFileSync("out/metrics.json", JSON.stringify(metricsDump, null, 1));

  // T3
  P("## T3 Measurability: drilled vs control recurrence after the cutover", "");
  P(
    "> **The fixtures PLANT this effect.** After the cutover, drilled types that the simulator marks \"responsive\" fall to 20% of baseline. Drilled \"stubborn\" types and control types stay flat. T3 therefore shows only that the measurement pipeline can **recover a planted effect** from noisy Bee-shaped text. **It is not evidence that coaching works.**",
    "",
  );
  const t3: Record<string, unknown> = {};
  for (const lang of LANGS) {
    const p = prereg[lang];
    const arms: Record<string, "drilled" | "control"> = Object.fromEntries([...p.drilled.map((t) => [t, "drilled"]), ...p.control.map((t) => [t, "control"])]);
    P(
      `### ${lang.toUpperCase()}`,
      "",
      `Pre-registered split (\`prereg/${lang}-split.json\`, ${reused[lang] ? "reused, registered" : "registered"} ${p.registered_at}, seed = sha256 of the pre-cutover evidence): drilled = ${p.drilled.join(", ") || "none"}; control = ${p.control.join(", ") || "none"}.`,
      "",
    );
    const pol = [...p.drilled, ...p.control].filter((t) => !(t in truth[lang].wearer_rates));
    if (pol.length) P(`**Split pollution:** ${pol.join(", ")} entered the split, but per the truth key only OTHER speakers make that error. Drilling it cannot change anything. This is a direct cost of missing speaker labels.`, "");
    P("| Type | Arm | Truth: planted effect | Detected/session pre to post (all channels) | Ratio | Detected/session pre to post (voice notes only) | Ratio | Truth wearer instances/session pre to post | Ratio |", "|---|---|---|---|---|---|---|---|---|");
    const ss = A[PRIMARY].sessions.filter((s) => s.lang === lang);
    const det = (t: string, s: Session) => A[PRIMARY].items.filter((i) => usable(i) && i.session_id === s.id && i.error_type === t).length;
    const rAll = recurrence(ss, CUTOVER_MS, arms, det);
    const rVoice = recurrence(ss.filter((s) => s.kind === "voice_note"), CUTOVER_MS, arms, det);
    const rTruth = recurrence(ss, CUTOVER_MS, arms, truthCounter(truth[lang]));
    rAll.forEach((r, k) => {
      const eff = truth[lang].planted_effect[r.type];
      const lab = eff == null ? "other speakers only" : eff < 1 ? `x${eff} (responsive)` : arms[r.type] === "drilled" ? "x1 (stubborn)" : "x1 (control)";
      P(`| ${r.type} | ${r.arm} | ${lab} | ${r.pre} to ${r.post} | ${r.ratio ?? "n/a"} | ${rVoice[k]!.pre} to ${rVoice[k]!.post} | ${rVoice[k]!.ratio ?? "n/a"} | ${rTruth[k]!.pre} to ${rTruth[k]!.post} | ${rTruth[k]!.ratio ?? "n/a"} |`);
    });
    const m = (rs: Recurrence[]) => `drilled ${armMean(rs, "drilled") ?? "n/a"} vs control ${armMean(rs, "control") ?? "n/a"}`;
    P("", `Mean post/pre ratio: all channels ${m(rAll)}; voice notes only ${m(rVoice)}; truth ${m(rTruth)}.`, "");
    t3[lang] = { all: [armMean(rAll, "drilled"), armMean(rAll, "control")], voice: [armMean(rVoice, "drilled"), armMean(rVoice, "control")], truth: [armMean(rTruth, "drilled"), armMean(rTruth, "control")], pollution: pol };

    // Drill cards and Leitner schedule driven by re-performance
    const cards = drillCards(lang, A[PRIMARY].items.filter((i) => i.lang === lang && i.startMs <= CUTOVER_MS), p.drilled);
    const postItems = A[PRIMARY].items.filter((i) => i.lang === lang && i.startMs > CUTOVER_MS && i.session_kind === "voice_note");
    const sched = leitner(cards, postItems, CUTOVER_MS + 1000, Date.UTC(2026, 9, 31, 4));
    writeFileSync(`out/drills-${lang}.json`, JSON.stringify({ cards, schedule: sched }, null, 1));
    const relapses = sched.filter((e) => e.event === "relapse").length;
    P(
      `Drill cards: ${cards.length}. Leitner schedule events through 2026-10-31: ${sched.length}, including ${relapses} relapses (the drilled error recurred in a later voice note, so the card dropped back to box 1). Details: \`out/drills-${lang}.json\`.`,
    );
    if (cards[0]) P("", "Sponsor hook (not executed): drills are written back to Bee as todos with alarms, for example", "", "```", `bee todos create --text "Drill: ${cards[0].resay.replace(/"/g, "'").slice(0, 90)}" --alarm-at 2026-10-07T08:30:00-04:00`, "```", "");
  }
  sum.t3 = t3;

  // T4
  P("## T4 Speaker contamination (all labels \"Unknown\")", "", "| Lang | Variant | Group items on someone else's line | Matched errors that belong to someone else | Voice-note items on someone else's line |", "|---|---|---|---|---|");
  const t4: Record<string, unknown> = {};
  for (const lang of LANGS)
    for (const v of [PRIMARY, "verbatim"] as Variant[]) {
      const g = t1[`${lang}-${v}-conversation`]!;
      const n = t1[`${lang}-${v}-voice_note`]!;
      t4[`${lang}-${v}`] = { groupOther: g.onOtherSpeakerLine / (g.citationValid || 1), voiceOther: n.onOtherSpeakerLine / (n.citationValid || 1) };
      P(`| ${lang.toUpperCase()} | ${v} | ${pct(g.onOtherSpeakerLine, g.citationValid)} (${g.onOtherSpeakerLine}/${g.citationValid}) | ${pct(g.tpOther, g.tpOther + g.tpWearer)} | ${pct(n.onOtherSpeakerLine, n.citationValid)} |`);
    }
  sum.t4 = t4;
  P(
    "",
    "Voice notes are wearer-only by construction, so their contamination is 0 in the mock. On a real Bee it would be 0 too, unless someone else talks during the note. In group conversations, a coach that presents every extracted error as \"yours\" is wrong at the rate in the first column. The deleted-conversation rule also bit: " +
      `${A[PRIMARY].deleted.length} short conversation(s) (${A[PRIMARY].deleted.join(", ")}) were dropped by the <50-word rule, including a recorded drill re-say. **Drill re-says must be voice notes.**`,
    "",
  );

  // T5: calibration
  P("## T5 Synthetic-vs-real calibration (English)", "");
  if (t6) {
    const rv = metricsFor("en", A.verbatim.sessions, "voice_note");
    const rg = metricsFor("en", A.verbatim.sessions, "conversation");
    const wpu = (ss: Session[]) => r2(ss.flatMap((s) => s.segments).reduce((n, g) => n + g.text.split(/\s+/).length, 0) / Math.max(1, ss.flatMap((s) => s.segments).length));
    P(
      "| Source | Fillers/100w | Cross-source-list fillers/100 tok | Hedges/100w | Repeats/100w | Words per utterance |",
      "|---|---|---|---|---|---|",
      `| Real stand-up (Meet captions, wearer only) | ${t6.metrics.fillersPer100} | ${t6.metrics.crossSourceFillersPer100} | ${t6.metrics.hedgesPer100} | ${t6.metrics.repeatsPer100} | ${wpu([t6.session])} |`,
      `| Synthetic EN voice notes, verbatim | ${rv.fillersPer100} | ${rv.crossSourceFillersPer100} | ${rv.hedgesPer100} | ${rv.repeatsPer100} | ${wpu(A.verbatim.sessions.filter((s) => s.lang === "en" && s.kind === "voice_note"))} |`,
      `| Synthetic EN group, verbatim (all speakers) | ${rg.fillersPer100} | ${rg.crossSourceFillersPer100} | ${rg.hedgesPer100} | ${rg.repeatsPer100} | ${wpu(A.verbatim.sessions.filter((s) => s.lang === "en" && s.kind === "conversation"))} |`,
      `| Real Bee (published 9-day log, mixed speakers) | n/a | 0.10 to 0.34 | n/a | n/a | n/a |`,
      "",
      "Even after calibration, the synthetic speech is **much cleaner than real speech**. After the first comparison I added mid-sentence fillers and word repetitions to the simulator, but every synthetic line is still a grammatical sentence with at most one planted error. Real speech is fragments, false starts and abandoned clauses. The real ASR also chunks speech into about 45 s blobs, not sentences. The T1 precision and recall numbers are therefore **optimistic upper bounds**.",
      "",
    );
  } else P("Real transcript not present (`fixtures/private/` is gitignored); calibration skipped.", "");

  // T6
  P("## T6 Real-speech check (one real stand-up, wearer-only, Google Meet captions ASR)", "");
  if (t6) {
    const art = (i: Item) => t6!.artifactTokens.some((t) => `${i.excerpt} ${i.correction} ${i.resay_prompt}`.toLowerCase().includes(t));
    const drillable = (xs: Item[]) => xs.filter((i) => !i.asr_suspect);
    const ng = t6.noGuard;
    const g = t6.guard;
    const ngArt = ng.filter(art).length;
    const gDr = drillable(g);
    const gArt = gDr.filter(art).length;
    const caught = t6.artifactTokens.filter((t) => t6!.suspects.some((x) => x.token.toLowerCase().includes(t) || t.includes(x.token.toLowerCase()))).length;
    const baseQuote = t6.base.filter((b) => quotesTranscript(`${b.insight} ${b.suggestion}`, [t6!.session])).length;
    sum.t6 = { noGuardItems: ng.length, noGuardArtifact: ngArt, guardItems: g.length, guardDrillable: gDr.length, guardDrillableArtifact: gArt, suspects: t6.suspects.length, caught, knownTerms: t6.artifactTokens.length, metrics: t6.metrics };
    P(
      "This Google Meet captions ASR is not Bee's ASR. The file does show that fillers (\"Um\", \"uh\") and false starts survive in at least one consumer ASR. It does not show that Bee keeps them; T2 suggests Bee does not. The text is confidential, so only counts and paraphrases appear here. Excerpts are in `out/t6-private.md`, which is gitignored.",
      "",
      `(a) Deterministic metrics (${t6.metrics.words} words across 11 ASR chunks): fillers ${t6.metrics.fillersPer100}/100 words, Cross-source-list fillers ${t6.metrics.crossSourceFillersPer100}/100 tokens, hedges ${t6.metrics.hedgesPer100}/100 words, repetitions ${t6.metrics.repeatsPer100}/100 words, median ${t6.metrics.medianWordsPerSec ?? "n/a"} words/s. **Caveat:** end times are approximated as min(next line, +45 s), so words/s is a lower bound and is not usable for pace coaching.`,
      "",
      "(b) and (c) LLM items, without and with the ASR guard:",
      "",
      "| Run | Items | Drillable (not ASR-suspect) | Drillable items touching a known misheard term (excerpt, fix or re-say) | Grounded excerpt |",
      "|---|---|---|---|---|",
      `| No guard (v1 prompt) | ${ng.length} | ${ng.length} | ${ngArt} (${pct(ngArt, ng.length)}) | ${pct(ng.filter((i) => i.excerpt_grounded).length, ng.length)} |`,
      `| ASR guard (v2: list suspected mishearings first, then quarantine any item that quotes one) | ${g.length} | ${gDr.length} | ${gArt} (${pct(gArt, gDr.length)}) | ${pct(g.filter((i) => i.excerpt_grounded).length, g.length)} |`,
      "",
      `With the guard on, the model listed ${t6.suspects.length} suspected mishearings, covering ${caught} of ${t6.artifactTokens.length} terms on the operator's private list of known misheard terms. Its "likely intended" guesses were mostly placeholders or wrong, so it can flag a mishearing but not repair it. "Known misheard term" means the excerpt, the fix or the re-say line contains a term from that list. Without the guard, ${ngArt} of ${ng.length} coached items carried a misheard term into the coaching, repeating it as if it were a real product name. With the guard, ${gArt} of ${gDr.length} drillable items still did. **Iteration history (same session):** the first guard version caught 6 of 7 known terms and left 0 of 5 drillable items touching them (by an excerpt-and-fix check). But on synthetic text, which contains no ASR errors, it quarantined 20% of EN items and 35% of FR items, because it treated learner grammar errors and component names as possible mishearings. Tightening the guard cut that false quarantine to the T1 figure above, and real-data catches fell to the number here. **An LLM-only guard trades recall on real artifacts against false quarantine on real errors.** The robust fix is deterministic: a user glossary of team tool names, which could live as Bee facts, plus a "did you say X?" confirm step. Error types without the guard: ${countTypes(ng)}. Drillable error types with the guard: ${countTypes(gDr)}.`,
      "",
      `Generic baseline on the same text: ${t6.base.length} insights, ${baseQuote} of which quote the transcript. It also treated misheard terms as real tools and advised the speaker to define them for teammates, so ASR confusion hits the generic coach as well. The drills cite line ids, but on real speech the chunks are 45 s blobs, so a citation points at a paragraph, not a sentence. Corrections also tended to **invent specifics** (dates, percentages, causes) to repair garbled fragments; the prompt now forbids that and asks for <placeholders>. Run-on detection is meaningless on ASR chunks, because the chunk boundary is the captioner's, not the speaker's.`,
      "",
    );
    const priv = [
      "# T6 private detail (gitignored; confidential work transcript; do not commit or share)",
      "",
      "## Suspected ASR mishearings (guard run)",
      ...t6.suspects.map((s) => `- ${s.utterance_id}: "${s.token}" -> ${s.likely_intended}`),
      "",
      "## Items without guard",
      ...ng.map((i) => `- ${i.utterance_id} ${i.error_type} known-misheard=${art(i)} | said: "${i.excerpt}" | fix: ${i.correction}`),
      "",
      "## Items with guard",
      ...g.map((i) => `- ${i.utterance_id} ${i.error_type} asr_suspect=${i.asr_suspect} known-misheard=${art(i)} | said: "${i.excerpt}" | fix: ${i.correction} | re-say: ${i.resay_prompt}`),
      "",
      "## Generic baseline",
      ...t6.base.map((b) => `- ${b.title}: ${b.insight} / ${b.suggestion}`),
    ];
    writeFileSync("out/t6-private.md", priv.join("\n") + "\n");
  } else P("Real transcript not present; T6 skipped.", "");

  // Unknowns, Day-1 checks, verdict
  P(
    "## What the mock cannot answer",
    "",
    "- Whether Bee's ASR keeps fillers. Published real-Bee numbers suggest it strips most of them (T2).",
    "- Bee's French ASR accuracy for a high-A2 learner's accent. If Bee auto-corrects learner grammar (for example, hears *je suis allé* when *j'ai allé* was said), **the French product is dead**, because the errors never reach the text.",
    "- Whether Developer Mode works from Canada with an Apple Watch, and whether `bee login` succeeds.",
    "- Watch capture ergonomics: manual sessions, battery, background-mic caps.",
    "- Real speaker labels. They are always \"Unknown\" today (bee-cli issue 19).",
    "- Whether REST `journals get` returns `aiResponse`, and the unit of journal `created_at`. bee-cli tests use seconds for journals and ms for conversations.",
    "- Whether short voice notes survive. The <50-word deletion is reported only for conversations.",
    "",
    "## Day-1 checks on real hardware (inside the Apple ~14-day return window)",
    "",
    "1. Pair the Watch, enable Developer Mode (Settings, tap Version 5 times), run `bee login`, then `bee status`. **Kill criterion:** Developer Mode is unavailable from Canada.",
    "2. **French auto-correction test (the decisive one).** Read a script aloud as a voice note. It contains 10 planted learner errors (*j'ai allé*, *je suis 25 ans*, *le maison*, *à le cinéma*, *depuis* + passé composé, *ça fait du sens*) plus 3 deliberate *euh*. Then run `bee journals get <id> --json` and diff. **Kill criterion for FR:** fewer than 7 of 10 errors survive verbatim.",
    "3. English filler test: read a 2-minute stand-up rehearsal with 10 scripted *um/uh* and 10 hedges. Count what survives. Expected: hedges survive and fillers mostly do not.",
    "4. Record a solo stand-up rehearsal as a Watch **conversation**, then run `bee conversations get <id> --json`. Check that `start`/`end` are populated and that `speaker` is \"Unknown\", and note the delay.",
    "5. Record a 30-word drill both as a conversation and as a voice note. Confirm the conversation is deleted and the voice note survives.",
    "6. Run `BEE_SOURCE=cli npx vitest run test/contract.test.ts` against real output. It validates the zod contract live. Then run `BEE_SOURCE=cli npm run poc` once real data exists.",
    "",
  );
  P(...verdict(sum));

  // Cost and provenance
  P(
    "## Run provenance",
    "",
    `- bee-cli types: github.com/bee-computer/bee-cli @84a6e8fcb955a66fc15da63ce4c50289591959ec (2026-10-13).`,
    `- LLM usage: ${usage.calls} live calls this run, ${usage.cacheHits} cache hits, ${usage.inputTokens} input and ${usage.outputTokens} output tokens live. Responses are cached in \`cache/\` (keyed by sha256 of prompt and model chain), so reruns are free and deterministic.`,
    "- Pre-registration history: during development the split was reset (prereg/ deleted) whenever the model chain or the extraction prompt changed, because changing either one changes the pre-cutover evidence, and the code refuses to re-split silently. Within every run, including the final one, the split is written before any post-cutover fixture exists (`src/poc.ts` phase 1, then phase 2).",
    `- Total LLM spend for everything in cache/ (including superseded prompt versions): ${cacheTotals()}.`,
    `- Pre-registration files: \`prereg/en-split.json\`, \`prereg/fr-split.json\`. Errors rejected by zod/taxonomy validation: ${A.cleaned.rejected + A.verbatim.rejected}.`,
    `- LLM errors and fallbacks logged: ${llmLog.length} (\`out/llm-log.json\`).`,
    "",
  );
  writeFileSync("out/llm-log.json", JSON.stringify({ llmLog, usage }, null, 1));
  writeFileSync("out/summary.json", JSON.stringify(sum, null, 1));
  const text = md.filter((l) => l !== undefined).join("\n") + "\n";
  writeFileSync("POC_REPORT.md", text);
  writeFileSync("out/report.html", mdToHtml(text, "Bee speech-coach PoC report"));
  console.log(`POC_REPORT.md and out/report.html written. Models: ${JSON.stringify(usage.byModel)}; live calls ${usage.calls}, cache hits ${usage.cacheHits}.`);
}

function cacheTotals(): string {
  let n = 0, i = 0, o = 0;
  for (const f of readdirSync("cache")) {
    const c = JSON.parse(readFileSync(`cache/${f}`, "utf8"));
    n++;
    i += c.usage?.inputTokens ?? 0;
    o += c.usage?.outputTokens ?? 0;
  }
  // gpt-oss-120b on-demand list price assumption: $0.15 / 1M input, $0.60 / 1M output tokens
  return `${n} responses, ${i} input + ${o} output tokens, about $${((i * 0.15 + o * 0.6) / 1e6).toFixed(3)} at gpt-oss-120b list price (assumed $0.15/$0.60 per 1M tokens)`;
}

function esc(s: string) {
  return s.replace(/\|/g, "/").replace(/\n/g, " ");
}
function countTypes(xs: Item[]) {
  const m: Record<string, number> = {};
  for (const i of xs) m[i.error_type] = (m[i.error_type] ?? 0) + 1;
  return Object.entries(m).map(([k, v]) => `${k} x${v}`).join(", ") || "none";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
