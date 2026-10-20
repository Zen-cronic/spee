import { StyleSheet, Text, View } from 'react-native';
import { Chip } from '../components/Chip';
import { Sparkline } from '../components/Sparkline';
import { useDebug } from '../debug';
import { dbFrac, FLAG_LABEL, fmt1, fmtInt, fmtMs, fmtPct } from '../mirror/format';
import { PRACTICE_HISTORY, type PracticeSlice } from '../mirror/reducer';
import { C, F, R, SP, T } from '../theme';

const VOL_W = 520;
const TRACE_W = 900;
const QUIET = -35;
const LOUD = -12;
// pitch axis in semitones above 70 Hz: 70 Hz .. 400 Hz is about 30 semitones
const st = (hz: number) => 12 * Math.log2(hz / 70);
const BAND_WORD = { quiet: 'A bit quiet', ok: 'Good volume', loud: 'A bit loud' } as const;

/**
 * Practice: the phone's mic meters, live. Pace, volume and pauses on the paper card; the melody
 * (pitch over the last 5 s) on the dark card; then the take summary in plain words. Measured on the
 * phone and provisional: Bee stays the input of record for real speech (and stores no audio, so
 * pitch exists only here). Raw dBFS, Hz and voiced share show only in debug.
 */
export function PracticeView({ p, code, mics }: { p: PracticeSlice; code: string | null; mics: number }) {
  const debug = useDebug();
  const m = p.latest;
  const s = p.summary;
  if (!m && !s) {
    return (
      <View style={styles.wrap} testID="view-practice">
        <View style={styles.idle}>
          <Text style={styles.kicker}>Practice</Text>
          <Text style={styles.idleTitle}>Talk for 30 seconds and watch your voice here.</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.idleHint}>{mics ? 'Your phone is paired. Tap Practice, then Start.' : `Pair a phone first: the Pair phone tab, or code ${code ?? '····'}.`}</Text>
          <Text style={styles.idleNote}>Measured on your phone. Nothing is recorded.</Text>
        </View>
      </View>
    );
  }
  // Once the take's summary is in, it wins over the last meter frame (no stale "N s into the take").
  const done = !!s && (!p.takeId || s.takeId === p.takeId);
  const db = m?.rmsDbfs ?? -100;
  const band = m?.band ?? 'quiet';
  const pitch = p.history.map((h) => (h.pitchHz === null ? null : st(h.pitchHz)));
  const wpm = done ? (s!.rate.wpm ?? null) : (m?.wpm ?? s?.rate.wpm ?? null);
  const pauses = done ? s!.pauses.count : (m?.pause.count ?? s?.pauses.count ?? 0);
  const range = done ? s!.pitch.rangeSt : (m?.pitchRangeSt ?? null);
  const flat = done ? s!.pitch.monotone : !!m?.monotone;
  // the volume block stays after the take: the take's average level, worded from the hub's own flags
  const level = done ? s!.volume.meanDbfs : db;
  const lvBand: keyof typeof BAND_WORD = done ? (s!.flags.includes('quiet') ? 'quiet' : s!.flags.includes('loud') ? 'loud' : 'ok') : band;
  return (
    <View style={styles.wrap} testID="view-practice">
      <View style={styles.row}>
        <View style={styles.paper}>
          <Text style={styles.kicker}>{done ? `Take finished · ${fmtMs(s!.durationMs)}` : m ? `${fmtMs(m.t)} into your take` : 'Practice'}</Text>
          <Text style={styles.big}>{fmtInt(wpm)}</Text>
          <Text style={styles.bigLabel}>words a minute</Text>
          <View style={{ flex: 1 }} />
          <View>
            <Text style={styles.label}>{done ? `${BAND_WORD[lvBand]} overall` : BAND_WORD[band]}</Text>
            <View style={[styles.volTrack, { width: VOL_W }]}>
              <View style={[styles.zone, { left: dbFrac(QUIET) * VOL_W, width: (dbFrac(LOUD) - dbFrac(QUIET)) * VOL_W }]} />
              <View style={[styles.volFill, { width: Math.max(8, dbFrac(level) * VOL_W) }]} />
            </View>
          </View>
          <View style={styles.pauseRow}>
            <Text style={[styles.pauseNum, !done && m?.pause.active && { color: C.ink }]}>{String(pauses)}</Text>
            <Text style={styles.pauseLabel}>{`pause${pauses === 1 ? '' : 's'}${!done && m?.pause.active ? ' · pausing now' : ''}`}</Text>
          </View>
          <Text style={styles.note}>Measured on your phone</Text>
        </View>
        <View style={styles.dark}>
          <Text style={styles.darkTitle}>Your melody</Text>
          <Text style={styles.darkSub}>the last 5 seconds</Text>
          <View style={styles.chart}>
            <Sparkline testID="pitch-trace" points={pitch} min={0} max={30} width={TRACE_W} height={400} color={C.lime} slots={PRACTICE_HISTORY} dot={16} />
          </View>
          <Text style={[styles.melody, flat && { color: C.coral }]}>{range === null ? '' : flat ? 'Flat. Let your voice move more.' : `Lively: a ${fmt1(range)}-semitone range.`}</Text>
          {debug && m ? <Text style={styles.debug}>{`${fmt1(db)} dBFS · ${m.pitchHz ? `${fmtInt(m.pitchHz)} Hz` : 'unvoiced'} · range ${fmt1(m.pitchRangeSt)} st`}</Text> : null}
        </View>
      </View>
      {p.caption && !s ? (
        <View style={styles.caption}>
          <Text style={styles.captionText} numberOfLines={1}>{`“${p.caption}”`}</Text>
        </View>
      ) : null}
      {s ? (
        <View style={styles.summary} testID="practice-summary">
          <View style={styles.flags}>{s.flags.length ? s.flags.map((f) => <Chip key={f} text={FLAG_LABEL[f]} tone={f === 'fast' || f === 'slow' ? 'neutral' : 'bad'} big />) : <Chip text="Nice take" tone="good" big />}</View>
          <Text style={styles.summaryText} numberOfLines={1}>{takeSentence(s)}</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.summaryNext} numberOfLines={1}>Tap Start on your phone for another</Text>
          {debug ? <Text style={styles.debug}>{`${fmt1(s.volume.meanDbfs)} dBFS mean · pitch ${s.pitch.medianHz ?? '–'} Hz · ${fmt1(s.pauses.perMin)} pauses/min · voiced ${fmtPct(s.pitch.voicedShare)}`}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** The take in one plain sentence, from the summary's own flags and counts ("Steady pace, a lively melody, 2 pauses."). */
function takeSentence(s: NonNullable<PracticeSlice['summary']>): string {
  const pace = s.flags.includes('fast') ? 'A bit fast' : s.flags.includes('slow') ? 'A bit slow' : 'Steady pace';
  const melody = s.pitch.monotone ? 'a flat melody' : 'a lively melody';
  const pauses = `${s.pauses.count} pause${s.pauses.count === 1 ? '' : 's'}`;
  return `${pace}, ${melody}, ${pauses}.`;
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  idle: { flex: 1, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xxl },
  idleTitle: { color: C.ink, fontSize: 72, lineHeight: 84, fontWeight: '700', marginTop: SP.l, maxWidth: 1300, fontFamily: F.family },
  idleHint: { color: C.ink, fontSize: T.title, fontWeight: '600', fontFamily: F.family },
  idleNote: { color: C.inkDim, fontSize: T.body, marginTop: SP.s, fontFamily: F.family },
  paper: { width: 660, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl, marginRight: SP.l },
  kicker: { color: C.inkDim, fontSize: T.body, fontWeight: '600', fontFamily: F.family },
  big: { color: C.ink, fontSize: T.hero, lineHeight: 210, fontWeight: '700', letterSpacing: -2, marginTop: SP.s, fontFamily: F.family },
  bigLabel: { color: C.ink, fontSize: T.h2, fontWeight: '600', marginTop: -SP.s, fontFamily: F.family },
  label: { color: C.ink, fontSize: T.body, fontWeight: '600', marginBottom: SP.s, fontFamily: F.family },
  volTrack: { height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.08)', overflow: 'hidden' },
  zone: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.08)' },
  volFill: { position: 'absolute', left: 0, top: 0, height: 22, borderRadius: 11, backgroundColor: C.ink },
  pauseRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: SP.l },
  pauseNum: { color: C.ink, fontSize: 64, fontWeight: '700', fontFamily: F.family },
  pauseLabel: { color: C.inkDim, fontSize: T.body, marginLeft: SP.s, fontFamily: F.family },
  note: { color: C.inkFaint, fontSize: T.label, marginTop: SP.s, fontFamily: F.family },
  dark: { flex: 1, backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl },
  darkTitle: { color: C.text, fontSize: T.title, fontWeight: '700', fontFamily: F.family },
  darkSub: { color: C.dim, fontSize: T.body, marginTop: 4, fontFamily: F.family },
  chart: { flex: 1, justifyContent: 'center' },
  melody: { color: C.text, fontSize: T.title, fontWeight: '600', fontFamily: F.family },
  caption: { backgroundColor: C.surface, borderRadius: R.m, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginTop: SP.m },
  captionText: { color: C.text, fontSize: T.title, fontStyle: 'italic', fontFamily: F.family },
  summary: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.m, paddingHorizontal: SP.xl, paddingVertical: SP.m, marginTop: SP.m },
  flags: { flexDirection: 'row', gap: SP.s, marginRight: SP.l },
  summaryText: { flexShrink: 1, color: C.text, fontSize: T.title, fontWeight: '600', fontFamily: F.family },
  summaryNext: { color: C.dim, fontSize: T.small, marginLeft: SP.l, fontFamily: F.family },
  debug: { color: C.faint, fontSize: 20, marginTop: SP.s, marginLeft: SP.l, fontFamily: F.mono },
});
