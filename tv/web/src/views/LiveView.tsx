import { Animated, StyleSheet, Text, View } from 'react-native';
import { Chip } from '../components/Chip';
import { HopTimeline } from '../components/HopTimeline';
import type { LiveMode, LiveWindow, Nudge, NudgeSkipped, RuleState } from '../contract';
import { fmtDay, fmtInt, fmtMs, fmtPct, overruleText, RULE_LABEL, sessionTally, SKIP_LABEL } from '../mirror/format';
import type { DrillState, LiveSlice } from '../mirror/reducer';
import { useEnter, useLoop } from '../motion';
import { C, F, R, SP, T } from '../theme';

/**
 * Live: the drill pipeline on the left (preview, checking with Bee, verified by Bee, graded, and
 * "Bee overrules"), the current conversation on the right (rate, monologue, the 2-minute counters
 * against their thresholds, the last nudge's latency hops and the suppressed nudges).
 */
export function LiveView({ drill, live, partial, focus }: { drill: DrillState; live: LiveSlice; partial: string | null; focus: 'drill' | 'live' }) {
  return (
    <View style={styles.wrap} testID="view-live">
      <View style={[styles.col, focus === 'drill' && styles.colFocus]}>
        <DrillPanel d={drill} partial={partial} />
      </View>
      <View style={[styles.col, styles.colRight, focus === 'live' && styles.colFocus]}>
        <ConversationPanel live={live} />
      </View>
    </View>
  );
}

type StepState = 'todo' | 'now' | 'done' | 'bad';

function Step({ n, title, state, detail, bee }: { n: number; title: string; state: StepState; detail?: string | null; bee?: boolean }) {
  const pulse = useLoop(state === 'now', 600);
  const enter = useEnter(`${title}:${state}`, 12, 260);
  const color = state === 'done' ? (bee ? C.lavender : C.mint) : state === 'bad' ? C.coral : state === 'now' ? C.amber : C.faint;
  return (
    <Animated.View style={[styles.step, enter]}>
      <Animated.View style={[styles.stepDot, { borderColor: color, backgroundColor: state === 'todo' ? 'transparent' : color, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }) }]}>
        <Text style={[styles.stepNum, { color: state === 'todo' ? C.faint : C.bg }]}>{String(n)}</Text>
      </Animated.View>
      <View style={styles.stepBody}>
        <Text style={[styles.stepTitle, { color: state === 'todo' ? C.faint : C.text }]}>{title}</Text>
        {detail ? <Text style={styles.stepDetail} numberOfLines={2}>{detail}</Text> : null}
      </View>
    </Animated.View>
  );
}

function DrillPanel({ d, partial }: { d: DrillState; partial: string | null }) {
  const card = d.card;
  if (!card) {
    return (
      <View>
        <Text style={styles.kicker}>DRILL</Text>
        <Text style={styles.idle}>No drill running.</Text>
        <Text style={styles.hint}>{'Say "Alexa, quiz me", or start a drill from the phone. Every attempt is graded from what Bee heard, not from the phone.'}</Text>
        {d.summary ? <Text style={styles.hint}>{sessionTally('Last session', d.summary)}</Text> : null}
      </View>
    );
  }
  const pv = d.provisional;
  const v = d.verified;
  const g = d.graded;
  const st = d.stage;
  const previewState: StepState = pv ? 'done' : st === 'card' ? 'now' : 'todo';
  const checkState: StepState = st === 'provisional' || st === 'checking' ? 'now' : v || g || st === 'unverified' ? (st === 'unverified' ? 'bad' : 'done') : 'todo';
  const verifyState: StepState = st === 'unverified' ? 'bad' : v?.status === 'verified' ? 'done' : 'todo';
  const gradeState: StepState = g ? (g.pass ? 'done' : 'bad') : st === 'verified' ? 'now' : 'todo';
  return (
    <View>
      <Text style={styles.kicker}>{`DRILL · ${card.habit?.label ?? card.type}`}</Text>
      <Text style={styles.said} numberOfLines={2}>{card.said}</Text>
      <Text style={styles.fix} numberOfLines={2}>{`Say instead: ${card.resay || card.fix}`}</Text>
      {partial && (st === 'card' || st === 'provisional') ? <Text style={styles.partial} numberOfLines={1}>{`hearing: ${partial}`}</Text> : null}
      <View style={styles.steps}>
        <Step n={1} title={pv ? `Preview (${pv.source}): ${pv.pass ? 'pass' : 'fail'}` : 'Waiting for your attempt'} state={pv ? (pv.pass ? 'done' : 'bad') : previewState} detail={pv ? `"${pv.text}"` : null} />
        <Step n={2} title="Checking with Bee" state={checkState} detail={st === 'checking' ? 'stream timed out, asking the Bee CLI' : st === 'provisional' ? 'waiting for Bee to tag your line' : null} />
        <Step n={3} title={st === 'unverified' ? 'Not verified by Bee' : 'Verified by Bee'} state={verifyState} bee detail={v ? (v.status === 'verified' ? `speaker ${v.speakerScore ?? '–'} · ${fmtMs(v.latencyMs)} after you spoke · via ${v.via ?? '–'}${v.replay ? ' · replay' : ''}` : v.reason) : st === 'unverified' ? 'no counted attempt' : null} />
        <Step n={4} title={g ? `Graded from Bee: ${g.pass ? 'PASS' : 'FAIL'}` : 'Graded'} state={gradeState} detail={g ? `${gradeWhy(g.reasons)}${g.boxFrom !== null ? `  ·  box ${g.boxFrom} → ${g.boxTo}${g.dueAfter ? `, next ${fmtDay(g.dueAfter)}` : ''}` : ''}` : null} />
      </View>
      {g?.agreement === 'bee-overrules' ? (
        <View style={styles.overrule} testID="bee-overrules">
          <Chip text="BEE OVERRULES" tone="bee" big />
          <Text style={styles.overruleText} numberOfLines={3}>{overruleText(pv?.source, g.pass, g.beeText)}</Text>
        </View>
      ) : null}
      {d.summary ? <Text style={styles.hint}>{sessionTally('Session over', d.summary)}</Text> : null}
    </View>
  );
}

