// Recommendation. Numbers come from the run summary; the judgement is the author's.
type N = number | null | undefined;
const p = (x: N) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);

export function verdict(sum: Record<string, any>): string[] {
  const g = (k: string) => sum[k] ?? {};
  const t3 = sum.t3 ?? {};
  const t4 = sum.t4 ?? {};
  const t6 = sum.t6;
  return [
    "## Recommendation: GO-IF (buy the Watch tonight as a 14-day option, not a commitment)",
    "",
    "**Build: a French, voice-note-centred drill coach. English is secondary: a hedge/ETA/structure coach for solo stand-up rehearsals. No filler coaching and no grading of group conversations.** Return the Watch if either Day-1 kill criterion fires (checks 1 and 2 above).",
    "",
    "### Why not a plain GO",
    "",
    `- **Group conversations cannot be graded.** With every speaker \"Unknown\", ${p(t4["en-cleaned"]?.groupOther)} (EN) and ${p(t4["fr-cleaned"]?.groupOther)} (FR) of extracted items sat on someone else's line. Precision on \"this is YOUR error\" in groups was only ${p(g("t1_en_cleaned_conversation").precisionWearer)} EN and ${p(g("t1_fr_cleaned_conversation").precisionWearer)} FR. The contamination also leaked into the pre-registered split: ${[...(t3.en?.pollution ?? []), ...(t3.fr?.pollution ?? [])].join(" and ") || "none"} were drilled although only other speakers make those errors. In FR the coach built a drill card from a classmate's sentence. The generic baseline had the same blind spot: it praised the user for the teacher's correction and the stand-up lead's turn-taking.`,
    "- **Filler coaching is probably gone on Bee.** A published real-Bee filler rate is 14 to 47 times below real captioned speech. The EN product would lose its most legible metric, and live filler counters already exist, including on Apple Watch.",
    `- **Real English speech is hard.** On the one real stand-up, ${t6 ? `${t6.noGuardArtifact} of ${t6.noGuardItems}` : "n/a"} unguarded items (and ${t6 ? `${t6.guardDrillableArtifact} of ${t6.guardDrillable}` : "n/a"} guarded drillable items) carried ASR-misheard tool names into the coaching. Corrections invented specifics despite an explicit instruction not to, and 45 s ASR chunks make run-on and citation granularity meaningless. The synthetic EN data is much cleaner than reality, so treat the T1 EN numbers as an upper bound.`,
    `- **Re-performance cannot be shown at real effect sizes before the deadline.** The pipeline recovered the planted 5x drop: EN drilled ${t3.en?.all?.[0] ?? "n/a"} vs control ${t3.en?.all?.[1] ?? "n/a"} post/pre ratio (truth ${t3.en?.truth?.[0] ?? "n/a"} vs ${t3.en?.truth?.[1] ?? "n/a"}); FR ${t3.fr?.all?.[0] ?? "n/a"} vs ${t3.fr?.all?.[1] ?? "n/a"} (truth ${t3.fr?.truth?.[0] ?? "n/a"} vs ${t3.fr?.truth?.[1] ?? "n/a"}). But voice-note-only controls also drifted (EN control ${t3.en?.voice?.[1] ?? "n/a"}, FR ${t3.fr?.voice?.[1] ?? "n/a"}) with only 3 notes per phase. A realistic 30% drop at about 1 instance per session needs on the order of 35 or more sessions per phase, pooled across types. There are about 9 days to the 2026-10-23 15:00 EDT deadline. The judge-visible claim must be \"it measures\" (a drilled error, its re-say, and its next-day recurrence check), not \"it works\".`,
    "- **French has a fatal unknown that only the device can answer.** If Bee's ASR language model auto-corrects learner grammar, the errors never reach the text. The account's primary-language setting may also garble French when English is primary.",
    "",
    "### Why not NO-GO",
    "",
    `- **On what Bee is expected to keep (the cleaned condition), the core survives.** Voice-note extraction was ${p(g("t1_fr_cleaned_voice_note").precisionWearer)} precise with ${p(g("t1_fr_cleaned_voice_note").recallWearer)} recall in FR, and ${p(g("t1_en_cleaned_voice_note").precisionWearer)} / ${p(g("t1_en_cleaned_voice_note").recallWearer)} in EN (synthetic, optimistic). Recall barely moved from verbatim to cleaned, so the lexical hedges, vagueness, ETA and status structure, and French grammar/lexical errors do not depend on fillers.`,
    "- **Specificity is clearly above the comparator.** 100% of drills cite a real line and quote it verbatim, with a correction and a corrected re-say sentence. The generic \"Daily Insights\" baseline cannot be traced to any line and misattributes other speakers' behaviour. This is the Stage One differentiator.",
    "- **Voice notes are the clean channel.** They are wearer-only (0% contamination), the reported <50-word deletion applies to conversations (it ate a recorded drill conversation here), though survival of short notes is unverified, and the CLI can write drills back to Bee as todos with alarms (shown above, not executed). Education is a named priority use case, and no in-event twin was found for French drills.",
    "",
    "### Which language",
    "",
    "**French is stronger, conditional on Day-1 check 2.** Its errors are lexical, discrete, survive filler stripping, map to a curriculum, and are rarely ASR-confusable with tech jargon. The lane is uncrowded. English is weaker: its signal is softer (hedges and structure), real work speech is full of misheard jargon, its best metric (fillers) likely does not exist on Bee, and it competes with mature products.",
    "",
    "### What the purchase buys and risks",
    "",
    "- **Buys:** the only path to Developer Mode open to a Canadian entrant (Bee hardware does not ship to Canada) and therefore the only way to enter the Bee track at all. It also answers the three gating unknowns (Dev Mode from Canada, French error survival, filler retention) within one evening of setup.",
    "- **Risks:** the hardware cost if the return window is missed; a setup evening that could find Dev Mode blocked in Canada; Watch capture friction (manual sessions, battery); and 9 days left with a day job, of which only about 7 can produce real data. Mitigation: run Day-1 checks 1 and 2 on the day the Watch arrives, and set a calendar reminder 3 days before the return deadline.",
    "",
  ];
}
