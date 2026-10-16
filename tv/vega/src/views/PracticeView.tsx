import { StyleSheet, Text, View } from 'react-native';
import { Chip } from '../components/Chip';
import { Sparkline } from '../components/Sparkline';
import { dbFrac, FLAG_LABEL, fmt1, fmtInt, fmtMs, fmtPct } from '../mirror/format';
import { PRACTICE_HISTORY, type PracticeSlice } from '../mirror/reducer';
import { C, F, R, SP, T } from '../theme';

const VOL_W = 900;
const QUIET = -35;
const LOUD = -12;
// pitch axis in semitones above 70 Hz: 70 Hz .. 400 Hz is about 30 semitones
const st = (hz: number) => 12 * Math.log2(hz / 70);

/**
 * Practice: the phone's mic meters, live. Volume band, the pitch trace over the last 5 s with its
 * range in semitones, the rate, the pauses and the speaker's own interim words. Phone-measured,
 * provisional: Bee stays the input of record for real speech (and stores no audio, so pitch and
 * tone exist only here).
 */
export function PracticeView({ p, code, mics }: { p: PracticeSlice; code: string | null; mics: number }) {
  const m = p.latest;
  const s = p.summary;
  if (!m && !s) {
    return (
      <View style={styles.wrap} testID="view-practice">
        <Text style={styles.kicker}>PRACTICE · PHONE MIC</Text>
        <Text style={styles.idle}>Open Practice on your phone and talk for 30 seconds.</Text>
        <Text style={styles.hint}>{mics ? `${mics} phone${mics > 1 ? 's' : ''} paired. Tap Practice, then Start.` : `Pair a phone first: Pair phone tab, or code ${code ?? '····'}.`}</Text>
        <Text style={styles.hint}>The phone measures volume, pitch, rate and pauses on the device and sends only the numbers (10 per second) to this screen. Nothing is recorded or saved.</Text>
      </View>
    );
  }
  const db = m?.rmsDbfs ?? -100;
  const band = m?.band ?? 'quiet';
  const bandColor = band === 'ok' ? C.mint : band === 'loud' ? C.coral : C.amber;
  const pitch = p.history.map((h) => (h.pitchHz === null ? null : st(h.pitchHz)));
  const level = p.history.map((h) => Math.max(-60, h.rmsDbfs));
  return (
    <View style={styles.wrap} testID="view-practice">
      <View style={styles.rowBetween}>
        <Text style={styles.kicker}>{`PRACTICE · PHONE MIC · ${m ? `${fmtMs(m.t)} into the take` : 'take finished'}`}</Text>
        <Chip text="PROVISIONAL · PHONE-MEASURED" tone="wait" />
      </View>
      <View style={styles.top}>
        <View style={styles.left}>
          <Text style={styles.section}>VOLUME</Text>
          <View style={styles.volRow}>
            <View style={[styles.volTrack, { width: VOL_W }]}>
              <View style={[styles.zone, { left: dbFrac(QUIET) * VOL_W, width: (dbFrac(LOUD) - dbFrac(QUIET)) * VOL_W }]} />
              <View style={[styles.volFill, { width: Math.max(6, dbFrac(db) * VOL_W), backgroundColor: bandColor }]} />
            </View>
            <Text style={[styles.band, { color: bandColor }]}>{band.toUpperCase()}</Text>
          </View>
          <Text style={styles.small}>{`${fmt1(db)} dBFS · ok between ${QUIET} and ${LOUD}`}</Text>
          <Text style={[styles.section, { marginTop: SP.l }]}>PITCH · LAST 5 S</Text>
          <Sparkline testID="pitch-trace" points={pitch} min={0} max={30} width={VOL_W} height={180} color={C.lavender} slots={PRACTICE_HISTORY} dot={14} />
          <View style={styles.pitchRow}>
            <Text style={styles.small}>{m?.pitchHz ? `${fmtInt(m.pitchHz)} Hz now` : 'unvoiced'}</Text>
            <Text style={[styles.small, m?.monotone && { color: C.coral }]}>{m ? `range ${fmt1(m.pitchRangeSt)} semitones${m.monotone ? ' · flat: vary your melody' : ''}` : ''}</Text>
          </View>
          <Sparkline points={level} min={-60} max={0} width={VOL_W} height={56} color={C.dim} slots={PRACTICE_HISTORY} dot={8} />
        </View>
        <View style={styles.right}>
          <View style={styles.card}>
            <Text style={styles.section}>RATE</Text>
            <Text style={styles.big}>{fmtInt(m?.wpm ?? s?.rate.wpm ?? null)}</Text>
            <Text style={styles.small}>words / min (from syllables, last 5 s)</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.section}>PAUSES</Text>
            <Text style={[styles.big, m?.pause.active && { color: C.mint }]}>{String(m?.pause.count ?? s?.pauses.count ?? 0)}</Text>
            <Text style={styles.small}>{m?.pause.active ? `pausing ${fmtMs(m.pause.currentMs)}` : 'of 250 ms or more'}</Text>
          </View>
        </View>
      </View>
      {p.caption && !s ? (
        <View style={styles.caption}>
          <Text style={styles.captionText} numberOfLines={2}>{p.caption}</Text>
        </View>
      ) : null}
      {s ? (
        <View style={styles.summary} testID="practice-summary">
          <Text style={styles.section}>{`TAKE SUMMARY · ${fmtMs(s.durationMs)}`}</Text>
          <View style={styles.sumRow}>
            <Text style={styles.sumItem}>{`${fmt1(s.volume.meanDbfs)} dBFS mean`}</Text>
            <Text style={styles.sumItem}>{`pitch ${s.pitch.medianHz ?? '–'} Hz, range ${fmt1(s.pitch.rangeSt)} st`}</Text>
            <Text style={styles.sumItem}>{`${fmtInt(s.rate.wpm)} wpm`}</Text>
            <Text style={styles.sumItem}>{`${s.pauses.count} pause${s.pauses.count === 1 ? '' : 's'} (${fmt1(s.pauses.perMin)}/min)`}</Text>
            <Text style={styles.sumItem}>{`voiced ${fmtPct(s.pitch.voicedShare)}`}</Text>
          </View>
          <View style={styles.flags}>
            {s.flags.length ? s.flags.map((f) => <Chip key={f} text={FLAG_LABEL[f]} tone={f === 'fast' || f === 'slow' ? 'wait' : 'bad'} />) : <Chip text="NOTHING FLAGGED" tone="good" />}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  section: { color: C.faint, fontSize: 22, fontWeight: '800', letterSpacing: 3, marginBottom: SP.xs, fontFamily: F.family },
  idle: { color: C.text, fontSize: T.h1, fontWeight: '800', marginTop: SP.xl, maxWidth: 1400, fontFamily: F.family },
  hint: { color: C.dim, fontSize: T.body, lineHeight: 42, marginTop: SP.m, maxWidth: 1400, fontFamily: F.family },
  top: { flexDirection: 'row', marginTop: SP.m },
  left: { width: VOL_W + 180 },
  right: { flex: 1, marginLeft: SP.xl },
  volRow: { flexDirection: 'row', alignItems: 'center' },
  volTrack: { height: 56, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 10, overflow: 'hidden' },
  zone: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(94,242,194,0.10)' },
  volFill: { position: 'absolute', left: 0, top: 10, height: 36, borderRadius: 8 },
  band: { fontSize: T.title, fontWeight: '900', marginLeft: SP.m, fontFamily: F.family },
  small: { color: C.dim, fontSize: T.label, marginTop: 6, fontFamily: F.family },
  pitchRow: { flexDirection: 'row', justifyContent: 'space-between', width: VOL_W, marginBottom: SP.s },
  card: { backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.l, paddingVertical: SP.m, marginBottom: SP.m },
  big: { color: C.text, fontSize: 128, fontWeight: '800', lineHeight: 140, paddingHorizontal: 14, marginLeft: -14, fontFamily: F.family },
  caption: { backgroundColor: C.surface2, borderRadius: R.m, paddingHorizontal: SP.l, paddingVertical: SP.m, marginTop: SP.s },
  captionText: { color: C.text, fontSize: T.title, fontStyle: 'italic', fontFamily: F.family },
  summary: { backgroundColor: C.surface, borderRadius: R.l, padding: SP.l, marginTop: SP.m },
  sumRow: { flexDirection: 'row', flexWrap: 'wrap' },
  sumItem: { color: C.text, fontSize: T.small, marginRight: SP.xl, fontFamily: F.family },
  flags: { flexDirection: 'row', marginTop: SP.s, gap: SP.s },
});
