import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TransferHabit, TransferResponse } from '../contract';
import { DetailRow } from '../components/DetailRow';
import { FirstSignalLines } from '../components/FirstSignal';
import { useDebug } from '../debug';
import { FocusButton } from '../focus';
import { AFTER_WINDOW, BEFORE_WINDOW, beeMemoryLine, habitPill, habitRole, habitTitle, planLine, transferRates, transferTitle, type BeeMemoryIn } from '../mirror/format';
import { C, F, habitHue, R, SP, T } from '../theme';
import { Empty } from './WeekView';

/**
 * Did practising carry over into real speech? One line from the hub's claim, then one card per
 * pre-registered habit: its rate before its first practice and now, in the habit's own hue, with
 * the hub's verdict as a coloured pill (lime down, coral up, an outlined pill for anything
 * undecided). A period without the minimum words shows a dash, never "0.0".
 *
 * Everything secondary (the plan, the first signal, Bee memory) sits behind one Details button
 * (Down from the tabs, then OK), each row with its own caveat. The meeting-captions and by-setting
 * side analyses stay in the API (/api/transfer?source=all, /api/instrument, /api/settings) but are
 * not on the TV: they added a dozen numbers the pre-registered result does not use.
 */
export function TransferView({ transfer, memory }: { transfer: TransferResponse | null; memory?: BeeMemoryIn | null }) {
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
          <PlanRow transfer={transfer} />
          <FirstSignalLines signals={transfer.firstSignal} />
          <BeeMemoryRow memory={memory ?? null} />
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

/** The plan: its first sentence (a two-tier pilot, set before the first practice) and its caveat. */
function PlanRow({ transfer }: { transfer: TransferResponse }) {
  const p = planLine(transfer);
  return <DetailRow first testID="plan" tag="The plan" text={p.first} caveat={p.caveat} />;
}

/**
 * Bee memory, only when the hub reports it on: the coach's goal fact in Bee. Bee's counts and the
 * note on what reads coach-written facts stay in GET /api/coach/facts (and the skill); not on the TV.
 */
function BeeMemoryRow({ memory }: { memory: BeeMemoryIn | null }) {
  const m = beeMemoryLine(memory);
  if (!m) return null;
  return <DetailRow testID="bee-memory" tag="Bee memory" text={m.text} />;
}

function HabitCard({ h, minWords, last }: { h: TransferHabit; minWords: number; last: boolean }) {
  const good = h.verdict === 'dropped';
  const bad = h.verdict === 'rose';
  const hue = habitHue(h.habit);
  const r = transferRates(h, minWords);
  const pill = habitPill(h);
  return (
    <View style={[styles.card, { backgroundColor: hue.tint }, last && { marginRight: 0 }]} testID={`transfer-${h.habit}`}>
      <View style={[styles.band, { backgroundColor: hue.hue }]} />
      <Text style={styles.habit} numberOfLines={1}>{habitTitle(h.habit, h.label)}</Text>
      <Text style={styles.role}>{habitRole(h)}</Text>
      <View style={styles.nums}>
        <View style={styles.beforeCol}>
          <Text style={[styles.before, !r.before && styles.none]}>{r.before ?? '–'}</Text>
        </View>
        <Text style={styles.arrow}>→</Text>
        <View>
          {/* no number yet: a short dash at the before numeral's size and baseline, never a bar the width of "0.0" */}
          {/* the outcome sets its weight: the habit's hue only for a drop, a quiet numeral for anything else */}
          <Text style={[styles.after, r.after ? (good ? { color: hue.hue } : styles.afterQuiet) : styles.afterNone]}>{r.after ?? '–'}</Text>
        </View>
      </View>
      {/* every number says its window: the before column is fixed, so the labels line up under their numbers */}
      <View style={styles.numLabels}>
        <Text style={[styles.numLabel, styles.beforeCol]} numberOfLines={2}>{BEFORE_WINDOW}</Text>
        <View style={styles.arrowGap} />
        <Text style={styles.numLabel} numberOfLines={1}>{AFTER_WINDOW}</Text>
      </View>
      {/* no pill on a habit still to practise: an empty slot of the same size keeps the cards' numbers level */}
      <View testID={`verdict-${h.habit}`} style={[styles.pill, good ? styles.pillGood : bad ? styles.pillBad : styles.pillWait, pill === null && styles.pillNone]}>
        <Text style={[styles.pillText, { color: good ? C.limeInk : bad ? C.coralInk : C.text }]}>{pill ?? ' '}</Text>
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
  // one row height whatever the numeral's size, so the cards' titles stay level
  nums: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 156, marginTop: SP.xl },
  // numerals: no negative letter spacing (Vega draws a sliver beside the first glyph)
  before: { color: C.dim, fontSize: 84, lineHeight: 96, fontWeight: '600', fontFamily: F.family },
  beforeCol: { width: 170 },
  numLabels: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 2 },
  arrowGap: { width: 56 + SP.m * 2 },
  none: { color: C.faint },
  arrow: { width: 56, textAlign: 'center', color: C.faint, fontSize: 56, marginHorizontal: SP.m, marginBottom: 14, fontFamily: F.family },
  after: { fontSize: 148, lineHeight: 156, fontWeight: '700', fontFamily: F.family },
  afterNone: { color: C.faint, fontSize: 84, lineHeight: 96, minWidth: 120 },
  afterQuiet: { color: C.text, fontSize: 112, lineHeight: 124 },
  numLabel: { color: C.dim, fontSize: T.label, lineHeight: 30, fontFamily: F.family },
  pill: { alignSelf: 'flex-start', borderRadius: R.pill, paddingHorizontal: SP.l, paddingVertical: SP.s, marginTop: SP.l },
  pillGood: { backgroundColor: C.lime },
  pillBad: { backgroundColor: C.coral },
  // undecided (needs more speech, not practised yet, no change): a quiet outlined pill, never a verdict colour
  pillWait: { backgroundColor: 'rgba(255,240,220,0.08)', borderWidth: 2, borderColor: 'rgba(255,240,220,0.28)', paddingVertical: SP.s - 2 },
  pillNone: { opacity: 0 },
  pillText: { fontSize: T.body, fontWeight: '700', fontFamily: F.family },
  details: { flex: 1, marginTop: SP.l, backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.m },
  // a small inset: the focused button grows a little and must not touch the clip edge
  foot: { flexDirection: 'row', alignItems: 'center', marginTop: SP.m, paddingLeft: SP.xs },
  note: { flexShrink: 1, color: C.dim, fontSize: T.small, marginLeft: SP.l, fontFamily: F.family },
  debug: { color: C.faint, fontSize: 20, marginTop: SP.xs, fontFamily: F.mono },
});
