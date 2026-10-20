import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, F, SP, T } from '../theme';

/**
 * One row of Progress's Details panel: a short tag, the line, and its caveat on the right (a
 * number shown here always says what it is not). Siblings, never nested Text (Vega tracking).
 */
export function DetailRow({ tag, text, caveat, children, testID, first }: { tag: string; text?: string | null; caveat?: string | null; children?: ReactNode; testID?: string; first?: boolean }) {
  return (
    <View style={[styles.row, first && styles.first]} testID={testID}>
      <Text style={styles.tag} numberOfLines={1}>{tag}</Text>
      <View style={styles.body}>
        {text ? <Text style={styles.text} numberOfLines={2}>{text}</Text> : null}
        {children}
        {caveat ? <Text style={styles.caveat} numberOfLines={1}>{caveat}</Text> : null}
      </View>
    </View>
  );
}

export const DETAIL = StyleSheet.create({
  text: { color: C.text, fontSize: T.small, lineHeight: 36, fontFamily: F.family },
  dim: { color: C.dim, fontSize: T.small, lineHeight: 36, fontFamily: F.family },
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, borderTopWidth: 1, borderColor: C.rule },
  first: { borderTopWidth: 0 },
  tag: { width: 300, color: C.dim, fontSize: T.small, lineHeight: 36, fontWeight: '700', fontFamily: F.family },
  body: { flex: 1 },
  text: { color: C.text, fontSize: T.small, lineHeight: 36, fontFamily: F.family },
  caveat: { color: C.faint, fontSize: T.label, lineHeight: 30, fontFamily: F.family },
});