// The reason worth a glance: the first failed rule, or on a pass the content match (not "8 words heard").
function gradeWhy(reasons: string[]): string {
  const fail = reasons.find((r) => r.startsWith('FAIL'));
  if (fail) return fail;
  const ok = reasons.find((r) => r.startsWith('ok content')) ?? reasons[0] ?? '';
  return ok.replace(/^ok [^:]+: /, '');
}

function ModeChip({ mode }: { mode: LiveMode | null }) {
  if (!mode) return <Chip text="LIVE COACHING: UNKNOWN" tone="neutral" />;
  return <Chip text={mode.enabled ? 'WRIST NUDGES ON' : 'WRIST NUDGES OFF'} tone={mode.enabled ? 'good' : 'neutral'} />;
}

function Counter({ label, value, rule }: { label: string; value: number; rule?: RuleState }) {
  const over = !!rule?.over;
  return (
    <View style={[styles.counter, over && styles.counterOver]}>
      <Text style={[styles.counterValue, over && { color: C.coral }]}>{String(value)}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
      {rule ? <Text style={styles.counterRule}>{`nudge at ${Math.round(rule.threshold * 10) / 10}`}</Text> : null}
    </View>
  );
}

function ConversationPanel({ live }: { live: LiveSlice }) {
  const w: LiveWindow | null = live.window;
  const rule = (r: string) => w?.rules.find((x) => x.rule === r);
  const nudge: Nudge | undefined = live.nudges[0];
  const skip: NudgeSkipped | undefined = live.skips[0];
  return (
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.kicker}>LIVE CONVERSATION · FROM BEE</Text>
        <ModeChip mode={live.mode} />
      </View>
      {!w ? (
        <View>
          <Text style={styles.idle}>{live.ended ? 'Conversation ended.' : 'No conversation in progress.'}</Text>
          <Text style={styles.hint}>{live.ended ? `${live.ended.wearerWords} of your words, ${fmtMs(live.ended.endedAt - live.ended.startedAt)}. ${live.ended.recap === 'pending' ? 'Recap on its way.' : 'Too short for a recap.'}` : 'When Bee hears you talking, your rate and habit counters show here. Other people are counted, never shown.'}</Text>
        </View>
      ) : (
        <View>
          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statBig}>{fmtInt(w.wearer.wpm)}</Text>
              <Text style={styles.statLabel}>words / min</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statBig}>{fmtPct(w.talkShare)}</Text>
              <Text style={styles.statLabel}>your talk share</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statBig, rule('monologue')?.over && { color: C.coral }]}>{fmtMs(w.monologue.currentMs)}</Text>
              <Text style={styles.statLabel}>{`this turn (max ${fmtMs(w.monologue.longestMs)})`}</Text>
            </View>
          </View>
          <Text style={styles.subKicker}>LAST 2 MINUTES</Text>
          <View style={styles.counters}>
            <Counter label="hedges" value={w.recent.hedges} rule={rule('hedge-streak')} />
            <Counter label={'"like"'} value={w.recent.likes} rule={rule('like-streak')} />
            <Counter label="fillers" value={w.recent.fillers} />
            <Counter label="vague" value={w.recent.vague} />
            <Counter label="restarts" value={w.recent.restarts} />
          </View>
          <Text style={styles.hint} numberOfLines={1}>{`${w.wearer.words} of your words · ${w.pauses.count} pauses · others counted only (${w.others.lines} lines)`}</Text>
        </View>
      )}
      {nudge ? (
        <View style={styles.nudge} testID="nudge-card">
          <View style={styles.rowBetween}>
            <Text style={styles.nudgeTitle}>{`Nudge: ${RULE_LABEL[nudge.rule]}`}</Text>
            <Chip text={nudge.wrist.status === 'failed' ? 'WRIST FAILED' : nudge.replay ? 'WRIST (REPLAY)' : 'ON THE WRIST'} tone={nudge.wrist.status === 'failed' ? 'bad' : 'good'} />
          </View>
          <Text style={styles.nudgeText} numberOfLines={1}>{nudge.text}</Text>
          <HopTimeline nudge={nudge} width={740} />
        </View>
      ) : null}
      {skip ? <Text style={styles.skip} numberOfLines={1}>{`Held back: ${RULE_LABEL[skip.rule]} (${SKIP_LABEL[skip.reason]})${skip.retryAfterMs ? `, can nudge again in ${fmtMs(skip.retryAfterMs)}` : ''}`}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  col: { flex: 1, backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.l, paddingVertical: SP.m, borderWidth: 3, borderColor: 'transparent', overflow: 'hidden' },
  colRight: { marginLeft: SP.l },
  colFocus: { borderColor: C.line },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  subKicker: { color: C.faint, fontSize: 22, fontWeight: '800', letterSpacing: 3, marginTop: SP.s, fontFamily: F.family },
  idle: { color: C.text, fontSize: T.h2, fontWeight: '800', marginTop: SP.l, fontFamily: F.family },
  hint: { color: C.dim, fontSize: T.small, lineHeight: 38, marginTop: SP.s, fontFamily: F.family },
  said: { color: C.dim, fontSize: T.body, marginTop: SP.m, textDecorationLine: 'line-through', fontFamily: F.family },
  fix: { color: C.text, fontSize: T.title, fontWeight: '800', marginTop: SP.xs, lineHeight: 48, fontFamily: F.family },
  partial: { color: C.amber, fontSize: T.small, marginTop: SP.s, fontStyle: 'italic', fontFamily: F.family },
  steps: { marginTop: SP.l },
  step: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: SP.m },
  stepDot: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, alignItems: 'center', justifyContent: 'center', marginRight: SP.m },
  stepNum: { fontSize: 22, fontWeight: '900', fontFamily: F.family },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: T.body, fontWeight: '800', fontFamily: F.family },
  stepDetail: { color: C.dim, fontSize: T.label, marginTop: 2, lineHeight: 32, fontFamily: F.family },
  overrule: { backgroundColor: C.lavenderBg, borderRadius: R.m, padding: SP.m, marginTop: SP.s },
  overruleText: { color: C.text, fontSize: T.label, marginTop: SP.s, lineHeight: 32, fontFamily: F.family },
  stats: { flexDirection: 'row', marginTop: SP.s },
  stat: { flex: 1 },
  statBig: { color: C.text, fontSize: 64, fontWeight: '800', paddingHorizontal: 10, marginLeft: -10, fontFamily: F.family },
  statLabel: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  counters: { flexDirection: 'row', marginTop: SP.s },
  counter: { flex: 1, backgroundColor: C.surface2, borderRadius: R.m, paddingVertical: SP.xs, alignItems: 'center', marginRight: SP.s, borderWidth: 2, borderColor: 'transparent' },
  counterOver: { borderColor: C.coral },
  counterValue: { color: C.text, fontSize: T.h1, fontWeight: '800', fontFamily: F.family },
  counterLabel: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  counterRule: { color: C.faint, fontSize: 20, fontFamily: F.family },
  nudge: { backgroundColor: C.coralBg, borderRadius: R.m, paddingHorizontal: SP.m, paddingVertical: SP.s, marginTop: SP.s },
  nudgeTitle: { color: C.coral, fontSize: T.body, fontWeight: '800', fontFamily: F.family },
  nudgeText: { color: C.text, fontSize: T.small, marginTop: 4, marginBottom: SP.s, fontFamily: F.family },
  skip: { color: C.amber, fontSize: T.label, marginTop: SP.s, fontFamily: F.family },
});
