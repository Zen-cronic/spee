import { StyleSheet, Text, View } from 'react-native';
import { PairingQr } from 'vega-voice-bridge/react';
import { useDebug } from '../debug';
import type { LinkStatus } from '../mirror/useMirror';
import { C, F, R, SP, T } from '../theme';

/** Pair a phone: the QR carries welcome.joinUrl (/p/<code>?k=...), plus the 4-character code. */
export function PairingView({ code, joinUrl, status, mics }: { code: string | null; joinUrl: string | null; status: LinkStatus; mics: number }) {
  const debug = useDebug();
  const statusText = status === 'online' ? (mics ? `${mics} phone${mics > 1 ? 's' : ''} paired` : 'Waiting for your phone…') : status === 'offline' ? 'Hub offline, retrying…' : 'Connecting…';
  return (
    <View style={styles.wrap} testID="view-pairing">
      <View style={styles.left}>
        <Text style={styles.h1}>Pair your phone.</Text>
        <Text style={styles.sub}>Your phone becomes the microphone when you practise.</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: mics ? C.lime : C.faint }]} />
          <Text style={[styles.status, mics ? { color: C.text } : null]}>{statusText}</Text>
        </View>
      </View>
      <View style={styles.right}>
        <View style={styles.qrCard}>
          {joinUrl ? <PairingQr value={joinUrl} size={420} testID="qr" style={{ borderRadius: 16, alignSelf: 'center' }} /> : <View style={styles.qrEmpty} />}
          <Text style={styles.scan}>Scan with your phone camera</Text>
          <View style={styles.codeRow}>
            <Text style={styles.codeLabel}>or enter</Text>
            <Text testID="pair-code" style={styles.code}>{code ?? '····'}</Text>
          </View>
        </View>
        {debug ? <Text testID="join-url" style={styles.debug} numberOfLines={2}>{joinUrl ?? 'no join URL yet'}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  left: { flex: 1, paddingRight: SP.xxl, justifyContent: 'center' },
  right: { width: 640, alignItems: 'center', justifyContent: 'center' },
  h1: { color: C.text, fontSize: 96, lineHeight: 108, fontWeight: '700', fontFamily: F.family },
  sub: { color: C.dim, fontSize: T.title, lineHeight: 50, marginTop: SP.m, maxWidth: 800, fontFamily: F.family },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: SP.xxl },
  dot: { width: 16, height: 16, borderRadius: 8, marginRight: SP.s },
  status: { color: C.dim, fontSize: T.body, fontFamily: F.family },
  qrCard: { width: 600, backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xxl, paddingVertical: SP.xl, alignItems: 'center' },
  qrEmpty: { width: 420, height: 420, backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: R.m },
  scan: { color: C.ink, fontSize: T.body, fontWeight: '600', marginTop: SP.l, fontFamily: F.family },
  codeRow: { flexDirection: 'row', alignItems: 'center', marginTop: SP.s },
  codeLabel: { color: C.inkDim, fontSize: T.body, marginRight: SP.m, fontFamily: F.family },
  code: { color: C.ink, fontSize: 72, fontWeight: '800', letterSpacing: 12, lineHeight: 84, paddingLeft: 12, fontFamily: F.family },
  debug: { color: C.faint, fontSize: T.label, marginTop: SP.s, textAlign: 'center', fontFamily: F.family },
});
