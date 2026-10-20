import { StyleSheet, Text, View } from 'react-native';
import type { SettingTag } from '../contract';
import { FocusCard } from '../focus';
import { settingName } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

/**
 * Where a conversation happened, as a small pill: "Meeting", "Work talk" or "Casual" (the hub's
 * tag, or the wearer's own choice). `tone` is the surface it sits on. With `focusId` it is a remote
 * focus target (OK changes it); without, it only shows, and the screen says which key changes it.
 * Siblings, never nested Text (Vega tracking).
 */
export function SettingChip({ tag, tone, focusId, onCycle, testID }: { tag: SettingTag | null | undefined; tone: 'paper' | 'dark'; focusId?: string; onCycle?: () => void; testID?: string }) {
  const name = settingName(tag);
  if (!name) return null;
  const paper = tone === 'paper';
  const pill = (
    <View style={[styles.pill, paper ? styles.pillPaper : styles.pillDark]} testID={testID}>
      <Text style={[styles.text, { color: paper ? C.ink : C.text }]} numberOfLines={1}>{name}</Text>
      {tag?.source === 'you' ? <Text style={[styles.mark, { color: paper ? C.inkDim : C.dim }]}>{'· set by you'}</Text> : null}
    </View>
  );
  if (!focusId || !onCycle) return pill;
  return (
    <FocusCard id={focusId} row={1} col={0} onPress={onCycle} label={`Setting: ${name}. Press OK to change it.`} style={styles.focus}>
      {pill}
    </FocusCard>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.m, paddingVertical: 6 },
  pillPaper: { backgroundColor: 'rgba(0,0,0,0.08)' },
  pillDark: { backgroundColor: C.surface2 },
  text: { fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  mark: { fontSize: T.label, marginLeft: SP.xs, fontFamily: F.family },
  focus: { alignSelf: 'flex-start', borderRadius: R.pill, borderWidth: 5, borderColor: 'transparent' },
});
