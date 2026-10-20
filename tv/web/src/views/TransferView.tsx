import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { InstrumentResponse, SettingsResponse, TransferHabit, TransferResponse } from '../contract';
import { BySettingLine } from '../components/BySetting';
import { CaptionsLine } from '../components/CaptionsLine';
import { DetailRow } from '../components/DetailRow';
import { FirstSignalLines } from '../components/FirstSignal';
import { useDebug } from '../debug';
import { FocusButton } from '../focus';
import { fmtDate, fmtWords, habitTitle, transferRates, transferTitle, verdictWords } from '../mirror/format';
import { C, F, habitHue, R, SP, T } from '../theme';
import { Empty } from './WeekView';

/**
 * Did practising carry over into real speech? One line from the hub's claim, then one card per
 * pre-registered habit: its rate before its first practice and now, in the habit's own hue, with
 * the hub's verdict as a coloured pill (lime down, coral up, an outlined pill for anything
 * undecided). A period without the minimum words shows a dash, never "0.0".
 *
 * Everything secondary (the plan, the first signal, meeting captions, by setting) sits behind one
 * Details button (Down from the tabs, then OK), each row with its own caveat.
 */
export function TransferView({ transfer, captions, settings }: { transfer: TransferResponse | null; captions?: { all: TransferResponse | null; instrument: InstrumentResponse | null }; settings?: SettingsResponse | null }) {
  const debug = useDebug();
  const [details, setDetails] = useState(false);
  if (!transfer) return <Empty text="Loading your progress…" />;
  const drilled = transfer.habits.filter((x) => x.role === 'drilled');
  const control = transfer.habits.filter((x) => x.role !== 'drilled');
  // The hub's own claim decides the words; the screen never re-derives it from the verdicts.
  const title = transferTitle(transfer);
  // partly started: the second half only repeats the card's "Not practised yet" pill
  const note = transfer.claim === 'partly-started' ? null : title.rest;
  return (
    <View style={styles.wrap} testID="view-transfer">
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>{title.lead}</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.gloss} numberOfLines={1}>out of every 100 words you said</Text>
      </View>
      {details ? (
        <View style={styles.details} testID="transfer-details">
          <DetailRow first tag="The plan" text={`Set ${fmtDate(transfer.prereg.registeredAt)}, before you first practised. A change counts only with ${fmtWords(transfer.minWordsPerPeriod)}+ words each side and a clear gap.`} />
          <FirstSignalLines signals={transfer.firstSignal} />
          <CaptionsLine all={captions?.all ?? null} instrument={captions?.instrument ?? null} />
          <BySettingLine line={settings?.line} />
        </View>
      ) : (
        <View style={styles.cards}>
          {[...drilled, ...control].map((x, i, all) => (
            <HabitCard key={x.habit} h={x} minWords={transfer.minWordsPerPeriod} last={i === all.length - 1} />
          ))}
        </View>
      )}
      <View style={styles.foot}>
        <FocusButton id="transfer-details" row={1} col={0} small label={details ? 'Back to results' : 'Details'} onPress={() => setDetails(!details)} />
        {note && !details ? <Text style={styles.note} numberOfLines={1}>{note}</Text> : null}
      </View>
      {debug ? <Text style={styles.debug} numberOfLines={2}>{transfer.habits.map((x) => `${x.habit} ${x.before.ci95.join('–')} → ${x.after.ci95.join('–')} (${x.before.words}/${x.after.words} w)`).join('  ·  ')}{transfer.unregistered.length ? `  ·  unregistered: ${transfer.unregistered.map((u) => u.habit).join(', ')}` : ''}</Text> : null}
    </View>
  );
}

