import { StyleSheet, Text, View } from 'react-native';
import type { Tone } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

const INK: Record<Tone, { fg: string; bg: string; border: string }> = {
  good: { fg: C.mint, bg: C.mintBg, border: C.mint },
  bad: { fg: C.coral, bg: C.coralBg, border: C.coral },
  neutral: { fg: C.dim, bg: C.surface2, border: C.line },
  wait: { fg: C.amber, bg: C.amberBg, border: C.amber },
  bee: { fg: C.lavender, bg: C.lavenderBg, border: C.lavender },
};

/** A verdict or status chip: a coloured outline and text (never colour alone: the word is the signal). */
export function Chip({ text, tone, big, testID }: { text: string; tone: Tone; big?: boolean; testID?: string }) {
  const k = INK[tone];
  return (
    <View testID={testID} style={[styles.chip, big && styles.big, { backgroundColor: k.bg, borderColor: k.border }]}>
      <Text style={[styles.text, big && styles.bigText, { color: k.fg }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', borderWidth: 2, borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 4 },
  big: { paddingHorizontal: SP.l, paddingVertical: 8 },
  text: { fontSize: T.label, fontWeight: '800', letterSpacing: 1, fontFamily: F.family },
  bigText: { fontSize: T.small },
});
