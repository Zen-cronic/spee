import { Animated, StyleSheet, Text, View } from 'react-native';
import { HopTimeline } from '../components/HopTimeline';
import { SettingChip } from '../components/SettingChip';
import type { LiveMode, LiveWindow, Nudge, NudgeSkipped, Recap } from '../contract';
import { useDebug } from '../debug';
import { baselineWordsLabel, curly, fmt1, fmtDay, fmtInt, fmtWords, fmtMs, fmtPct, habitTitle, lastConversation, nudgeHops, nudgeHopsLine, nudgeRuleLine, nudgeText, overruleText, plainReason, recapNudgeLine, roundHeadline, roundLastLine, roundTally, RULE_LABEL, sessionTally, skipLine, usualWindow } from '../mirror/format';
import { drillPhase, drillSteps, type DrillState, type LiveSlice, type StepState } from '../mirror/reducer';
import { useEnter, useLoop, usePop } from '../motion';
import { C, F, habitHue, R, SP, SPLIT, T } from '../theme';

/**
 * Live: the drill on the left (the sentence to say, one status sentence, and a three-step tracker:
 * you said it, checked by Bee, result; then "Round over" with the round's tally when the session
 * ends), the current conversation on the right (pace, talk share, the two drilled habits over the
 * last 2 minutes, and the wrist nudge as the moment, with its hops: you said it, Bee, wrist alarm).
 * A nudge the coach held back is one "Stayed quiet" line. Developer detail (speaker score, the
 * five hops in ms, box numbers) shows only in debug.
 */
export function LiveView({ drill, live, partial, focus, last, onCycleSetting }: { drill: DrillState; live: LiveSlice; partial: string | null; focus: 'drill' | 'live'; last?: Recap | null; onCycleSetting?: () => void }) {
  return (
    <View style={styles.wrap} testID="view-live">
      <View style={styles.drill}>
        <DrillPanel d={drill} partial={partial} />
      </View>
      <View style={styles.convo}>
        <ConversationPanel live={live} last={last ?? null} onCycleSetting={onCycleSetting} />
      </View>
    </View>
  );
}

function Dot({ state, bee }: { state: StepState; bee?: boolean }) {
  const pulse = useLoop(state === 'now', 600);
  // Bee's step never turns coral: a line Bee did not confirm is an open ring in the bee colour (coral is a graded fail)
  const beeMissed = bee && state === 'bad';
  const fill = state === 'todo' || beeMissed ? 'transparent' : state === 'now' ? C.beeOnLight : state === 'bad' ? C.coral : state === 'pass' ? C.lime : bee ? C.beeOnLight : C.ink;
  const border = beeMissed ? C.beeOnLight : state === 'todo' ? C.inkFaint : state === 'pass' ? C.ink : fill;
  return <Animated.View style={[styles.dot, { backgroundColor: fill, borderColor: border, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }) }]} />;
}

