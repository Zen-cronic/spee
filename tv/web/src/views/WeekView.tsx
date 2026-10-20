import { StyleSheet, Text, View } from 'react-native';
import type { DeckSummary, PracticeCounts, StatsResponse, TransferResponse } from '../contract';
import { changeLabel, controlWord, fmt1, fmtWords, shortHabit, topWord, transferWorking, WEEK_HABITS } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';

/**
 * Home: the one thing to do now (the drills waiting, today's tally checked by Bee), this week's
 * habit rates from Bee, and whether the drilling is working (the pre-registered before/after).
 */
export function WeekView({ stats, today, deck, transfer }: { stats: StatsResponse | null; today: PracticeCounts | null; deck: DeckSummary | null; transfer: TransferResponse | null }) {
  if (!stats) return <Empty text="Loading your week…" />;
  const h = stats.habits;
  const rows = WEEK_HABITS.map((w) => ({ ...w, rate: h[w.key], top: 'breakdown' in h[w.key] ? topWord((h[w.key] as { breakdown: Record<string, number> }).breakdown) : null }));
  const sessions = stats.sessions.length;
  const due = deck?.dueNow ?? null;
  return (
    <View style={styles.wrap} testID="view-week">
      <View style={styles.hero}>
        <Text style={styles.heroKicker}>Today</Text>
        {due === null ? (
          <Text style={styles.heroNum}>–</Text>
        ) : due > 0 ? (
          <>
            <Text style={styles.heroNum}>{String(due)}</Text>
            <Text style={styles.heroLabel}>{`drill${due === 1 ? '' : 's'} waiting`}</Text>
          </>
        ) : (
          <>
            <Text style={[styles.heroNum, styles.heroDone]}>Done</Text>
            <Text style={styles.heroLabel}>No drills due. Nice.</Text>
          </>
        )}
        <View style={{ flex: 1 }} />
        {due ? (
          <View style={styles.cta}>
            <Text style={styles.ctaText}>Say “Alexa, quiz me”</Text>
          </View>
        ) : null}
        <View style={styles.tally}>
          {today && today.counted > 0 ? <Text style={styles.tallyText}>{`${today.passed} of ${today.counted} passed today`}</Text> : null}
          <View style={[styles.beeRow, !(today && today.counted > 0) && { marginTop: 0 }]}>
            <View style={styles.beeDot} />
            <Text style={styles.beeText}>Every drill is checked by Bee</Text>
          </View>
        </View>
      </View>
      <View style={styles.side}>
        <View style={[styles.card, styles.weekCard]}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>This week</Text>
            <Text style={styles.cardNote}>{`per 100 words · ${fmtWords(h.words)} words in ${sessions} conversation${sessions === 1 ? '' : 's'}`}</Text>
          </View>
          {rows.map((r) => (
            <View key={r.key} style={styles.row} testID={`week-${r.key}`}>
              <View style={styles.rowLabel}>
                <Text style={styles.habit}>{r.label}</Text>
                <Text style={styles.top} numberOfLines={1}>{r.top ? `mostly ${r.top}` : r.key === 'restarts' ? 'never drilled' : ' '}</Text>
              </View>
              <Text style={styles.rate}>{fmt1(r.rate.per100)}</Text>
            </View>
          ))}
        </View>
        <Working transfer={transfer} />
      </View>
    </View>
  );
}

/**
 * "It's working": each drilled habit's change since its first drill, and the never-drilled control.
 * The title says it is working only when the hub's headline does (a drop, and the control flat).
 */
