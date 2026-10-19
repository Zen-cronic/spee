import { StyleSheet, Text, View } from 'react-native';
import { PairingQr } from 'tv-voice-bridge/react';
import { TAGLINE } from '../brand';
import { useDebug } from '../debug';
import type { LinkStatus } from '../mirror/useMirror';
import { C, F, R, SP, T } from '../theme';

const STEPS = [
  'Scan the code with your phone camera (same Wi-Fi, or the shared link)',
  'Drill: say the fixed sentence; Bee confirms what you really said',
  'Practice: talk for 30 seconds and watch your voice here',
];

/** Pair a phone: the QR carries welcome.joinUrl (/p/<code>?k=...), plus the 4-character code. */
export function PairingView({ code, joinUrl, status, mics }: { code: string | null; joinUrl: string | null; status: LinkStatus; mics: number }) {
  const debug = useDebug();
  const statusText = status === 'online' ? (mics ? `${mics} phone${mics > 1 ? 's' : ''} paired` : 'Waiting for a phone…') : status === 'offline' ? 'Hub offline, retrying…' : 'Connecting to the hub…';
  return (
    <View style={styles.wrap} testID="view-pairing">
      <View style={styles.left}>
        <Text style={styles.h1}>{'Pair your phone.\nIt becomes the microphone.'}</Text>
        <Text style={styles.tagline}>{TAGLINE}</Text>
        {STEPS.map((s, i) => (
          <View key={i} style={styles.stepRow}>
            <Text style={styles.stepNum}>{String(i + 1)}</Text>
            <Text style={styles.step}>{s}</Text>
          </View>
        ))}
      </View>
      <View style={styles.right}>
        <View style={styles.qrCard}>
          {joinUrl ? <PairingQr value={joinUrl} size={400} testID="qr" style={{ borderRadius: 16, alignSelf: 'flex-start' }} /> : <View style={styles.qrEmpty} />}
          <Text style={styles.codeLabel}>OR ENTER THE CODE</Text>
          <Text testID="pair-code" style={styles.code}>{code ?? '····'}</Text>
        </View>
        <Text style={[styles.status, mics ? { color: C.mint } : null]}>{statusText}</Text>
        {debug ? <Text testID="join-url" style={styles.debug} numberOfLines={2}>{joinUrl ?? 'no join URL yet'}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  left: { flex: 1, paddingRight: SP.xxl, justifyContent: 'center' },
  right: { width: 600, alignItems: 'center', justifyContent: 'center' },
  h1: { color: C.text, fontSize: 64, fontWeight: '800', lineHeight: 76, fontFamily: F.family },
  tagline: { color: C.dim, fontSize: T.body, marginTop: SP.m, marginBottom: SP.xl, fontFamily: F.family },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SP.m },
  stepNum: { width: 52, height: 52, borderRadius: 26, borderWidth: 2, borderColor: C.mint, color: C.mint, fontSize: T.small, fontWeight: '900', textAlign: 'center', lineHeight: 48, marginRight: SP.m, overflow: 'hidden', fontFamily: F.family },
  step: { flex: 1, color: C.dim, fontSize: T.body, fontFamily: F.family },
  qrCard: { backgroundColor: C.surface, borderRadius: R.l, padding: SP.l, alignItems: 'center' },
  qrEmpty: { width: 400, height: 400, backgroundColor: C.surface2, borderRadius: R.m },
  codeLabel: { color: C.dim, fontSize: T.label, letterSpacing: 4, fontWeight: '800', marginTop: SP.m, fontFamily: F.family },
  code: { color: C.text, fontSize: 104, fontWeight: '800', letterSpacing: 22, lineHeight: 116, paddingLeft: 22, fontFamily: F.family },
  status: { color: C.dim, fontSize: T.small, marginTop: SP.m, fontFamily: F.family },
  debug: { color: C.lavender, fontSize: T.label, marginTop: SP.s, textAlign: 'center', fontFamily: F.family },
});