function Tracker({ steps }: { steps: { label: string; state: StepState; bee?: boolean }[] }) {
  return (
    <View style={styles.tracker} testID="drill-tracker">
      <View style={styles.trackLine} />
      {steps.map((s, i) => (
        <View key={s.label} style={[styles.step, { alignItems: i === 0 ? 'flex-start' : i === steps.length - 1 ? 'flex-end' : 'center' }]}>
          <Dot state={s.state} bee={s.bee} />
          <Text style={[styles.stepLabel, s.state === 'todo' && styles.stepTodo]}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The round is over (the session ended): the tally is the headline, one segment per line (lime
 * passed, coral not yet, an open sky ring while Bee still checks it), the last line's result in
 * one sentence, and how to start the next round. Same frame as an open line, so nothing moves.
 */
function RoundOver({ d }: { d: DrillState }) {
  const s = d.summary!;
  const enter = useEnter(`over:${s.sessionId}`, 14, 280);
  const g = d.graded;
  const overrules = g?.agreement === 'bee-overrules';
  const checking = !g && (d.stage === 'provisional' || d.stage === 'checking' || d.stage === 'verified');
  const last = roundLastLine({ graded: g, stage: d.stage, previewSource: d.provisional?.source ?? null });
  const segs = (s.perCard ?? []).slice(0, 10);
  const { heard, checked, graded } = drillSteps(d);
  return (
    <View style={styles.fill} testID="round-over">
      <Text style={styles.kicker} numberOfLines={1}>Round over</Text>
      <Text style={styles.sentence} numberOfLines={2}>{roundHeadline(s)}</Text>
      <Animated.View style={[styles.band, styles.bandIdle, styles.bandOver, enter]}>
        {segs.length ? (
          <View style={styles.segs} testID="round-segments">
            {segs.map((c, i) => (
              <View key={`${c.cardId}:${i}`} style={[styles.seg, c.passed > 0 ? styles.segPass : c.attempts > 0 ? styles.segFail : styles.segOpen, i === segs.length - 1 && { marginRight: 0 }]} />
            ))}
          </View>
        ) : null}
        <Text style={styles.tally} numberOfLines={2}>{roundTally(s)}</Text>
        {last ? (
          <View style={styles.lastLine}>
            {overrules ? (
              <View style={[styles.beeTag, styles.beeTagInline]}>
                <Text style={styles.beeTagText}>Bee’s call</Text>
              </View>
            ) : checking ? (
              <View style={[styles.beeTag, styles.beeTagInline, styles.beeTagWait]}>
                <Text style={[styles.beeTagText, { color: C.beeTextOnLight }]}>Still with Bee</Text>
              </View>
            ) : null}
            <Text style={[styles.support, styles.supportSmall]} numberOfLines={2}>{last}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <View style={[styles.cta, styles.ctaInBand]}>
          <Text style={styles.ctaText} numberOfLines={1}>“Alexa, ask Speech Coach to quiz me”</Text>
        </View>
      </Animated.View>
      <Tracker
        steps={[
          { label: 'You said it', state: heard },
          { label: 'Checked by Bee', state: checked, bee: true },
          { label: 'Result', state: graded },
        ]}
      />
    </View>
  );
}

function DrillPanel({ d, partial }: { d: DrillState; partial: string | null }) {
  const debug = useDebug();
  const card = d.card;
  const st = d.stage;
  const enter = useEnter(`${card?.id ?? 'none'}:${st}`, 14, 280);
  // the pass lands with a short spring (none with reduced motion): the one moment worth celebrating
  const pop = usePop(d.graded?.pass ? `${d.attemptId}:pass` : 'none', 0.05);
  if (drillPhase(d) === 'over') return <RoundOver d={d} />;
  if (!card) {
    // the same frame as an open line (kicker, sentence, result slot, tracker), so nothing moves when one opens
    const due = d.deck?.dueNow ?? 0;
    return (
      <View style={styles.fill}>
        <Text style={styles.kicker}>Practice line</Text>
        {/* one display line per card; the instructions are body text, and no inner panel until there is a result */}
        <Text style={styles.sentence} numberOfLines={3}>{due > 0 ? `${due} line${due === 1 ? '' : 's'} to practise.` : 'Nothing due right now.'}</Text>
        <View style={[styles.band, styles.bandPlain]} testID="drill-idle">
          <Text style={styles.instruction} numberOfLines={3}>{due > 0 ? 'Ask Alexa for a line, then say it out loud. Bee checks every line you say.' : 'Ask Alexa for a line any time. Bee checks every line you say.'}</Text>
          <View style={{ flex: 1 }} />
          <View style={[styles.cta, styles.ctaInBand]}>
            <Text style={styles.ctaText} numberOfLines={1}>“Alexa, ask Speech Coach to quiz me”</Text>
          </View>
        </View>
        <Tracker
          steps={[
            { label: 'You said it', state: 'todo' },
            { label: 'Checked by Bee', state: 'todo', bee: true },
            { label: 'Result', state: 'todo' },
          ]}
        />
      </View>
    );
  }
  const pv = d.provisional;
  const v = d.verified;
  const g = d.graded;
  const { heard, checked, graded } = drillSteps(d);
  let status: string;
  let support: string | null = null;
  let band = styles.bandIdle;
  let ink: string = C.ink;
  const overrules = g?.agreement === 'bee-overrules';
  if (g) {
    status = g.pass ? 'Passed.' : 'Not yet.';
    support = g.pass ? `Nice — Bee heard it.${g.dueAfter ? ` See it again ${fmtDay(g.dueAfter)}.` : ''}` : `${plainReason(g.failure) ?? 'So close'}. Say it again, slower.`;
    band = g.pass ? styles.bandPass : styles.bandFail;
    ink = g.pass ? C.limeInk : C.coralInk;
    if (overrules) support = curly(overruleText(pv?.source, g.pass, g.beeText));
  } else if (st === 'unverified') {
    status = 'Bee didn’t catch that one.';
    support = 'It doesn’t count yet. Say it again.';
  } else if (st === 'verified') {
    status = 'Bee heard you. Grading…';
    band = styles.bandWait;
  } else if (st === 'provisional' || st === 'checking') {
    status = 'Bee is checking…';
    support = 'Only what Bee heard counts.';
    band = styles.bandWait;
  } else {
    status = partial ? `“${partial}”` : 'Your turn: say it out loud, to Alexa or your phone.';
    support = partial ? 'Hearing you…' : null;
    band = styles.bandPlain;
  }
  return (
    <View style={styles.fill}>
      <Text style={styles.kicker} numberOfLines={1}>{card.said ? `Instead of “${card.said}”, say` : 'Say'}</Text>
      <Text style={styles.sentence} numberOfLines={3}>{card.resay || card.fix}</Text>
      <Animated.View style={[styles.band, band, enter, g?.pass ? pop : null]} testID={overrules ? 'bee-overrules' : 'drill-verdict'}>
        {overrules ? (
          <View style={styles.beeTag}>
            <Text style={styles.beeTagText}>Bee’s call</Text>
          </View>
        ) : null}
        <View style={styles.bandHead}>
          <Text style={[styles.status, status.length <= 9 && !overrules && styles.statusBig, band === styles.bandPlain && !partial && styles.instruction, band === styles.bandPlain && !!partial && styles.partial, { color: band === styles.bandPlain ? C.inkDim : ink }]} numberOfLines={2}>{status}</Text>
        </View>
        {support ? <Text style={[styles.support, overrules && styles.supportSmall, { color: ink }]} numberOfLines={overrules ? 4 : 2}>{support}</Text> : null}
      </Animated.View>
      <Tracker
        steps={[
          { label: 'You said it', state: heard },
          { label: 'Checked by Bee', state: checked, bee: true },
          { label: 'Result', state: graded },
        ]}
      />
      {debug ? (
        <Text style={styles.debug} numberOfLines={2}>
          {[pv ? `preview ${pv.source}: ${pv.pass ? 'pass' : 'fail'} "${pv.text}"` : null, v ? (v.status === 'verified' ? `speaker ${v.speakerScore ?? '–'} · ${fmtMs(v.latencyMs)} · via ${v.via ?? '–'}${v.replay ? ' · replay' : ''}` : v.reason) : null, g && g.boxFrom !== null ? `box ${g.boxFrom} → ${g.boxTo}` : null, d.summary ? sessionTally('session', d.summary) : null, `stage ${st}`].filter(Boolean).join('  ·  ')}
        </Text>
      ) : null}
    </View>
  );
}

function Listening({ active }: { active: boolean }) {
  const pulse = useLoop(active, 900);
  return <Animated.View style={[styles.listenDot, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }) }]} />;
}

function Mode({ mode }: { mode: LiveMode | null }) {
  const on = !!mode?.enabled;
  return (
    <View style={[styles.mode, on && styles.modeOn]} testID="live-mode">
      <View style={[styles.modeDot, { backgroundColor: on ? C.lime : C.faint }]} />
      <Text style={[styles.modeText, on && styles.modeTextOn]}>{!mode ? 'Live coaching' : on ? 'Live coaching on' : 'Live coaching off'}</Text>
    </View>
  );
}

/** One number with its words beside it ("140 words a minute"); a habit's count in its own hue, coral (and "high") once its nudge rule is crossed. */
function Stat({ value, label, habit, over, usual }: { value: string; label: string; habit?: string; over?: boolean; usual?: boolean }) {
  const hue = habit ? habitHue(habit).hue : null;
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, hue ? { color: hue } : usual ? styles.usual : null, over && { color: C.coral }]} numberOfLines={1}>{value}</Text>
      <Text style={[styles.statWords, over && { color: C.coral }]} numberOfLines={1}>{over ? `${label} · high` : label}</Text>
    </View>
  );
}

/**
 * The nudge, the hero of Live: the rule that fired, the words the wrist alarm carries, and its
 * three hops on a true time axis (you said it, Bee tagged it, the wrist alarm the hub set). The
 * hub cannot see the Watch, so it never claims a buzz.
 */
function NudgeCard({ nudge }: { nudge: Nudge }) {
  const enter = useEnter(nudge.id, 24, 360);
  const pop = usePop(nudge.id, 0.03);
  const failed = nudge.wrist.status === 'failed';
  const [you, bee, alarm] = nudgeHops(nudge);
  const end = Math.max(1, bee!.ms ?? 0, alarm!.ms ?? 0);
  // Bee's stop sits at its true share of the wait; its label stays clear of the two ends
  const beeX = Math.min(1, (bee!.ms ?? 0) / end);
  const beeLabelX = Math.max(0.3, Math.min(0.56, beeX));
  return (
    <Animated.View style={[styles.nudge, enter]} testID="nudge-card">
      <Text style={styles.nudgeKicker} numberOfLines={1}>{failed ? `Nudge not set · ${RULE_LABEL[nudge.rule]}` : `Wrist nudge · ${RULE_LABEL[nudge.rule]}`}</Text>
      <Animated.Text style={[styles.nudgeText, pop]} numberOfLines={2}>{nudgeText(nudge)}</Animated.Text>
      <View style={styles.hops} testID="nudge-hops" accessibilityLabel={nudgeHopsLine(nudge)}>
        <View style={styles.hopTrack}>
          <View style={styles.hopAxis} />
          <View style={[styles.hopSpan, { width: `${beeX * 100}%` }]} />
          <View style={[styles.hopDot, styles.hopDotYou, { left: 0 }]} />
          <View style={[styles.hopDot, styles.hopDotBee, { left: `${beeX * 100}%` }]} />
          <View style={[styles.hopDot, alarm!.ms === null ? styles.hopDotMissed : styles.hopDotAlarm, { left: '100%' }]} />
        </View>
        <View style={styles.hopLabels}>
          <Text style={styles.hopLabel} numberOfLines={1}>{you!.label}</Text>
          <View style={[styles.hopMid, { left: `${beeLabelX * 100}%` }]}>
            <Text style={[styles.hopLabel, styles.hopLabelBee]} numberOfLines={1}>{bee!.label}</Text>
          </View>
          <View style={{ flex: 1 }} />
          <Text style={[styles.hopLabel, styles.hopLabelAlarm]} numberOfLines={1}>{alarm!.label.replace(/^w/, 'W')}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

/**
 * The conversation card keeps one layout in every state: the status line, one row of four numbers
 * (each with its window: this conversation and its last 2 minutes, or your usual this week), then
 * one slot for the moment: the wrist nudge, when nudges fire, the last conversation, or a hint.
 * A nudge the coach held back is one quiet line under it.
 */
function ConversationPanel({ live, last, onCycleSetting }: { live: LiveSlice; last: Recap | null; onCycleSetting?: () => void }) {
  const debug = useDebug();
  const w: LiveWindow | null = live.window;
  const b = live.baseline;
  const idle = !w;
  const over = (r: string) => !!w?.rules.find((x) => x.rule === r)?.over;
  // only this conversation's nudge is the moment; an older one is the recap's
  const nudge: Nudge | undefined = live.nudges.find((n) => !w || n.conversationId === w.conversationId);
  const skip: NudgeSkipped | undefined = w ? live.skips.find((s) => s.conversationId === w.conversationId) : undefined;
  const unsure = habitTitle('hedges').toLowerCase();
  const like = curly(habitTitle('filler:like')).replace(/^F/, 'f');
  const usual = b ? usualWindow(b) : 'this week';
  const status = w ? 'Bee is hearing you · this conversation' : live.ended ? `Conversation ended · your usual ${usual}` : `Bee is listening · your usual ${usual}`;
  const footer = lastConversation(live.ended, last);
  const hint = !w ? footer.hint : null;
  const on = !!live.mode?.enabled;
  const rule = w ? nudgeRuleLine(w.rules, live.mode, w.recent.windowMs) : null;
  const recapNudges = last && footer.headline ? recapNudgeLine(last.nudges) : null;
  const mins = Math.max(1, Math.round((w?.recent.windowMs ?? 120_000) / 60_000));
  const windowLabel = `Last ${mins} minute${mins === 1 ? '' : 's'}`;
  return (
    <View style={styles.fill}>
      <View style={styles.rowBetween}>
        <Text style={styles.convoTitle}>Conversation</Text>
        <Mode mode={live.mode} />
      </View>
      <View style={styles.listenRow} testID="conversation-status">
        <Listening active={idle} />
        <Text style={styles.listenTitle} numberOfLines={1}>{status}</Text>
      </View>
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.groupLabel} numberOfLines={1}>{idle ? `Usually, ${usual}` : 'This conversation'}</Text>
          <Stat usual={idle} value={w ? fmtInt(w.wearer.wpm) : fmtInt(b?.wpm)} label="words a minute" />
          <Stat usual={idle} value={w ? fmtPct(w.talkShare) : b ? fmtWords(b.words) : '–'} label={idle ? (b ? baselineWordsLabel(b).replace(/^your /, '') : 'words this week') : 'you talked'} />
        </View>
        <View style={[styles.column, styles.columnRight]}>
          <Text style={styles.groupLabel} numberOfLines={1}>{idle ? 'Out of every 100 words' : windowLabel}</Text>
          <Stat habit="hedges" value={w ? String(w.recent.hedges) : fmt1(b?.hedgesPer100)} label={unsure} over={over('hedge-streak')} />
          <Stat habit="filler:like" value={w ? String(w.recent.likes) : fmt1(b?.likesPer100)} label={like} over={over('like-streak')} />
        </View>
      </View>
      {debug && w ? <Text style={styles.debugDark} numberOfLines={1}>{`fillers ${w.recent.fillers} · vague ${w.recent.vague} · restarts ${w.recent.restarts} · turn ${fmtMs(w.monologue.currentMs)} (max ${fmtMs(w.monologue.longestMs)}) · ${w.pauses.count} pauses · others ${w.others.lines} lines`}</Text> : null}
      <View style={styles.slot}>
        {w && nudge ? (
          <NudgeCard nudge={nudge} />
        ) : w ? (
          <View style={styles.waiting} testID="nudge-waiting">
            <Text style={styles.waitTitle} numberOfLines={1}>{on ? 'Listening for a streak' : 'No wrist nudges'}</Text>
            <Text style={styles.waitText} numberOfLines={3}>{on ? (rule ?? 'One wrist nudge on a streak, then quiet.') : 'Live coaching is off. To turn it on, say “Alexa, ask Speech Coach to turn on live coaching”.'}</Text>
          </View>
        ) : footer.headline ? (
          <View style={styles.last} testID="last-conversation">
            <View style={styles.lastHead}>
              <Text style={styles.lastKicker}>Last conversation</Text>
              {/* Down from the tabs, then OK, changes where it happened */}
              <SettingChip tag={last?.setting} tone="dark" focusId="last-setting" onCycle={onCycleSetting} testID="last-setting" />
            </View>
            <Text style={styles.lastText} numberOfLines={3}>{curly(footer.headline)}</Text>
            {recapNudges ? <Text style={styles.lastNudges} numberOfLines={1}>{recapNudges}</Text> : null}
          </View>
        ) : (
          <Text style={styles.listenHint} numberOfLines={2}>{hint ?? 'Your numbers light up when you talk. Other voices are never shown.'}</Text>
        )}
      </View>
      {skip ? (
        <View style={styles.skip} testID="nudge-skip">
          <View style={styles.skipRing} />
          <Text style={styles.skipText} numberOfLines={1}>{skipLine(skip)}</Text>
        </View>
      ) : null}
      {debug && nudge ? <HopTimeline nudge={nudge} width={700} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  fill: { flex: 1 },
  drill: { width: SPLIT.left, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl, marginRight: SP.l },
  convo: { flex: 1, backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { color: C.inkDim, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  sentence: { color: C.ink, fontSize: 60, lineHeight: 72, fontWeight: '700', letterSpacing: -1, marginTop: SP.m, fontFamily: F.family },
  band: { flex: 1, minHeight: 224, marginTop: SP.xl, borderRadius: R.m, paddingHorizontal: SP.xl, paddingVertical: SP.xl, justifyContent: 'center' },
  bandIdle: { backgroundColor: 'rgba(0,0,0,0.05)' },
  // a neutral state (no line yet, or your turn): no panel, the text sits under the headline
  bandPlain: { backgroundColor: 'transparent', paddingHorizontal: 0, paddingTop: SP.s, paddingBottom: 0, justifyContent: 'flex-start' },
  instruction: { color: C.inkDim, fontSize: 32, lineHeight: 46, fontWeight: '400', letterSpacing: 0 },
  partial: { color: C.ink, fontSize: T.h2, lineHeight: 58, fontWeight: '700', letterSpacing: 0 },
  bandWait: { backgroundColor: C.beeWash },
  bandPass: { backgroundColor: C.lime },
  bandFail: { backgroundColor: C.coral },
  bandHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  beeTag: { alignSelf: 'flex-start', backgroundColor: C.bee, borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6, marginBottom: SP.s },
  beeTagText: { color: C.beeInk, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  listenRow: { flexDirection: 'row', alignItems: 'center', marginTop: SP.l },
  listenDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.bee, marginRight: SP.s },
  listenTitle: { color: C.dim, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  listenHint: { color: C.faint, fontSize: T.body, lineHeight: 42, maxWidth: 640, fontFamily: F.family },
  // your usual numbers between conversations: one step quieter than live, still readable from the couch
  usual: { color: C.dim },
  last: { borderTopWidth: 2, borderColor: C.line, paddingTop: SP.l },
  lastHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastKicker: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  lastText: { color: C.text, fontSize: T.title, lineHeight: 52, fontWeight: '700', marginTop: SP.s, fontFamily: F.family },
  status: { flexShrink: 1, fontSize: 56, lineHeight: 66, fontWeight: '700', letterSpacing: -1, fontFamily: F.family },
  statusBig: { fontSize: 104, lineHeight: 116, letterSpacing: -3 },
  support: { color: C.inkDim, fontSize: T.body, lineHeight: 40, marginTop: SP.s, fontFamily: F.family },
  supportSmall: { fontSize: T.small, lineHeight: 38 },
  cta: { alignSelf: 'flex-start', backgroundColor: C.ink, borderRadius: R.pill, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginBottom: SP.l },
  ctaInBand: { marginTop: SP.l, marginBottom: 0, paddingHorizontal: SP.l },
  ctaText: { color: C.lime, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  tracker: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SP.xl },
  trackLine: { position: 'absolute', left: 18, right: 18, top: 17, height: 3, backgroundColor: 'rgba(0,0,0,0.12)' },
  step: {},
  dot: { width: 36, height: 36, borderRadius: 18, borderWidth: 3 },
  stepLabel: { color: C.ink, fontSize: T.body, fontWeight: '700', marginTop: SP.s, fontFamily: F.family },
  stepTodo: { color: C.inkDim, fontWeight: '600' },
  debug: { color: C.inkDim, fontSize: 20, marginTop: SP.s, fontFamily: F.mono },
  debugDark: { color: C.faint, fontSize: 20, marginTop: SP.s, fontFamily: F.mono },
  convoTitle: { color: C.text, fontSize: T.title, fontWeight: '700', fontFamily: F.family },
  mode: { flexDirection: 'row', alignItems: 'center', borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6 },
  modeOn: { backgroundColor: C.limeBg },
  modeDot: { width: 14, height: 14, borderRadius: 7, marginRight: SP.s },
  modeText: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  modeTextOn: { color: C.lime, fontWeight: '700' },
  // two windows side by side: this conversation | its last 2 minutes (or your usual | per 100 words)
  columns: { flexDirection: 'row', marginTop: SP.l },
  column: { flex: 1 },
  columnRight: { borderLeftWidth: 2, borderColor: C.line, paddingLeft: SP.l },
  groupLabel: { color: C.faint, fontSize: T.label, marginBottom: SP.xs, fontFamily: F.family },
  stat: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  // no negative letter spacing, margin or padding on light numerals: on Vega each drew a sliver beside the first glyph
  statValue: { flexShrink: 0, color: C.text, fontSize: 56, lineHeight: 68, fontWeight: '700', fontFamily: F.family },
  statWords: { flexShrink: 1, color: C.dim, fontSize: T.label, marginLeft: SP.s, fontFamily: F.family },
  slot: { flex: 1, justifyContent: 'flex-end', marginTop: SP.l },
  nudge: { backgroundColor: C.coralBg, borderRadius: R.m, paddingHorizontal: SP.xl, paddingTop: SP.l, paddingBottom: SP.l, borderLeftWidth: 10, borderColor: C.coral },
  nudgeKicker: { color: C.coral, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  nudgeText: { color: C.text, fontSize: 46, lineHeight: 58, fontWeight: '700', marginTop: SP.s, fontFamily: F.family },
  hops: { marginTop: SP.l },
  hopTrack: { height: 28, justifyContent: 'center', marginHorizontal: 14 },
  hopAxis: { position: 'absolute', left: 0, right: 0, top: 12, height: 4, borderRadius: 2, backgroundColor: 'rgba(242,135,110,0.35)' },
  hopSpan: { position: 'absolute', left: 0, top: 12, height: 4, borderRadius: 2, backgroundColor: C.bee },
  hopDot: { position: 'absolute', top: 0, width: 28, height: 28, borderRadius: 14, marginLeft: -14 },
  hopDotYou: { backgroundColor: C.text },
  hopDotBee: { backgroundColor: C.bee },
  hopDotAlarm: { backgroundColor: C.coral },
  hopDotMissed: { backgroundColor: C.coralBg, borderWidth: 4, borderColor: C.faint },
  hopLabels: { flexDirection: 'row', marginTop: SP.s },
  hopMid: { position: 'absolute', top: 0, width: 260, transform: [{ translateX: -130 }], alignItems: 'center' },
  hopLabel: { color: C.dim, fontSize: T.label, fontWeight: '600', fontFamily: F.family },
  hopLabelBee: { color: C.bee },
  hopLabelAlarm: { color: C.text, fontWeight: '700' },
  waiting: { borderTopWidth: 2, borderColor: C.line, paddingTop: SP.l },
  waitTitle: { color: C.text, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  waitText: { color: C.dim, fontSize: T.small, lineHeight: 40, marginTop: SP.xs, fontFamily: F.family },
  lastNudges: { color: C.faint, fontSize: T.label, marginTop: SP.s, fontFamily: F.family },
  skip: { flexDirection: 'row', alignItems: 'center', marginTop: SP.m, paddingLeft: SP.xs },
  skipRing: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: C.dim, marginRight: SP.s },
  skipText: { flexShrink: 1, color: C.dim, fontSize: T.label, fontFamily: F.family },
  // Round over: the tally band
  bandOver: { justifyContent: 'flex-start', paddingVertical: SP.l },
  segs: { flexDirection: 'row', marginBottom: SP.m },
  seg: { flex: 1, height: 16, borderRadius: 8, marginRight: SP.xs },
  segPass: { backgroundColor: C.limeOnLight },
  segFail: { backgroundColor: C.coral },
  segOpen: { borderWidth: 3, borderColor: C.beeOnLight },
  tally: { color: C.ink, fontSize: T.title, lineHeight: 48, fontWeight: '700', fontFamily: F.family },
  lastLine: { marginTop: SP.m },
  beeTagInline: { marginBottom: SP.xs },
  beeTagWait: { backgroundColor: C.beeWash },
});