function HabitCard({ h, minWords, last }: { h: TransferHabit; minWords: number; last: boolean }) {
  const drilled = h.role === 'drilled';
  const good = h.verdict === 'dropped';
  const bad = h.verdict === 'rose';
  const hue = habitHue(h.habit);
  const r = transferRates(h, minWords);
  return (
    <View style={[styles.card, { backgroundColor: hue.tint }, last && { marginRight: 0 }]} testID={`transfer-${h.habit}`}>
      <View style={[styles.band, { backgroundColor: hue.hue }]} />
      <Text style={styles.habit} numberOfLines={1}>{habitTitle(h.habit, h.label)}</Text>
      <Text style={styles.role}>{drilled ? 'Practised' : 'Not practised'}</Text>
      <View style={styles.nums}>
        <View>
          <Text style={[styles.before, !r.before && styles.none]}>{r.before ?? '–'}</Text>
          <Text style={styles.numLabel}>before</Text>
        </View>
        <Text style={styles.arrow}>→</Text>
        <View>
          {/* no number yet: a short dash at the before numeral's size and baseline, never a bar the width of "0.0" */}
          <Text style={[styles.after, r.after ? { color: hue.hue } : styles.afterNone]}>{r.after ?? '–'}</Text>
          <Text style={styles.numLabel}>now</Text>
        </View>
      </View>
      <View testID={`verdict-${h.habit}`} style={[styles.pill, good ? styles.pillGood : bad ? styles.pillBad : styles.pillWait]}>
        <Text style={[styles.pillText, { color: good ? C.limeInk : bad ? C.coralInk : C.text }]}>{verdictWords(h)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline' },
  title: { flexShrink: 1, color: C.text, fontSize: 58, lineHeight: 70, fontWeight: '700', letterSpacing: -1, fontFamily: F.family },
  gloss: { color: C.dim, fontSize: T.label, marginLeft: SP.xl, fontFamily: F.family },
  cards: { flex: 1, flexDirection: 'row', marginTop: SP.l },
  // the card's content is one group, centred in the row's height: name, numbers and pill stay together
  card: { flex: 1, justifyContent: 'center', borderRadius: R.l, paddingHorizontal: SP.xl, paddingTop: SP.xl + 10, paddingBottom: SP.xl, marginRight: SP.l, overflow: 'hidden' },
  band: { position: 'absolute', left: 0, right: 0, top: 0, height: 10 },
  habit: { color: C.text, fontSize: T.h2, fontWeight: '700', fontFamily: F.family },
  role: { color: C.dim, fontSize: T.body, marginTop: 4, fontFamily: F.family },
  nums: { flexDirection: 'row', alignItems: 'flex-end', marginTop: SP.xl },
  // numerals: no negative letter spacing (Vega draws a sliver beside the first glyph)
  before: { color: C.dim, fontSize: 84, lineHeight: 96, fontWeight: '600', fontFamily: F.family },
  none: { color: C.faint },
  arrow: { color: C.faint, fontSize: 56, marginHorizontal: SP.m, marginBottom: 44, fontFamily: F.family },
  after: { fontSize: 148, lineHeight: 156, fontWeight: '700', fontFamily: F.family },
  afterNone: { color: C.faint, fontSize: 84, lineHeight: 96, minWidth: 120 },
  numLabel: { color: C.dim, fontSize: T.label, fontFamily: F.family },
  pill: { alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.s, marginTop: SP.l },
  pillGood: { backgroundColor: C.lime },
  pillBad: { backgroundColor: C.coral },
  // undecided (needs more speech, not practised yet, no change): a quiet outlined pill, never a verdict colour
  pillWait: { backgroundColor: 'rgba(255,240,220,0.08)', borderWidth: 2, borderColor: 'rgba(255,240,220,0.28)', paddingVertical: SP.s - 2 },
  pillText: { fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  details: { flex: 1, marginTop: SP.l, backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.m },
  // a small inset: the focused button grows a little and must not touch the clip edge
  foot: { flexDirection: 'row', alignItems: 'center', marginTop: SP.m, paddingLeft: SP.xs },
  note: { flexShrink: 1, color: C.dim, fontSize: T.small, marginLeft: SP.l, fontFamily: F.family },
  debug: { color: C.faint, fontSize: 20, marginTop: SP.xs, fontFamily: F.mono },
});
