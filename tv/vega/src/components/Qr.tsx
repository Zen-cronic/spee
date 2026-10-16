import QRCode from 'qrcode';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

/** QR from RN Views only (no canvas/SVG), so it ports to Vega unchanged. */
export function Qr({ value, size = 360 }: { value: string; size?: number }) {
  const { rows, n } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const rows: boolean[][] = [];
    for (let r = 0; r < n; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < n; c++) row.push(!!qr.modules.get(r, c));
      rows.push(row);
    }
    return { rows, n };
  }, [value]);
  const quiet = 4;
  const cell = Math.floor(size / (n + quiet * 2));
  return (
    <View testID="qr" style={[styles.wrap, { padding: cell * quiet }]}>
      {rows.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((on, c) => (
            <View key={c} style={{ width: cell, height: cell, backgroundColor: on ? '#000' : '#fff' }} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { backgroundColor: '#fff', borderRadius: 16, alignSelf: 'flex-start' }, row: { flexDirection: 'row' } });
