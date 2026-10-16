import { StyleSheet, Text, View } from 'react-native';
import { Chip } from '../components/Chip';
import { Heading } from '../components/Chrome';
import { RateBar } from '../components/RateBar';
import type { TransferHabit, TransferResponse } from '../contract';
import { fmt2, fmtDate, fmtWords, niceMax, verdictTone } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';
import { Empty } from './WeekView';

const BAR_W = 620;

/**
 * Did the drilling transfer? Each pre-registered habit's rate before and after its cutover (the
 * first drill), with 95% whiskers, the verdict, and the control habit that was never drilled.
 */
export function TransferView({ transfer }: { transfer: TransferResponse | null }) {
  if (!transfer) return <Empty text="Loading the transfer result from the hub…" />;
  const habits = [...transfer.habits].sort((a, b) => (a.role === b.role ? 0 : a.role === 'drilled' ? -1 : 1));
  const max = niceMax(Math.max(...habits.flatMap((x) => [x.before.ci95[1], x.after.ci95[1]])));
  return (
    <View style={styles.wrap} testID="view-transfer">
      <View style={styles.head}>
        <Heading kicker={`PRE-REGISTERED ${fmtDate(transfer.prereg.registeredAt).toUpperCase()} · BEFORE ANY DRILL`} title="Did the drilling carry over into real speech?" />
        <Text style={styles.headline} numberOfLines={2}>{transfer.headline}</Text>
      </View>
      {habits.map((x) => (
        <HabitRow key={x.habit} h={x} max={max} />
      ))}
      <View style={styles.foot}>
        <Text style={styles.note} numberOfLines={1}>{`A verdict needs non-overlapping 95% intervals and ${fmtWords(transfer.minWordsPerPeriod)}+ words per period. The control is never drilled.`}</Text>
        {transfer.unregistered.length ? <Text style={styles.note} numberOfLines={1}>{`Not pre-registered (no verdict): ${transfer.unregistered.map((u) => u.habit).join(', ')}`}</Text> : null}
      </View>
    </View>
  );
}

function HabitRow({ h, max }: { h: TransferHabit; max: number }) {
  return (
    <View style={styles.row} testID={`transfer-${h.habit}`}>
      <View style={styles.label}>
        <Chip text={h.role === 'drilled' ? 'DRILLED' : 'CONTROL'} tone={h.role === 'drilled' ? 'bee' : 'neutral'} />
        <Text style={styles.habit} numberOfLines={2}>{h.label}</Text>
      </View>
      <View style={styles.bars}>
        <Period tag="BEFORE" p={h.before} max={max} color={C.faint} />
        <Period tag="AFTER" p={h.after} max={max} color={h.verdict === 'dropped' ? C.mint : h.verdict === 'rose' ? C.coral : C.dim} />
      </View>
      <View style={styles.verdict}>
        <Chip text={h.verdict.toUpperCase()} tone={verdictTone(h.verdict)} big testID={`verdict-${h.habit}`} />
        <Text style={styles.delta}>{h.deltaPer100 === null ? '' : `${h.deltaPer100 > 0 ? '+' : ''}${fmt2(h.deltaPer100)} per 100`}</Text>
        {h.wordsNeededPerPeriod !== null ? <Text style={styles.small} numberOfLines={1}>{`needs ${fmtWords(h.wordsNeededPerPeriod)} words/period`}</Text> : null}
      </View>
    </View>
  );
}

function Period({ tag, p, max, color }: { tag: string; p: TransferHabit['before']; max: number; color: string }) {
  return (
    <View style={styles.period}>
      <Text style={styles.tag}>{tag}</Text>
      <Text style={styles.rate}>{fmt2(p.per100)}</Text>
      <RateBar value={p.per100} ci={p.ci95} max={max} width={BAR_W} color={color} height={26} />
      <Text style={styles.words}>{`${fmtWords(p.words)} w`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  head: { marginBottom: 0 },
  headline: { color: C.text, fontSize: T.small, lineHeight: 36, maxWidth: 1700, fontFamily: F.family },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.l, paddingVertical: SP.s, marginTop: SP.m },
  label: { width: 440 },
  habit: { color: C.text, fontSize: T.small, fontWeight: '800', marginTop: SP.xs, lineHeight: 34, fontFamily: F.family },
  small: { color: C.faint, fontSize: 22, marginTop: 2, fontFamily: F.family },
  bars: { flex: 1 },
  period: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
  tag: { width: 110, color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 2, fontFamily: F.family },
  rate: { width: 100, color: C.text, fontSize: T.title, fontWeight: '800', fontFamily: F.family },
  words: { color: C.faint, fontSize: T.label, marginLeft: SP.m, fontFamily: F.family },
  verdict: { width: 300, alignItems: 'flex-end' },
  delta: { color: C.dim, fontSize: T.label, marginTop: SP.xs, fontFamily: F.family },
  foot: { marginTop: SP.m },
  note: { color: C.faint, fontSize: T.label, lineHeight: 32, fontFamily: F.family },
});
