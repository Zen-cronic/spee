import { StyleSheet, Text, View } from 'react-native';
import type { InstrumentResponse, SettingsResponse, TransferHabit, TransferResponse } from '../contract';
import { BySettingLine } from '../components/BySetting';
import { CaptionsLine } from '../components/CaptionsLine';
import { FirstSignalLines } from '../components/FirstSignal';
import { useDebug } from '../debug';
import { captionsLine, fmtDate, fmtWords, habitTitle, transferRates, transferTitle, verdictWords } from '../mirror/format';
import { C, F, R, SP, T } from '../theme';
import { Empty } from './WeekView';

/**
 * Did the drilling carry over into real speech? Each pre-registered drilled habit's rate before
 * and after its first drill, and the control habit that was never drilled. The verdict words come
 * from the hub (non-overlapping 95% intervals, minimum words); the screen only says them plainly.
 * Under them, a secondary strip (CaptionsLine) with meeting captions included, labelled as such.
 */
export function TransferView({ transfer, captions, settings }: { transfer: TransferResponse | null; captions?: { all: TransferResponse | null; instrument: InstrumentResponse | null }; settings?: SettingsResponse | null }) {
  const debug = useDebug();
  if (!transfer) return <Empty text="Loading your progress…" />;
  const drilled = transfer.habits.filter((x) => x.role === 'drilled');
  const control = transfer.habits.filter((x) => x.role !== 'drilled');
  // The hub's own claim decides the plain line; the screen never re-derives it from the verdicts.
  const title = transferTitle(transfer);
  // The secondary captions rows take the note's top margin, so the cards keep their height.
  const withCaptions = !!captionsLine(captions?.all, captions?.instrument);
  return (
    <View style={styles.wrap} testID="view-transfer">
      <Text style={styles.kicker}>Since you started practising · your real conversations, heard by Bee</Text>
      <Text style={styles.title} numberOfLines={1}>{title.lead}</Text>
      {title.rest ? <Text style={[styles.title, styles.titleRest]} numberOfLines={1}>{title.rest}</Text> : null}
      {/* the per-setting line sits right under the result; the cards start closer so they keep their height */}
      <BySettingLine line={settings?.line} />
      <View style={[styles.cards, settings?.line ? styles.cardsTight : null]}>
        {drilled.map((x) => (
          <HabitCard key={x.habit} h={x} minWords={transfer.minWordsPerPeriod} />
        ))}
        {control.map((x) => (
          <HabitCard key={x.habit} h={x} minWords={transfer.minWordsPerPeriod} />
        ))}
      </View>
      <FirstSignalLines signals={transfer.firstSignal} />
      <CaptionsLine all={captions?.all ?? null} instrument={captions?.instrument ?? null} />
      <Text style={[styles.note, withCaptions && styles.noteTight]} numberOfLines={1}>{`Plan set ${fmtDate(transfer.prereg.registeredAt)}, before your first practice. A change counts only with ${fmtWords(transfer.minWordsPerPeriod)}+ words on each side and a clear gap between them.`}</Text>
      {debug ? <Text style={styles.debug} numberOfLines={2}>{transfer.habits.map((x) => `${x.habit} ${x.before.ci95.join('–')} → ${x.after.ci95.join('–')} (${x.before.words}/${x.after.words} w)`).join('  ·  ')}{transfer.unregistered.length ? `  ·  unregistered: ${transfer.unregistered.map((u) => u.habit).join(', ')}` : ''}</Text> : null}
    </View>
  );
}

function HabitCard({ h, minWords }: { h: TransferHabit; minWords: number }) {
  // a period without the minimum words is a dash, never "0.0"; the pill says why
  const r = transferRates(h, minWords);
  const drilled = h.role === 'drilled';
  const good = h.verdict === 'dropped';
  const bad = h.verdict === 'rose';
  return (
    <View style={[styles.card, drilled ? styles.paper : styles.dark]} testID={`transfer-${h.habit}`}>
      <Text style={[styles.habit, { color: drilled ? C.ink : C.text }]}>{habitTitle(h.habit, h.label)}</Text>
      <Text style={[styles.role, { color: drilled ? C.inkDim : C.dim }]}>{drilled ? 'Practised' : 'The one you didn’t practise'}</Text>
      <View style={{ flex: 1 }} />
      <View style={styles.nums}>
        <View>
          <Text style={[styles.before, { color: drilled ? C.inkFaint : C.faint }]}>{r.before ?? '–'}</Text>
          <Text style={[styles.numLabel, { color: drilled ? C.inkDim : C.dim }]}>before</Text>
        </View>
        <Text style={[styles.arrow, { color: drilled ? C.inkFaint : C.faint }]}>→</Text>
        <View>
          <Text style={[styles.after, { color: drilled ? C.ink : C.text }]}>{r.after ?? '–'}</Text>
          <Text style={[styles.numLabel, { color: drilled ? C.inkDim : C.dim }]}>now, per 100 words</Text>
        </View>
      </View>
      <View testID={`verdict-${h.habit}`} style={[styles.pill, good ? styles.pillGood : bad ? styles.pillBad : drilled ? styles.pillInk : styles.pillDark]}>
        <Text style={[styles.pillText, { color: good ? C.limeInk : bad ? C.coralInk : drilled ? C.paper : C.text }]}>{verdictWords(h)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  kicker: { color: C.dim, fontSize: T.small, fontFamily: F.family },
  title: { color: C.text, fontSize: T.h1, lineHeight: 76, fontWeight: '700', letterSpacing: -1, marginTop: SP.xs, fontFamily: F.family },
  titleRest: { color: C.dim, marginTop: 0 },
  cards: { flex: 1, flexDirection: 'row', marginTop: SP.l },
  cardsTight: { marginTop: SP.s },
  card: { flex: 1, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.l, marginRight: SP.l },
  paper: { backgroundColor: C.paper },
  dark: { backgroundColor: C.surface, marginRight: 0 },
  habit: { fontSize: T.h2, fontWeight: '700', fontFamily: F.family },
  role: { fontSize: T.body, marginTop: 4, fontFamily: F.family },
  nums: { flexDirection: 'row', alignItems: 'flex-end' },
  before: { fontSize: 88, lineHeight: 100, fontWeight: '600', letterSpacing: -1, fontFamily: F.family },
  arrow: { fontSize: 56, marginHorizontal: SP.m, marginBottom: 46, fontFamily: F.family },
  after: { fontSize: 136, lineHeight: 146, fontWeight: '700', letterSpacing: -2, fontFamily: F.family },
  numLabel: { fontSize: T.label, fontFamily: F.family },
  pill: { alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.s, marginTop: SP.m },
  pillGood: { backgroundColor: C.lime },
  pillBad: { backgroundColor: C.coral },
  pillInk: { backgroundColor: C.ink },
  pillDark: { backgroundColor: C.surface2 },
  pillText: { fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  note: { color: C.faint, fontSize: T.label, marginTop: SP.m, fontFamily: F.family },
  noteTight: { marginTop: SP.xs },
  debug: { color: C.faint, fontSize: 20, marginTop: SP.xs, fontFamily: F.mono },
});
