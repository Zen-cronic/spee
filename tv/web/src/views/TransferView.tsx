import { StyleSheet, Text, View } from 'react-native';
import type { TransferHabit, TransferResponse } from '../contract';
import { useDebug } from '../debug';
import { curly, fmt1, fmtDate, fmtWords, pctChange, shortHabit } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';
import { Empty } from './WeekView';

/**
 * Did the drilling carry over into real speech? Each pre-registered drilled habit's rate before
 * and after its first drill, and the control habit that was never drilled. The verdict words come
 * from the hub (non-overlapping 95% intervals, minimum words); the screen only says them plainly.
 */
export function TransferView({ transfer }: { transfer: TransferResponse | null }) {
  const debug = useDebug();
  if (!transfer) return <Empty text="Loading your progress…" />;
  const drilled = transfer.habits.filter((x) => x.role === 'drilled');
  const control = transfer.habits.filter((x) => x.role !== 'drilled');
  const allDropped = drilled.length > 0 && drilled.every((x) => x.verdict === 'dropped');
  const controlFlat = control.every((x) => x.verdict !== 'dropped');
  const title = allDropped && controlFlat ? 'The habits you drilled dropped. The one you didn’t, didn’t.' : curly(transfer.headline);
  return (
    <View style={styles.wrap} testID="view-transfer">
      <Text style={styles.kicker}>Since your first drill · real speech, from Bee</Text>
      <Text style={styles.title} numberOfLines={2}>{title}</Text>
      <View style={styles.cards}>
        {drilled.map((x) => (
          <HabitCard key={x.habit} h={x} />
        ))}
        {control.map((x) => (
          <HabitCard key={x.habit} h={x} />
        ))}
      </View>
      <Text style={styles.note} numberOfLines={1}>{`Plan registered ${fmtDate(transfer.prereg.registeredAt)}, before any drill. A change counts only with ${fmtWords(transfer.minWordsPerPeriod)}+ words on each side and clear statistical separation.`}</Text>
      {debug ? <Text style={styles.debug} numberOfLines={2}>{transfer.habits.map((x) => `${x.habit} ${x.before.ci95.join('–')} → ${x.after.ci95.join('–')} (${x.before.words}/${x.after.words} w)`).join('  ·  ')}{transfer.unregistered.length ? `  ·  unregistered: ${transfer.unregistered.map((u) => u.habit).join(', ')}` : ''}</Text> : null}
    </View>
  );
}

function verdictText(h: TransferHabit): string {
  const pct = pctChange(h.before.per100, h.after.per100);
  if (h.verdict === 'dropped') return pct === null ? 'Dropped' : `Down ${Math.abs(pct)}%`;
  if (h.verdict === 'rose') return pct === null ? 'Rose' : `Up ${Math.abs(pct)}%`;
  if (h.verdict === 'too little data') return 'Needs more speech';
  if (h.verdict === 'not drilled yet') return 'Not drilled yet';
  return 'No change';
}

function HabitCard({ h }: { h: TransferHabit }) {
  const drilled = h.role === 'drilled';
  const good = h.verdict === 'dropped';
  const bad = h.verdict === 'rose';
  return (
    <View style={[styles.card, drilled ? styles.paper : styles.dark]} testID={`transfer-${h.habit}`}>
      <Text style={[styles.habit, { color: drilled ? C.ink : C.text }]}>{shortHabit(h.label)}</Text>
      <Text style={[styles.role, { color: drilled ? C.inkDim : C.dim }]}>{drilled ? 'Drilled' : 'Never drilled, the control'}</Text>
      <View style={{ flex: 1 }} />
      <View style={styles.nums}>
        <View>
          <Text style={[styles.before, { color: drilled ? C.inkFaint : C.faint }]}>{fmt1(h.before.per100)}</Text>
          <Text style={[styles.numLabel, { color: drilled ? C.inkDim : C.dim }]}>before</Text>
        </View>
        <Text style={[styles.arrow, { color: drilled ? C.inkFaint : C.faint }]}>→</Text>
        <View>
          <Text style={[styles.after, { color: drilled ? C.ink : C.text }]}>{fmt1(h.after.per100)}</Text>
          <Text style={[styles.numLabel, { color: drilled ? C.inkDim : C.dim }]}>now, per 100 words</Text>
        </View>
      </View>
      <View testID={`verdict-${h.habit}`} style={[styles.pill, good ? styles.pillGood : bad ? styles.pillBad : drilled ? styles.pillInk : styles.pillDark]}>
        <Text style={[styles.pillText, { color: good ? C.limeInk : bad ? C.coralInk : drilled ? C.paper : C.text }]}>{verdictText(h)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  kicker: { color: C.dim, fontSize: T.small, fontFamily: F.family },
  title: { color: C.text, fontSize: T.h1, lineHeight: 76, fontWeight: '700', letterSpacing: -1, marginTop: SP.xs, maxWidth: 1600, fontFamily: F.family },
  cards: { flex: 1, flexDirection: 'row', marginTop: SP.xl },
  card: { flex: 1, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.xl, marginRight: SP.l },
  paper: { backgroundColor: C.paper },
  dark: { backgroundColor: C.surface, marginRight: 0 },
  habit: { fontSize: T.h2, fontWeight: '700', fontFamily: F.family },
  role: { fontSize: T.body, marginTop: 4, fontFamily: F.family },
  nums: { flexDirection: 'row', alignItems: 'flex-end' },
  before: { fontSize: 88, lineHeight: 100, fontWeight: '600', letterSpacing: -2, paddingHorizontal: 10, marginLeft: -10, fontFamily: F.family },
  arrow: { fontSize: 56, marginHorizontal: SP.m, marginBottom: 46, fontFamily: F.family },
  after: { fontSize: 150, lineHeight: 162, fontWeight: '700', letterSpacing: -5, paddingHorizontal: 12, marginLeft: -12, fontFamily: F.family },
  numLabel: { fontSize: T.label, fontFamily: F.family },
  pill: { alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.s, marginTop: SP.l },
  pillGood: { backgroundColor: C.lime },
  pillBad: { backgroundColor: C.coral },
  pillInk: { backgroundColor: C.ink },
  pillDark: { backgroundColor: C.surface2 },
  pillText: { fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  note: { color: C.faint, fontSize: T.label, marginTop: SP.l, fontFamily: F.family },
  debug: { color: C.faint, fontSize: 20, marginTop: SP.xs, fontFamily: F.mono },
});
