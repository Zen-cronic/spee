import { Animated, StyleSheet, Text, View } from 'react-native';
import { HopTimeline } from '../components/HopTimeline';
import type { LiveMode, LiveWindow, Nudge, NudgeSkipped } from '../contract';
import { useDebug } from '../debug';
import { curly, fmtDay, fmtInt, fmtMs, fmtPct, overruleText, plainReason, RULE_LABEL, sessionTally, SKIP_LABEL } from '../mirror/format';
import { drillSteps, type DrillState, type LiveSlice, type StepState } from '../mirror/reducer';
import { useEnter, useLoop } from '../motion';
import { C, F, R, SP, T } from '../theme';

/**
 * Live: the drill on the left (the sentence to say, one status sentence, and a three-step tracker:
 * you said it, checked by Bee, graded), the current conversation on the right (pace, talk share,
 * the two drilled habits over the last 2 minutes, and the last wrist nudge). Developer detail
 * (speaker score, hops in ms, held-back nudges) shows only in debug.
 */
export function LiveView({ drill, live, partial, focus }: { drill: DrillState; live: LiveSlice; partial: string | null; focus: 'drill' | 'live' }) {
  return (
    <View style={styles.wrap} testID="view-live">
      <View style={[styles.drill, focus === 'live' && !drill.card && styles.drillQuiet, !!drill.card && !live.window && styles.drillWide]}>
        <DrillPanel d={drill} partial={partial} />
      </View>
      <View style={styles.convo}>
        <ConversationPanel live={live} />
      </View>
    </View>
  );
}

