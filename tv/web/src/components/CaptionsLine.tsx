import { StyleSheet, Text, View } from 'react-native';
import type { InstrumentResponse, TransferResponse } from '../contract';
import { captionsLine } from '../mirror/format';
import { C, F, SP, T } from '../theme';

/**
 * Progress's secondary strip: the same before/after with meeting captions included, labelled as not
 * the pre-registered check (which stays Bee only, in the cards above). Hidden without a caption
 * session. The agreement line shows only when the hub's instrument check says captions and Bee
 * agree on the practised habits. Siblings, never nested Text (Vega tracking).
 */
export function CaptionsLine({ all, instrument }: { all: TransferResponse | null; instrument: InstrumentResponse | null }) {
  const line = captionsLine(all, instrument);
  if (!line) return null;
  return (
    <View style={styles.wrap} testID="captions-line">
      <View style={styles.row}>
        <Text style={styles.lead} numberOfLines={1}>Including meeting captions</Text>
        {line.habits.map((h) => (
          <View key={h.habit} style={styles.habit} testID={`captions-${h.habit}`}>
            <Text style={[styles.name, h.role !== 'drilled' && styles.dimName]} numberOfLines={1}>{h.title}</Text>
            <Text style={styles.nums} numberOfLines={1}>{`${h.before} → ${h.after}`}</Text>
            {h.unchecked ? <Text style={styles.mark} numberOfLines={1}>captions not checked</Text> : null}
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Text style={styles.label} numberOfLines={1}>{line.label}</Text>
        <View style={{ flex: 1 }} />
        {line.agree ? <Text style={styles.agree} numberOfLines={1} testID="captions-agree">{line.agree}</Text> : null}
      </View>
    </View>
  );
}

// Two quiet footnote rows, no panel: Progress has no height to spare, and this is the secondary view.
const LH = 30; // the label size's own line box: a shorter one clips descenders under numberOfLines
const styles = StyleSheet.create({
  wrap: { paddingLeft: SP.l + SP.xs, paddingRight: SP.xl },
  row: { flexDirection: 'row', alignItems: 'baseline' },
  lead: { color: C.dim, fontSize: T.label, lineHeight: LH, fontWeight: '700', marginRight: SP.l, fontFamily: F.family },
  habit: { flexDirection: 'row', alignItems: 'baseline', marginRight: SP.l },
  name: { color: C.text, fontSize: T.label, lineHeight: LH, fontWeight: '600', marginRight: SP.xs, fontFamily: F.family },
  dimName: { color: C.dim },
  nums: { color: C.text, fontSize: T.label, lineHeight: LH, fontFamily: F.family },
  mark: { color: C.faint, fontSize: T.label, lineHeight: LH, marginLeft: SP.xs, fontFamily: F.family },
  label: { flexShrink: 1, color: C.faint, fontSize: T.label, lineHeight: LH, fontFamily: F.family },
  agree: { flexShrink: 1, color: C.dim, fontSize: T.label, lineHeight: LH, marginLeft: SP.l, fontFamily: F.family },
});
