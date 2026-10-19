import { Animated, StyleSheet, Text, View } from 'react-native';
import type { Recap } from '../contract';
import { useDebug } from '../debug';
import { fmt1, fmtInt, fmtMs, fmtPct, shortHabit } from '../mirror/format';
import { useEnter } from '../motion';
import { C, F, R, SP, T } from '../theme';

const VERDICT: Record<string, { word: string; bg: string; ink: string }> = {
  better: { word: 'Better', bg: C.lime, ink: C.limeInk },
  worse: { word: 'Worse', bg: C.coral, ink: C.coralInk },
};

/**
 * The recap after a conversation, over whatever screen is showing: one headline, three numbers,
 * each habit against your usual rate, and the wearer's own moment (as the hub served it, at most 12
 * words) with a plain rephrase. OK or Back closes it; it also closes by itself after 30 s.
 */
export function RecapOverlay({ recap }: { recap: Recap }) {
  const debug = useDebug();
  const enter = useEnter(recap.id, 40, 360);
  const m = recap.metrics;
  const wrist = recap.delivery.wrist === 'scheduled' ? 'Also sent to your wrist.' : recap.delivery.wrist === 'replay' ? 'Sent to your wrist (replay).' : null;
  return (
    <View style={styles.scrim} testID="recap-overlay">
      <Animated.View style={[styles.card, enter]}>
        <Text style={styles.kicker}>{`After your conversation · ${fmtMs(recap.durationMs)} · from Bee`}</Text>
        <Text style={styles.headline} numberOfLines={2}>{recap.headline}</Text>
        <View style={styles.body}>
          <View style={styles.left}>
            <View style={styles.metrics}>
              <Metric big={fmtInt(m.wpm)} label="words a minute" />
              <Metric big={fmtPct(m.talkShare)} label="you talked" />
            </View>
            {m.habits.map((h) => {
              const v = VERDICT[h.verdict];
              return (
                <View key={h.key} style={styles.habit}>
                  <Text style={styles.habitLabel} numberOfLines={1}>{shortHabit(h.label)}</Text>
                  <Text style={styles.habitNum}>{h.baselinePer100 === null ? `${fmt1(h.per100)} per 100 words` : `${fmt1(h.per100)}, usually ${fmt1(h.baselinePer100)}`}</Text>
                  <View style={[styles.pill, { backgroundColor: v?.bg ?? 'rgba(0,0,0,0.08)' }]}>
                    <Text style={[styles.pillText, { color: v?.ink ?? C.inkDim }]}>{v?.word ?? (h.verdict === 'no-baseline' ? 'New' : 'As usual')}</Text>
                  </View>
                </View>
              );
            })}
          </View>
          {recap.moment ? (
            <View style={styles.moment}>
              <Text style={styles.momentKicker}>You said</Text>
              <Text style={styles.said} numberOfLines={3}>{`“${recap.moment.text}”`}</Text>
              <Text style={[styles.momentKicker, { marginTop: SP.l }]}>Try</Text>
              <Text style={styles.rephrase} numberOfLines={3}>{`“${recap.moment.rephrase}”`}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.foot}>{[wrist, 'OK or Back to close'].filter(Boolean).join('   ·   ')}</Text>
        {debug ? <Text style={styles.debug}>{`${m.wearerWords} words · longest turn ${fmtMs(m.longestMonologueMs)} · nudges ${recap.nudges.sent} sent, ${recap.nudges.skipped} held · phrasing ${recap.phrasing} · wrist ${recap.delivery.wrist}${recap.replay ? ' · replay' : ''}`}</Text> : null}
      </Animated.View>
    </View>
  );
}

function Metric({ big, label }: { big: string; label: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricBig}>{big}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10,10,9,0.86)', alignItems: 'center', justifyContent: 'center' },
  card: { width: 1560, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl },
  kicker: { color: C.inkDim, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  headline: { color: C.ink, fontSize: T.h1, lineHeight: 76, fontWeight: '700', letterSpacing: -1, marginTop: SP.s, fontFamily: F.family },
  body: { flexDirection: 'row', marginTop: SP.xl },
  left: { flex: 1, marginRight: SP.xxl },
  metrics: { flexDirection: 'row', marginBottom: SP.l },
  metric: { flex: 1 },
  metricBig: { color: C.ink, fontSize: T.big, lineHeight: 132, fontWeight: '700', letterSpacing: -3, paddingHorizontal: 12, marginLeft: -12, fontFamily: F.family },
  metricLabel: { color: C.inkDim, fontSize: T.body, fontFamily: F.family },
  habit: { flexDirection: 'row', alignItems: 'center', paddingVertical: SP.s, borderTopWidth: 2, borderColor: 'rgba(0,0,0,0.07)' },
  habitLabel: { flex: 1, color: C.ink, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  habitNum: { color: C.inkDim, fontSize: T.body, marginRight: SP.l, fontFamily: F.family },
  pill: { borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6, minWidth: 120, alignItems: 'center' },
  pillText: { fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  moment: { width: 600, backgroundColor: C.ink, borderRadius: R.m, padding: SP.xl },
  momentKicker: { color: C.dim, fontSize: T.label, fontWeight: '600', fontFamily: F.family },
  said: { color: C.dim, fontSize: T.body, lineHeight: 42, marginTop: 6, fontFamily: F.family },
  rephrase: { color: C.lime, fontSize: T.title, lineHeight: 50, fontWeight: '700', marginTop: 6, fontFamily: F.family },
  foot: { color: C.inkFaint, fontSize: T.label, marginTop: SP.xl, fontFamily: F.family },
  debug: { color: C.inkFaint, fontSize: 20, marginTop: SP.xs, fontFamily: F.mono },
});