function Dot({ state, bee }: { state: StepState; bee?: boolean }) {
  const pulse = useLoop(state === 'now', 600);
  const fill = state === 'todo' ? 'transparent' : state === 'now' ? C.lavender : state === 'bad' ? C.coral : state === 'pass' ? C.lime : bee ? C.lavender : C.ink;
  const border = state === 'todo' ? C.inkFaint : state === 'pass' ? C.ink : fill;
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
  if (!card) {
    return (
      <View style={styles.fill}>
        <Text style={styles.kicker}>Drill</Text>
        <Text style={styles.sentence}>No drill running.</Text>
        <View style={{ flex: 1 }} />
        <View style={styles.cta}>
          <Text style={styles.ctaText}>Say “Alexa, quiz me”</Text>
        </View>
        {d.summary ? <Text style={styles.support}>{sessionTally('Last session', d.summary)}</Text> : null}
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
    support = g.pass ? `Checked by Bee.${g.dueAfter ? ` Next review ${fmtDay(g.dueAfter)}.` : ''}` : `${plainReason(g.failure) ?? 'Close'}. Say it again.`;
    band = g.pass ? styles.bandPass : styles.bandFail;
    ink = g.pass ? C.limeInk : C.coralInk;
    if (overrules) support = curly(overruleText(pv?.source, g.pass, g.beeText));
  } else if (st === 'unverified') {
    status = 'Bee didn’t catch that one.';
    support = 'It doesn’t count. Say it again.';
  } else if (st === 'verified') {
    status = 'Bee heard you. Grading…';
    band = styles.bandWait;
  } else if (st === 'provisional' || st === 'checking') {
    status = 'Bee is checking your line…';
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
      <Animated.View style={[styles.band, band, enter]} testID={overrules ? 'bee-overrules' : 'drill-verdict'}>
        <View style={styles.bandHead}>
          <Text style={[styles.status, { color: ink }]} numberOfLines={2}>{status}</Text>
          {overrules ? (
            <View style={styles.beeTag}>
              <Text style={styles.beeTagText}>Bee overrules</Text>
            </View>
          ) : null}
        </View>
        {support ? <Text style={[styles.support, overrules && styles.supportSmall, { color: ink }]} numberOfLines={overrules ? 4 : 2}>{support}</Text> : null}
      </Animated.View>
      <Tracker
        steps={[
          { label: 'You said it', state: heard },
          { label: 'Checked by Bee', state: checked, bee: true },
          { label: 'Graded', state: graded },
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

function Listening() {
  const pulse = useLoop(true, 900);
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

function Counter({ label, value, over }: { label: string; value: string; over: boolean }) {
  return (
    <View style={styles.counter}>
      <Text style={[styles.counterValue, over && { color: C.coral }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ConversationPanel({ live }: { live: LiveSlice }) {
  const debug = useDebug();
  const w: LiveWindow | null = live.window;
  const over = (r: string) => !!w?.rules.find((x) => x.rule === r)?.over;
  const nudge: Nudge | undefined = live.nudges[0];
  const skip: NudgeSkipped | undefined = live.skips[0];
  return (
    <View style={styles.fill}>
      <View style={styles.rowBetween}>
        <Text style={styles.convoTitle}>Conversation</Text>
        <Mode mode={live.mode} />
      </View>
      {!w ? (
        <View style={styles.listening}>
          <Listening />
          <Text style={styles.listenTitle}>{live.ended ? 'Conversation ended.' : 'Bee is listening.'}</Text>
          <Text style={styles.listenHint}>{live.ended ? `${live.ended.wearerWords} of your words. ${live.ended.recap === 'pending' ? 'Recap on its way.' : 'Too short for a recap.'}` : 'Your pace and habits show here when you talk. Other voices are never shown.'}</Text>
        </View>
      ) : (
      <View>
        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statBig}>{w ? fmtInt(w.wearer.wpm) : '–'}</Text>
            <Text style={styles.statLabel}>words a minute</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statBig}>{w ? fmtPct(w.talkShare) : '–'}</Text>
            <Text style={styles.statLabel}>you talked</Text>
          </View>
        </View>
        <Text style={styles.sub}>Last 2 minutes</Text>
        <View style={styles.counters}>
          <Counter label="hedges" value={w ? String(w.recent.hedges) : '–'} over={over('hedge-streak')} />
          <Counter label="“like”" value={w ? String(w.recent.likes) : '–'} over={over('like-streak')} />
        </View>
      </View>
      )}
      {debug && w ? <Text style={styles.debugDark} numberOfLines={1}>{`fillers ${w.recent.fillers} · vague ${w.recent.vague} · restarts ${w.recent.restarts} · turn ${fmtMs(w.monologue.currentMs)} (max ${fmtMs(w.monologue.longestMs)}) · ${w.pauses.count} pauses · others ${w.others.lines} lines`}</Text> : null}
      {w ? <View style={{ flex: 1 }} /> : null}
      {nudge ? (
        <View style={styles.nudge} testID="nudge-card">
          <Text style={styles.nudgeTitle} numberOfLines={1}>{nudge.wrist.status === 'failed' ? `Nudge not delivered: ${RULE_LABEL[nudge.rule]}` : `Wrist nudge: ${RULE_LABEL[nudge.rule]}`}</Text>
          <Text style={styles.nudgeText} numberOfLines={1}>{curly(nudge.text.replace(/^\[[^\]]*\]\s*/, ''))}</Text>
          {nudge.wrist.status !== 'failed' ? <Text style={styles.nudgeWhen}>{`Buzzed ${fmtMs(nudge.latencyMs.total)} after you said it${nudge.replay ? ' (replay)' : ''}`}</Text> : null}
          {debug ? <HopTimeline nudge={nudge} width={700} /> : null}
        </View>
      ) : null}
      {debug && skip ? <Text style={styles.debugDark} numberOfLines={1}>{`Held back: ${RULE_LABEL[skip.rule]} (${SKIP_LABEL[skip.reason]})${skip.retryAfterMs ? `, again in ${fmtMs(skip.retryAfterMs)}` : ''}`}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  fill: { flex: 1 },
  drill: { flex: 1.15, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl, marginRight: SP.l },
  drillQuiet: { flex: 0.8 },
  drillWide: { flex: 1.6 },
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
  beeTag: { backgroundColor: C.lavender, borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6 },
  beeTagText: { color: C.lavenderInk, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  listening: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SP.xl },
  listenDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.lavender, marginBottom: SP.l },
  listenTitle: { color: C.text, fontSize: T.h2, fontWeight: '700', textAlign: 'center', fontFamily: F.family },
  listenHint: { color: C.dim, fontSize: T.body, lineHeight: 42, marginTop: SP.s, textAlign: 'center', maxWidth: 620, fontFamily: F.family },
  status: { flexShrink: 1, fontSize: 56, lineHeight: 66, fontWeight: '700', letterSpacing: -1, fontFamily: F.family },
  support: { color: C.inkDim, fontSize: T.body, lineHeight: 40, marginTop: SP.s, fontFamily: F.family },
  supportSmall: { fontSize: T.small, lineHeight: 38 },
  cta: { alignSelf: 'flex-start', backgroundColor: C.ink, borderRadius: R.pill, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginBottom: SP.l },
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
  stats: { flexDirection: 'row', marginTop: SP.xl },
  stat: { flex: 1 },
  statBig: { color: C.text, fontSize: T.big, lineHeight: 132, fontWeight: '700', letterSpacing: -3, paddingHorizontal: 12, marginLeft: -12, fontFamily: F.family },
  statLabel: { color: C.dim, fontSize: T.body, fontFamily: F.family },
  sub: { color: C.faint, fontSize: T.label, marginTop: SP.xl, fontFamily: F.family },
  counters: { flexDirection: 'row', marginTop: SP.xs },
  counter: { flex: 1 },
  counterValue: { color: C.text, fontSize: 80, lineHeight: 92, fontWeight: '700', paddingHorizontal: 10, marginLeft: -10, fontFamily: F.family },
  nudge: { backgroundColor: C.coralBg, borderRadius: R.m, paddingHorizontal: SP.l, paddingVertical: SP.m },
  nudgeTitle: { color: C.coral, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  nudgeText: { color: C.text, fontSize: T.small, marginTop: 6, fontFamily: F.family },
  nudgeWhen: { color: C.dim, fontSize: T.label, marginTop: 6, fontFamily: F.family },
});
