import { StyleSheet, Text, View } from 'react-native';
import { WORDMARK } from '../brand';
import { FocusButton } from '../focus';
import type { ScreenView } from '../mirror/reducer';
import { C, F, SP, T } from '../theme';

export const TAB_LABEL: Record<ScreenView, string> = {
  week: 'Week',
  transfer: 'Transfer',
  drill: 'Live',
  live: 'Live',
  practice: 'Practice',
  recap: 'Recap',
  pair: 'Pair phone',
};
export const TABS: ScreenView[] = ['week', 'transfer', 'live', 'practice', 'pair'];

/** Top line: the wordmark, the screen tabs (remote row 0), and the link status on the right. */
export function TopBar({ view, onShow, right, rightTone }: { view: ScreenView; onShow: (v: ScreenView) => void; right?: string | null; rightTone?: 'ok' | 'warn' }) {
  const current = view === 'drill' ? 'live' : view;
  return (
    <View style={styles.top}>
      <Text style={styles.brand}>{WORDMARK}</Text>
      <View style={styles.tabs}>
        {TABS.map((t, i) => (
          <FocusButton key={t} id={`tab-${t}`} row={0} col={i} small label={TAB_LABEL[t]} tone={t === current ? 'active' : 'ghost'} current={t === current} onPress={() => onShow(t)} />
        ))}
      </View>
      <View style={{ flex: 1 }} />
      {right ? <Text style={[styles.right, rightTone === 'warn' && { color: C.amber }]}>{right}</Text> : null}
    </View>
  );
}

/** The honesty line, on every screen: the hub's dataLabel whenever the data is synthetic, and Bee replay. */
export function DataLabel({ label, synthetic, replay, extra }: { label: string | null; synthetic: boolean; replay: boolean; extra?: string | null }) {
  return (
    <View style={styles.footer} testID="data-label">
      {synthetic ? <Text style={styles.synthetic}>{label ?? 'SYNTHETIC DEMO DATA'}</Text> : <Text style={styles.real}>Real data from Bee (Apple Watch). Phone and Alexa text is provisional until Bee confirms it.</Text>}
      {replay ? <Text style={styles.replay}>Bee replay (demo)</Text> : null}
      <View style={{ flex: 1 }} />
      {extra ? <Text style={styles.extra} numberOfLines={1}>{extra}</Text> : null}
    </View>
  );
}

/** A section heading: small caps kicker over the title. Siblings, never nested Text (Vega tracking). */
export function Heading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.kicker}>{kicker}</Text>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', height: 64 },
  brand: { flexShrink: 0, color: C.mint, fontSize: T.label, fontWeight: '900', letterSpacing: 6, marginRight: SP.xl, fontFamily: F.family },
  tabs: { flexDirection: 'row', alignItems: 'center' },
  right: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  footer: { flexDirection: 'row', alignItems: 'center', height: 40, marginTop: SP.s },
  synthetic: { color: C.amber, fontSize: T.label, fontWeight: '800', fontFamily: F.family },
  real: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  replay: { color: C.lavender, fontSize: T.label, fontWeight: '800', marginLeft: SP.l, fontFamily: F.family },
  extra: { color: C.faint, fontSize: T.label, fontFamily: F.family, maxWidth: 800 },
  heading: { marginBottom: SP.m },
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  title: { color: C.text, fontSize: T.h2, fontWeight: '800', marginTop: 4, fontFamily: F.family },
});
