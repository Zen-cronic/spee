import { StyleSheet, Text, View } from 'react-native';
import { Heading } from '../components/Chrome';
import { RateBar } from '../components/RateBar';
import type { DeckSummary, PracticeCounts, StatsResponse } from '../contract';
import { fmt2, fmtWords, niceMax, topBreakdown, WEEK_HABITS } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

const BAR_W = 760;
const HABIT_COLOR: Record<string, string> = { hedges: C.coral, vague: C.amber, fillers: C.lavender, restarts: C.dim };

/** The week's habit rates from Bee, per 100 words, with 95% interval whiskers, and today's drills. */
export function WeekView({ stats, today, deck, transferHeadline }: { stats: StatsResponse | null; today: PracticeCounts | null; deck: DeckSummary | null; transferHeadline: string | null }) {
  if (!stats) return <Empty text="Loading the week from the hub…" />;
  const h = stats.habits;
  const rows = WEEK_HABITS.map((w) => ({ ...w, rate: h[w.key], breakdown: 'breakdown' in h[w.key] ? topBreakdown((h[w.key] as { breakdown: Record<string, number> }).breakdown) : '' }));
  const max = niceMax(Math.max(...rows.map((r) => r.rate.ci95[1])));
  const sessions = stats.sessions.length;
  const p = today; // today's drills, never the week's practice block
  return (
    <View style={styles.wrap} testID="view-week">
      <View style={styles.main}>
        <Heading kicker={`THIS WEEK · ${stats.source === 'bee' ? 'BEE ONLY' : 'BEE + MEETINGS'}`} title="Habits per 100 words of your real speech" />
        {rows.map((r) => (
          <View key={r.key} style={styles.row} testID={`week-${r.key}`}>
            <View style={styles.rowHead}>
              <Text style={styles.habit}>{r.label}</Text>
              <Text style={styles.breakdown} numberOfLines={1}>{r.breakdown}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rate, { color: HABIT_COLOR[r.key] }]}>{fmt2(r.rate.per100)}</Text>
              <RateBar value={r.rate.per100} ci={r.rate.ci95} max={max} width={BAR_W} color={HABIT_COLOR[r.key]!} />
              <View style={styles.ciBox}>
                <Text style={styles.ci}>{`${r.rate.count} in ${fmtWords(h.words)} words`}</Text>
                <Text style={styles.ci}>{`95% ${fmt2(r.rate.ci95[0])}–${fmt2(r.rate.ci95[1])}`}</Text>
              </View>
            </View>
          </View>
        ))}
        <Text style={styles.axis}>{`Axis 0–${max} per 100 words. Whiskers: 95% Poisson interval.`}</Text>
      </View>
      <View style={styles.side}>
        <View style={styles.card}>
          <Text style={styles.kicker}>SOURCE</Text>
          <Text style={styles.big}>{fmtWords(h.words)}</Text>
          <Text style={styles.sideText}>{`words you said in ${sessions} Bee session${sessions === 1 ? '' : 's'}`}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.kicker}>DRILLS TODAY</Text>
          <Text style={styles.big}>{p ? `${p.passed}/${p.counted}` : '–'}</Text>
          <Text style={styles.sideText}>{p ? `passed, graded from Bee${p.beeOverrules ? ` · Bee overruled ${p.beeOverrules}` : ''}${p.unverified ? ` · ${p.unverified} unverified` : ''}` : 'loading today from the hub'}</Text>
          {deck ? <Text style={styles.sideText}>{`${deck.dueNow} card${deck.dueNow === 1 ? '' : 's'} due now`}</Text> : null}
        </View>
        {transferHeadline ? (
          <View style={styles.card}>
            <Text style={styles.kicker}>TRANSFER</Text>
            <Text style={styles.sideText} numberOfLines={4}>{transferHeadline}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  main: { flex: 1, paddingRight: SP.xxl },
  row: { marginBottom: SP.l },
  rowHead: { flexDirection: 'row', alignItems: 'baseline' },
  habit: { color: C.text, fontSize: T.title, fontWeight: '800', fontFamily: F.family },
  rowBody: { flexDirection: 'row', alignItems: 'center', marginTop: SP.xs },
  rate: { width: 150, fontSize: T.h1, fontWeight: '800', fontFamily: F.family },
  ciBox: { marginLeft: SP.m },
  ci: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  breakdown: { flex: 1, color: C.faint, fontSize: T.label, marginLeft: SP.l, fontFamily: F.family },
  axis: { color: C.faint, fontSize: T.label, marginLeft: 150, fontFamily: F.family },
  side: { width: 520 },
  card: { backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.l, paddingVertical: SP.m, marginBottom: SP.m },
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  big: { color: C.text, fontSize: 80, fontWeight: '800', paddingHorizontal: 12, marginLeft: -12, fontFamily: F.family },
  sideText: { color: C.dim, fontSize: T.small, lineHeight: 36, fontFamily: F.family },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.dim, fontSize: T.title, textAlign: 'center', fontFamily: F.family },
});
