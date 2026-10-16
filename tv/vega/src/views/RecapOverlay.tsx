import { Animated, StyleSheet, Text, View } from 'react-native';
import { Chip } from '../components/Chip';
import type { Recap } from '../contract';
import { fmt2, fmtInt, fmtMs, fmtPct, verdictTone } from '../mirror/format';
import { useEnter } from '../motion';
import { C, F, R, SP, T } from '../theme';

/**
 * The recap after a conversation, over whatever screen is showing. The moment is the wearer's own
 * words as the hub served them (at most 12), with a plain rephrase. OK or Back closes it; it also
 * closes by itself after 30 s.
 */
export function RecapOverlay({ recap }: { recap: Recap }) {
  const enter = useEnter(recap.id, 40, 360);
  const m = recap.metrics;
  return (
    <View style={styles.scrim} testID="recap-overlay">
      <Animated.View style={[styles.card, enter]}>
        <View style={styles.rowBetween}>
          <Text style={styles.kicker}>{`AFTER YOUR CONVERSATION · ${fmtMs(recap.durationMs)}`}</Text>
          <View style={styles.chips}>
            {recap.replay ? <Chip text="BEE REPLAY (DEMO)" tone="bee" /> : <Chip text="FROM BEE" tone="bee" />}
            <Chip text={recap.delivery.wrist === 'scheduled' ? 'SENT TO YOUR WRIST' : recap.delivery.wrist === 'replay' ? 'WRIST (REPLAY)' : recap.delivery.wrist === 'failed' ? 'WRIST FAILED' : 'WRIST OFF'} tone={recap.delivery.wrist === 'failed' ? 'bad' : 'neutral'} />
          </View>
        </View>
        <Text style={styles.headline} numberOfLines={2}>{recap.headline}</Text>
        <View style={styles.metrics}>
          <Metric big={fmtInt(m.wearerWords)} label="your words" />
          <Metric big={fmtInt(m.wpm)} label={`wpm (usual ${fmtInt(m.baselineWpm)})`} />
          <Metric big={fmtPct(m.talkShare)} label="talk share" />
          <Metric big={fmtMs(m.longestMonologueMs)} label="longest turn" />
          <Metric big={String(recap.nudges.sent)} label={`nudge${recap.nudges.sent === 1 ? '' : 's'} sent · ${recap.nudges.skipped} held`} />
        </View>
        <View style={styles.habits}>
          {m.habits.map((h) => (
            <View key={h.key} style={styles.habit}>
              <Text style={styles.habitLabel} numberOfLines={1}>{h.label}</Text>
              <Text style={styles.habitNum}>{`${fmt2(h.per100)} / 100`}</Text>
              <Text style={styles.habitBase}>{h.baselinePer100 === null ? 'no baseline' : `usual ${fmt2(h.baselinePer100)}`}</Text>
              <Chip text={h.verdict.toUpperCase()} tone={verdictTone(h.verdict)} />
            </View>
          ))}
        </View>
        {recap.moment ? (
          <View style={styles.moment}>
            <Text style={styles.momentKicker}>YOU SAID</Text>
            <Text style={styles.said} numberOfLines={2}>{`"${recap.moment.text}"`}</Text>
            <Text style={styles.momentKicker}>TRY</Text>
            <Text style={styles.rephrase} numberOfLines={2}>{`"${recap.moment.rephrase}"`}</Text>
          </View>
        ) : null}
        <Text style={styles.foot}>{`${recap.phrasing === 'llm' ? 'Phrased by a model, checked by rules' : 'Template phrasing'} · OK or Back to close`}</Text>
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
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(5,9,24,0.82)', alignItems: 'center', justifyContent: 'center' },
  card: { width: 1500, backgroundColor: C.surface, borderRadius: R.l, borderWidth: 3, borderColor: C.lavender, padding: SP.xl },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', gap: SP.s },
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  headline: { color: C.text, fontSize: T.h2, fontWeight: '800', lineHeight: 56, marginTop: SP.m, fontFamily: F.family },
  metrics: { flexDirection: 'row', marginTop: SP.l },
  metric: { flex: 1, paddingRight: SP.m },
  metricBig: { color: C.text, fontSize: T.h2, fontWeight: '800', fontFamily: F.family },
  metricLabel: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  habits: { marginTop: SP.l },
  habit: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderColor: C.rule },
  habitLabel: { width: 640, color: C.text, fontSize: T.small, fontFamily: F.family },
  habitNum: { width: 200, color: C.text, fontSize: T.small, fontWeight: '800', fontFamily: F.family },
  habitBase: { width: 220, color: C.dim, fontSize: T.label, fontFamily: F.family },
  moment: { backgroundColor: C.surface2, borderRadius: R.m, padding: SP.m, marginTop: SP.l },
  momentKicker: { color: C.faint, fontSize: 22, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  said: { color: C.dim, fontSize: T.body, marginBottom: SP.s, fontFamily: F.family },
  rephrase: { color: C.mint, fontSize: T.body, fontWeight: '800', fontFamily: F.family },
  foot: { color: C.faint, fontSize: T.label, marginTop: SP.m, fontFamily: F.family },
});
