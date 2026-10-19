import { StyleSheet, Text, View } from 'react-native';
import { PRODUCT_NAME } from '../brand';
import { FocusButton } from '../focus';
import type { ScreenView } from '../mirror/reducer';
import { C, F, R, SP, T } from '../theme';

export const TAB_LABEL: Record<ScreenView, string> = {
  week: 'Home',
  transfer: 'Progress',
  drill: 'Live',
  live: 'Live',
  practice: 'Practice',
  recap: 'Recap',
  pair: 'Pair phone',
};
export const TABS: ScreenView[] = ['week', 'transfer', 'live', 'practice', 'pair'];

/** Top line: the wordmark, the screen tabs in one pill group (remote row 0), and the phone status. */
export function TopBar({ view, onShow, right, rightTone }: { view: ScreenView; onShow: (v: ScreenView) => void; right?: string | null; rightTone?: 'ok' | 'warn' }) {
  const current = view === 'drill' ? 'live' : view;
  return (
    <View style={styles.top}>
      <View style={styles.brandRow}>
        <View style={styles.brandDot} />
        <Text style={styles.brand}>{PRODUCT_NAME}</Text>
      </View>
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

/** The honesty line, on every screen: the hub's dataLabel whenever the data is synthetic, and Bee replay. Quiet, never hidden. */
export function DataLabel({ label, synthetic, replay, extra }: { label: string | null; synthetic: boolean; replay: boolean; extra?: string | null }) {
  return (
    <View style={styles.footer} testID="data-label">
      {synthetic ? (
        <>
          <View style={styles.synthDot} />
          <Text style={styles.synthetic}>{label ?? 'SYNTHETIC DEMO DATA'}</Text>
        </>
      ) : (
        <Text style={styles.real}>Real speech from Bee. A phone or Alexa preview counts only once Bee confirms it.</Text>
      )}
      {replay ? <Text style={styles.replay}>Bee replay (demo)</Text> : null}
      <View style={{ flex: 1 }} />
      {extra ? <Text style={styles.extra} numberOfLines={1}>{extra}</Text> : null}
    </View>
  );
}

/** A section heading: a quiet kicker over the title. Siblings, never nested Text (Vega tracking). */
export function Heading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.kicker}>{kicker}</Text>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', height: 76 },
  brandRow: { flexDirection: 'row', alignItems: 'center', marginRight: SP.xxl },
  brandDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.lime, marginRight: SP.s },
  brand: { flexShrink: 0, color: C.text, fontSize: T.small, fontWeight: '700', fontFamily: F.family },
  tabs: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.pill, padding: 6 },
  right: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  footer: { flexDirection: 'row', alignItems: 'center', height: 36, marginTop: SP.m },
  synthDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.amber, marginRight: SP.s },
  synthetic: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  real: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  replay: { color: C.faint, fontSize: T.label, marginLeft: SP.l, fontFamily: F.family },
  extra: { color: C.faint, fontSize: T.label, fontFamily: F.family, maxWidth: 800 },
  heading: { marginBottom: SP.l },
  kicker: { color: C.dim, fontSize: T.small, fontFamily: F.family },
  title: { color: C.text, fontSize: T.h1, fontWeight: '700', marginTop: 4, fontFamily: F.family },
});
