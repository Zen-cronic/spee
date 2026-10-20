import { StyleSheet, Text, View } from 'react-native';
import { bySettingLine } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

/**
 * The secondary, per-setting view under Progress's result: each practised habit's rate before and
 * after, within work talk, casual chats and meetings, as one quiet strip the hub words (it says "too
 * little speech" instead of a number). Hidden when no setting has enough speech; it never replaces
 * the pre-registered result above it. Siblings, never nested Text (Vega tracking).
 */
export function BySettingLine({ line }: { line: string | null | undefined }) {
  const text = bySettingLine(line);
  if (!text) return null;
  return (
    <View style={styles.strip} testID="by-setting">
      <View style={styles.tag}>
        <Text style={styles.tagText}>By setting</Text>
      </View>
      <Text style={styles.text} numberOfLines={1}>{text}</Text>
      <View style={{ flex: 1 }} />
      <Text style={styles.caveat} numberOfLines={1}>a closer look, not the test</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', marginTop: SP.s, backgroundColor: C.surface, borderRadius: R.pill, paddingLeft: SP.xs, paddingRight: SP.xl, paddingVertical: SP.xs },
  tag: { backgroundColor: C.surface2, borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.xs, marginRight: SP.l },
  tagText: { color: C.text, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  text: { flexShrink: 1, color: C.dim, fontSize: T.small, fontFamily: F.family },
  caveat: { color: C.faint, fontSize: T.label, marginLeft: SP.l, fontFamily: F.family },
});
