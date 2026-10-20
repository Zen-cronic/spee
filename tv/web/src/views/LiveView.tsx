import { Animated, StyleSheet, Text, View } from 'react-native';
import { HopTimeline } from '../components/HopTimeline';
import { SettingChip } from '../components/SettingChip';
import type { LiveMode, LiveWindow, Nudge, NudgeSkipped, Recap } from '../contract';
import { useDebug } from '../debug';
import { baselineWordsLabel, curly, fmt1, fmtDay, fmtInt, fmtWords, fmtMs, fmtPct, habitTitle, lastConversation, overruleText, plainReason, RULE_LABEL, sessionTally, SKIP_LABEL } from '../mirror/format';
import { drillSteps, type DrillState, type LiveSlice, type StepState } from '../mirror/reducer';
import { useEnter, useLoop, usePop } from '../motion';
import { C, F, R, SP, SPLIT, T } from '../theme';

/**
 * Live: the drill on the left (the sentence to say, one status sentence, and a three-step tracker:
 * you said it, checked by Bee, graded), the current conversation on the right (pace, talk share,
 * the two drilled habits over the last 2 minutes, and the last wrist nudge). Developer detail
 * (speaker score, hops in ms, held-back nudges) shows only in debug.
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
  // Bee's step never turns coral: a line Bee did not confirm is an open lavender ring (coral is a graded fail)
  const beeMissed = bee && state === 'bad';
  const fill = state === 'todo' || beeMissed ? 'transparent' : state === 'now' ? C.lavender : state === 'bad' ? C.coral : state === 'pass' ? C.lime : bee ? C.lavender : C.ink;
  const border = beeMissed ? C.lavender : state === 'todo' ? C.inkFaint : state === 'pass' ? C.ink : fill;
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

function DrillPanel({ d, partial }: { d: DrillState; partial: string | null }) {
  const debug = useDebug();
  const card = d.card;
  const st = d.stage;
  const enter = useEnter(`${card?.id ?? 'none'}:${st}`, 14, 280);
  // the pass lands with a short spring (none with reduced motion): the one moment worth celebrating
  const pop = usePop(d.graded?.pass ? `${d.attemptId}:pass` : 'none', 0.05);
  if (!card) {
    // the same frame as an open line (kicker, sentence, result slot, tracker), so nothing moves when one opens
    const due = d.deck?.dueNow ?? 0;
    return (
      <View style={styles.fill}>
        <Text style={styles.kicker}>Practice line</Text>
        <Text style={styles.sentence} numberOfLines={3}>Ready when you are.</Text>
        <View style={[styles.band, styles.bandIdle]} testID="drill-idle">
          <Text style={[styles.status, { color: C.ink }]} numberOfLines={2}>{due > 0 ? `${due} line${due === 1 ? '' : 's'} to practise.` : 'Nothing due right now.'}</Text>
          <Text style={styles.support} numberOfLines={2}>{d.summary ? sessionTally('Last time', d.summary) : 'Alexa gives you a line. Say it out loud, and Bee checks it.'}</Text>
          <View style={[styles.cta, styles.ctaInBand]}>
            <Text style={styles.ctaText}>Say “Alexa, quiz me”</Text>
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
    status = partial ? `“${partial}”` : 'Your turn. Say it out loud.';
    support = partial ? 'Hearing you…' : 'To Alexa or your phone.';
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
          <Text style={[styles.status, status.length <= 9 && styles.statusBig, { color: ink }]} numberOfLines={2}>{status}</Text>
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
    <View style={styles.mode}>
      <View style={[styles.modeDot, { backgroundColor: on ? C.lime : C.faint }]} />
      <Text style={styles.modeText}>{!mode ? 'Wrist nudges' : on ? 'Wrist nudges on' : 'Wrist nudges off'}</Text>
    </View>
  );
}

function Counter({ label, value, over, idle }: { label: string; value: string; over: boolean; idle: boolean }) {
  return (
    <View style={styles.counter}>
      <Text style={[styles.counterValue, idle && styles.usual, over && { color: C.coral }]}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/**
 * The conversation card keeps one layout in every state, so nothing jumps when Bee starts hearing
 * you: between conversations it shows your usual numbers dimmed (the hub's baseline), and they
 * brighten into this conversation's numbers once one starts.
 */
