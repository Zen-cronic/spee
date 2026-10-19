import { StyleSheet, Text, View } from 'react-native';
import type { Tone } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

const INK: Record<Tone, { fg: string; bg: string }> = {
  good: { fg: C.limeInk, bg: C.lime },
  bad: { fg: C.coralInk, bg: C.coral },
  neutral: { fg: C.text, bg: C.surface2 },
  wait: { fg: C.dim, bg: C.surface2 },
  bee: { fg: C.lavenderInk, bg: C.lavender },
};

/** A verdict or status pill: a filled shape and a word (never colour alone: the word is the signal). */
export function Chip({ text, tone, big, testID }: { text: string; tone: Tone; big?: boolean; testID?: string }) {
  const k = INK[tone];
  return (
    <View testID={testID} style={[styles.chip, big && styles.big, { backgroundColor: k.bg }]}>
      <Text style={[styles.text, big && styles.bigText, { color: k.fg }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6 },
  big: { paddingHorizontal: SP.l, paddingVertical: SP.s },
  text: { fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  bigText: { fontSize: T.body },
});