function Working({ transfer }: { transfer: TransferResponse | null }) {
  if (!transfer) return null;
  const drilled = transfer.habits.filter((x) => x.role === 'drilled');
  const control = transfer.habits.find((x) => x.role === 'control');
  const shown = transferWorking(transfer.claim);
  const cw = control ? controlWord(control) : null;
  return (
    <View style={[styles.card, styles.working]} testID="week-transfer">
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={1}>{shown ? 'It’s working' : 'Since drilling'}</Text>
        {shown ? <Text style={styles.cardNote} numberOfLines={1}>since your first drill</Text> : null}
      </View>
      <View style={styles.workRow}>
        {drilled.map((x) => {
          const change = changeLabel(x);
          return (
            <View key={x.habit} style={styles.workItem} testID={`week-change-${x.habit}`}>
              <View style={styles.workValue}>
                <Text style={[styles.workNum, x.verdict === 'dropped' && { color: C.lime }, !change.pct && styles.workNone]}>{change.pct ? change.text : '—'}</Text>
              </View>
              <Text style={styles.workLabel} numberOfLines={1}>{shortHabit(x.label)}</Text>
              {change.pct ? null : <Text style={styles.workWords} numberOfLines={1}>{change.text}</Text>}
            </View>
          );
        })}
        {control && cw ? (
          <View style={styles.workItem}>
            <View style={styles.workValue}>
              <Text style={[styles.workNum, styles.workFlat, cw.word && styles.workNone]} numberOfLines={1}>{cw.word ? '—' : cw.text}</Text>
            </View>
            <Text style={styles.workLabel} numberOfLines={1}>{`${shortHabit(control.label)}, the control`}</Text>
            {cw.word ? <Text style={styles.workWords} numberOfLines={1}>{cw.text}</Text> : null}
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

const PAD = { paddingHorizontal: SP.xxl, paddingVertical: 44 };

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  hero: { width: 720, backgroundColor: C.paper, borderRadius: R.l, ...PAD, marginRight: SP.l },
  heroKicker: { color: C.inkDim, fontSize: T.title, fontWeight: '600', fontFamily: F.family },
  heroNum: { color: C.ink, fontSize: 300, lineHeight: 300, fontWeight: '700', letterSpacing: -8, paddingHorizontal: 16, marginLeft: -16, marginTop: SP.xs, fontFamily: F.family },
  heroDone: { fontSize: T.big, lineHeight: 140, letterSpacing: -3 },
  heroLabel: { color: C.ink, fontSize: T.h2, fontWeight: '600', marginTop: -SP.s, fontFamily: F.family },
  cta: { alignSelf: 'flex-start', backgroundColor: C.ink, borderRadius: R.pill, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginBottom: SP.xl },
  ctaText: { color: C.lime, fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  tally: { borderTopWidth: 2, borderColor: 'rgba(0,0,0,0.08)', paddingTop: SP.l },
  tallyText: { color: C.ink, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  beeRow: { flexDirection: 'row', alignItems: 'center', marginTop: SP.s },
  beeDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.lavender, marginRight: SP.s },
  beeText: { color: C.inkDim, fontSize: T.label, fontFamily: F.family },
  side: { flex: 1 },
  card: { backgroundColor: C.surface, borderRadius: R.l, ...PAD },
  weekCard: { flex: 1 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: SP.s },
  cardTitle: { color: C.text, fontSize: T.title, fontWeight: '700', fontFamily: F.family },
  cardNote: { color: C.faint, fontSize: T.label, marginTop: 4, fontFamily: F.family },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderColor: C.rule },
  rowLabel: { flex: 1 },
  habit: { color: C.text, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  top: { color: C.faint, fontSize: T.label, marginTop: 2, fontFamily: F.family },
  rate: { width: 140, textAlign: 'right', color: C.text, fontSize: 52, fontWeight: '700', letterSpacing: -1, paddingHorizontal: 8, fontFamily: F.family },
  working: { marginTop: SP.l, paddingVertical: SP.l },
  workRow: { flexDirection: 'row', marginTop: SP.s },
  workItem: { flex: 1, paddingRight: SP.m },
  workValue: { height: 68, justifyContent: 'flex-end' },
  workNum: { color: C.text, fontSize: 60, lineHeight: 68, fontWeight: '700', letterSpacing: -1, paddingHorizontal: 10, marginLeft: -10, fontFamily: F.family },
  workWords: { color: C.faint, fontSize: T.label, marginTop: 2, fontFamily: F.family },
  workNone: { color: C.faint },
  workFlat: { color: C.dim },
  workLabel: { color: C.dim, fontSize: T.label, marginTop: 2, fontFamily: F.family },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.dim, fontSize: T.title, textAlign: 'center', fontFamily: F.family },
});