function ConversationPanel({ live, last, onCycleSetting }: { live: LiveSlice; last: Recap | null; onCycleSetting?: () => void }) {
  const debug = useDebug();
  const w: LiveWindow | null = live.window;
  const b = live.baseline;
  const idle = !w;
  const over = (r: string) => !!w?.rules.find((x) => x.rule === r)?.over;
  const nudge: Nudge | undefined = live.nudges[0];
  const skip: NudgeSkipped | undefined = live.skips[0];
  const unsure = habitTitle('hedges').toLowerCase();
  const like = curly(habitTitle('filler:like')).replace(/^F/, 'f');
  const status = w ? 'Bee is hearing you now.' : live.ended ? 'Conversation ended · your usual numbers' : 'Bee is listening · your usual numbers';
  const footer = lastConversation(live.ended, last);
  const hint = !w ? footer.hint : null;
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
      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={[styles.statBig, idle && styles.usual]}>{w ? fmtInt(w.wearer.wpm) : fmtInt(b?.wpm)}</Text>
          <Text style={styles.statLabel} numberOfLines={1}>words a minute</Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statBig, idle && styles.usual]}>{w ? fmtPct(w.talkShare) : b ? fmtWords(b.words) : '–'}</Text>
          <Text style={styles.statLabel} numberOfLines={1}>{idle ? (b ? baselineWordsLabel(b) : 'your words this week') : 'you talked'}</Text>
        </View>
      </View>
      <Text style={styles.sub}>{idle ? 'Usually, out of every 100 words you say' : 'Last 2 minutes'}</Text>
      <View style={styles.counters}>
        <Counter idle={idle} label={unsure} value={w ? String(w.recent.hedges) : fmt1(b?.hedgesPer100)} over={over('hedge-streak')} />
        <Counter idle={idle} label={like} value={w ? String(w.recent.likes) : fmt1(b?.likesPer100)} over={over('like-streak')} />
      </View>
      {debug && w ? <Text style={styles.debugDark} numberOfLines={1}>{`fillers ${w.recent.fillers} · vague ${w.recent.vague} · restarts ${w.recent.restarts} · turn ${fmtMs(w.monologue.currentMs)} (max ${fmtMs(w.monologue.longestMs)}) · ${w.pauses.count} pauses · others ${w.others.lines} lines`}</Text> : null}
      <View style={{ flex: 1 }} />
      {nudge ? (
        <View style={styles.nudge} testID="nudge-card">
          <Text style={styles.nudgeTitle} numberOfLines={1}>{nudge.wrist.status === 'failed' ? `Nudge didn’t reach your wrist · ${RULE_LABEL[nudge.rule]}` : `Wrist nudge · ${RULE_LABEL[nudge.rule]}`}</Text>
          <Text style={styles.nudgeText} numberOfLines={1}>{curly(nudge.text.replace(/^\[[^\]]*\]\s*/, ''))}</Text>
          {nudge.wrist.status !== 'failed' ? <Text style={styles.nudgeWhen}>{`Buzzed ${fmtMs(nudge.latencyMs.total)} after you said it${nudge.replay ? ' (replay)' : ''}`}</Text> : null}
          {debug ? <HopTimeline nudge={nudge} width={700} /> : null}
        </View>
      ) : idle && footer.headline ? (
        <View style={styles.last} testID="last-conversation">
          <View style={styles.lastHead}>
            <Text style={styles.lastKicker}>Last conversation</Text>
            {/* Down from the tabs, then OK, changes where it happened */}
            <SettingChip tag={last?.setting} tone="dark" focusId="last-setting" onCycle={onCycleSetting} testID="last-setting" />
          </View>
          <Text style={styles.lastText} numberOfLines={2}>{curly(footer.headline)}</Text>
        </View>
      ) : idle ? (
        <Text style={styles.listenHint} numberOfLines={2}>{hint ?? 'Your numbers light up when you talk. Other voices are never shown.'}</Text>
      ) : null}
      {debug && skip ? <Text style={styles.debugDark} numberOfLines={1}>{`Held back: ${RULE_LABEL[skip.rule]} (${SKIP_LABEL[skip.reason]})${skip.retryAfterMs ? `, again in ${fmtMs(skip.retryAfterMs)}` : ''}`}</Text> : null}
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
  bandWait: { backgroundColor: 'rgba(187,174,247,0.35)' },
  bandPass: { backgroundColor: C.lime },
  bandFail: { backgroundColor: C.coral },
  bandHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  beeTag: { alignSelf: 'flex-start', backgroundColor: C.lavender, borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6, marginBottom: SP.s },
  beeTagText: { color: C.lavenderInk, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  listenRow: { flexDirection: 'row', alignItems: 'center', marginTop: SP.l },
  listenDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.lavender, marginRight: SP.s },
  listenTitle: { color: C.dim, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  listenHint: { color: C.faint, fontSize: T.body, lineHeight: 42, maxWidth: 640, fontFamily: F.family },
  usual: { color: C.faint },
  last: { borderTopWidth: 2, borderColor: C.line, paddingTop: SP.l },
  lastHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastKicker: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  lastText: { color: C.text, fontSize: T.body, lineHeight: 42, fontWeight: '600', marginTop: SP.xs, fontFamily: F.family },
  status: { flexShrink: 1, fontSize: 56, lineHeight: 66, fontWeight: '700', letterSpacing: -1, fontFamily: F.family },
  statusBig: { fontSize: 104, lineHeight: 116, letterSpacing: -3 },
  support: { color: C.inkDim, fontSize: T.body, lineHeight: 40, marginTop: SP.s, fontFamily: F.family },
  supportSmall: { fontSize: T.small, lineHeight: 38 },
  cta: { alignSelf: 'flex-start', backgroundColor: C.ink, borderRadius: R.pill, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginBottom: SP.l },
  ctaInBand: { marginTop: SP.l, marginBottom: 0 },
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
  mode: { flexDirection: 'row', alignItems: 'center' },
  modeDot: { width: 14, height: 14, borderRadius: 7, marginRight: SP.s },
  modeText: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  stats: { flexDirection: 'row', marginTop: SP.m },
  stat: { flex: 1 },
  // no negative letter spacing, margin or padding on light numerals: on Vega each drew a sliver beside the first glyph
  statBig: { color: C.text, fontSize: T.big, lineHeight: 132, fontWeight: '700', fontFamily: F.family },
  statLabel: { color: C.dim, fontSize: T.body, fontFamily: F.family },
  sub: { color: C.faint, fontSize: T.label, marginTop: SP.xl, fontFamily: F.family },
  counters: { flexDirection: 'row', marginTop: SP.xs },
  counter: { flex: 1 },
  counterValue: { color: C.text, fontSize: 80, lineHeight: 92, fontWeight: '700', fontFamily: F.family },
  nudge: { backgroundColor: C.coralBg, borderRadius: R.m, paddingHorizontal: SP.l, paddingVertical: SP.m },
  nudgeTitle: { color: C.coral, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  nudgeText: { color: C.text, fontSize: T.small, marginTop: 6, fontFamily: F.family },
  nudgeWhen: { color: C.dim, fontSize: T.label, marginTop: 6, fontFamily: F.family },
});
