import { StyleSheet, Text } from 'react-native';
import type { FirstSignal } from '../contract';
import { FIRST_SIGNAL_CAVEAT, firstSignalLine } from '../mirror/format';
import { C, F, SP, T } from '../theme';

/**
 * The first signal under Progress's cards: per drilled habit, the conversation before its first
 * drill against the next one after it, on one small line. Plain, and a number always comes with
 * its caveat: one conversation is a glance, the pre-registered before/after above is the result.
 */
export function FirstSignalLines({ signals }: { signals: FirstSignal[] | undefined }) {
  const line = firstSignalLine(signals);
  if (!line) return null;
  return (
    <Text style={styles.line} numberOfLines={1} testID="first-signal">
      <Text style={styles.kicker}>First signal</Text>
      <Text style={line.measured ? styles.text : styles.wait}>{`  ·  ${line.text}`}</Text>
      {line.measured ? <Text style={styles.caveat}>{`  ·  ${FIRST_SIGNAL_CAVEAT}`}</Text> : null}
    </Text>
  );
}

const styles = StyleSheet.create({
  line: { marginTop: SP.m, fontSize: T.small, lineHeight: 36, fontFamily: F.family },
  kicker: { color: C.text, fontWeight: '700', fontFamily: F.family },
  text: { color: C.text, fontFamily: F.family },
  wait: { color: C.dim, fontFamily: F.family },
  caveat: { color: C.dim, fontFamily: F.family },
});
