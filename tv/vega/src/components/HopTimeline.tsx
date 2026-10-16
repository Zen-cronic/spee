import { StyleSheet, Text, View } from 'react-native';
import { NUDGE_HOP_ORDER, type Nudge, type NudgeHops } from '../contract';
import { fmtMs, HOP_LABEL } from '../mirror/format';
import { C, F, SP, T } from '../theme';

const HOP_COLOR: Record<keyof NudgeHops, string> = { spokenAt: C.text, beeAt: C.lavender, detectedAt: C.mint, todoAt: C.amber, alarmAt: C.coral };

/**
 * One nudge's latency hops, from the end of the wearer's line to the Watch buzz: spoken, Bee
 * tagged the wearer, rule fired, wrist to-do created, alarm. The dots sit on a true time axis;
 * the labels sit in fixed columns underneath (close hops never overlap). A failed wrist hop is
 * drawn hollow.
 */
export function HopTimeline({ nudge, width }: { nudge: Nudge; width: number }) {
  const h = nudge.hops;
  const t0 = h.spokenAt;
  const last = Math.max(...NUDGE_HOP_ORDER.map((k) => h[k] ?? t0));
  const span = Math.max(1, last - t0);
  const inner = width - 24;
  const x = (at: number) => ((at - t0) / span) * inner + 12;
  const col = width / NUDGE_HOP_ORDER.length;
  return (
    <View testID="hop-timeline" style={{ width }}>
      <View style={[styles.track, { width }]}>
        <View style={[styles.axis, { width: inner }]} />
        {NUDGE_HOP_ORDER.map((k) => {
          const at = h[k];
          return <View key={k} style={[styles.dot, { left: x(at ?? last) - 11 }, at === null ? styles.hollow : { backgroundColor: HOP_COLOR[k] }]} />;
        })}
      </View>
      <View style={styles.cols}>
        {NUDGE_HOP_ORDER.map((k) => {
          const at = h[k];
          return (
            <View key={k} style={[styles.col, { width: col }]}>
              <View style={[styles.key, { backgroundColor: at === null ? C.faint : HOP_COLOR[k] }]} />
              <View>
                <Text style={styles.ms}>{at === null ? 'failed' : at === t0 ? '0 s' : `+${fmtMs(at - t0)}`}</Text>
                <Text style={styles.label} numberOfLines={1}>{HOP_LABEL[k]}</Text>
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.totals}>
        <Text style={styles.total}>{`Bee ${fmtMs(nudge.latencyMs.bee)}`}</Text>
        <Text style={styles.total}>{`rule ${fmtMs(nudge.latencyMs.detect)}`}</Text>
        <Text style={styles.total}>{`to-do ${fmtMs(nudge.latencyMs.todo)}`}</Text>
        <Text style={[styles.total, styles.totalStrong]}>{`speech to buzz ${fmtMs(nudge.latencyMs.total)}`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 30 },
  axis: { position: 'absolute', left: 12, top: 13, height: 4, backgroundColor: C.line, borderRadius: 2 },
  dot: { position: 'absolute', top: 4, width: 22, height: 22, borderRadius: 11 },
  hollow: { borderWidth: 3, borderColor: C.faint, backgroundColor: C.bg },
  cols: { flexDirection: 'row', marginTop: SP.xs },
  col: { flexDirection: 'row', alignItems: 'flex-start' },
  key: { width: 6, height: 44, borderRadius: 3, marginRight: SP.xs, marginTop: 4 },
  ms: { color: C.text, fontSize: T.label, fontWeight: '800', fontFamily: F.family },
  label: { color: C.dim, fontSize: 20, fontFamily: F.family },
  totals: { flexDirection: 'row', marginTop: SP.s },
  total: { color: C.dim, fontSize: 22, marginRight: SP.l, fontFamily: F.family },
  totalStrong: { color: C.text, fontWeight: '800' },
});
