import { StyleSheet, Text, View } from 'react-native';
import type { FirstSignal } from '../contract';
import { FIRST_SIGNAL_CAVEAT, firstSignalLine } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

/**
 * The first signal under Progress's cards: per practised habit, the conversation before its first
 * practice against the next one after it, on one quiet strip. A number always comes with its caveat:
 * one conversation is a glance, the pre-registered before/after above is the result. Siblings, never
 * nested Text (Vega tracking).
 */
export function FirstSignalLines({ signals }: { signals: FirstSignal[] | undefined }) {
  const line = firstSignalLine(signals);
  if (!line) return null;
  return (
    <View style={styles.strip} testID="first-signal">
      <View style={styles.tag}>
        <Text style={styles.tagText}>First signal</Text>
      </View>
      <Text style={[styles.text, !line.measured && styles.wait]} numberOfLines={1}>{line.text}</Text>
      <View style={{ flex: 1 }} />
      {line.measured ? <Text style={styles.caveat} numberOfLines={1}>{FIRST_SIGNAL_CAVEAT}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', marginTop: SP.m, backgroundColor: C.surface, borderRadius: R.pill, paddingLeft: SP.xs, paddingRight: SP.xl, paddingVertical: SP.xs },
  tag: { backgroundColor: C.surface2, borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.xs, marginRight: SP.l },
  tagText: { color: C.text, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  text: { flexShrink: 1, color: C.text, fontSize: T.small, fontWeight: '600', fontFamily: F.family },
  wait: { color: C.dim, fontWeight: '400' },
  caveat: { color: C.faint, fontSize: T.label, marginLeft: SP.l, fontFamily: F.family },
});
