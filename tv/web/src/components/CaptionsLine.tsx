import { StyleSheet, Text, View } from 'react-native';
import type { InstrumentResponse, TransferResponse } from '../contract';
import { captionsLine } from '../mirror/format';
import { C, F, SP, T } from '../theme';
import { DetailRow } from './DetailRow';

/**
 * Meeting captions, in Progress's Details: the same before/after with meeting captions included,
 * labelled as not the pre-registered check (which stays Bee only, on the cards). Hidden without a
 * caption session. The comparison line says captions and Bee gave similar numbers only when the
 * hub's instrument check finds it, and says when there is too little data to compare. Siblings,
 * never nested Text (Vega tracking).
 */
export function CaptionsLine({ all, instrument }: { all: TransferResponse | null; instrument: InstrumentResponse | null }) {
  const line = captionsLine(all, instrument);
  if (!line) return null;
  return (
    <DetailRow testID="captions-line" tag="Meeting captions" caveat={line.label}>
      <View style={styles.row}>
        {line.habits.map((h) => (
          <View key={h.habit} style={styles.habit} testID={`captions-${h.habit}`}>
            <Text style={[styles.name, h.role !== 'drilled' && styles.dimName]} numberOfLines={1}>{h.title}</Text>
            <Text style={styles.nums} numberOfLines={1}>{`${h.before} → ${h.after}`}</Text>
            {h.unchecked ? <Text style={styles.mark} numberOfLines={1}>not checked</Text> : null}
          </View>
        ))}
      </View>
      {line.agree ? <Text style={styles.agree} numberOfLines={1} testID="captions-agree">{line.agree}</Text> : null}
    </DetailRow>
  );
}

const LH = 38;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  habit: { flexDirection: 'row', alignItems: 'baseline', marginRight: SP.xl },
  name: { color: C.text, fontSize: T.small, lineHeight: LH, fontWeight: '600', marginRight: SP.s, fontFamily: F.family },
  dimName: { color: C.dim },
  nums: { color: C.text, fontSize: T.small, lineHeight: LH, fontFamily: F.family },
  agree: { color: C.dim, fontSize: T.label, lineHeight: 32, fontFamily: F.family },
  mark: { color: C.faint, fontSize: T.label, lineHeight: LH, marginLeft: SP.xs, fontFamily: F.family },
});
