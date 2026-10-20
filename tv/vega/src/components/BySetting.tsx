import { StyleSheet, Text, View } from 'react-native';
import { bySettingLine } from '../mirror/format';
import { C, F, SP, T } from '../theme';

const LH = 30; // the label size's own line box (as the captions line)

/**
 * The secondary, per-setting view right under Progress's result: each practised habit's rate
 * before and after, within work talk, casual chats and meetings, on one quiet line the hub words
 * (it says "too little speech" instead of a number). Hidden when no setting has enough speech; it
 * never replaces the pre-registered result above it. Siblings, never nested Text (Vega tracking).
 */
export function BySettingLine({ line }: { line: string | null | undefined }) {
  const text = bySettingLine(line);
  if (!text) return null;
  return (
    <View style={styles.row} testID="by-setting">
      <Text style={styles.lead}>By setting</Text>
      <Text style={styles.text} numberOfLines={1}>{text}</Text>
      <Text style={styles.mark} numberOfLines={1}>a closer look, not the test</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', marginTop: 4 },
  lead: { color: C.dim, fontSize: T.label, lineHeight: LH, fontWeight: '700', marginRight: SP.l, fontFamily: F.family },
  text: { flexShrink: 1, color: C.text, fontSize: T.label, lineHeight: LH, fontFamily: F.family },
  mark: { color: C.faint, fontSize: T.label, lineHeight: LH, marginLeft: SP.l, fontFamily: F.family },
});
