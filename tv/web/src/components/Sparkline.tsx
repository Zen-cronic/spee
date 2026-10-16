import { StyleSheet, View } from 'react-native';
import { C } from '../theme';

/**
 * Dots on a fixed min..max axis (null points leave a gap), drawn with RN Views only. Used for the
 * pitch trace (in semitones) and the level trace (in dBFS).
 */
export function Sparkline({ points, min, max, width, height, color, dot = 10, slots, testID }: { points: (number | null)[]; min: number; max: number; width: number; height: number; color: string; dot?: number; slots?: number; testID?: string }) {
  const n = Math.max(slots ?? points.length, 2);
  const step = width / n;
  const start = n - points.length;
  return (
    <View testID={testID} style={[styles.box, { width, height }]}>
      {[0.25, 0.5, 0.75].map((g) => (
        <View key={g} style={[styles.grid, { top: g * height, width }]} />
      ))}
      {points.map((v, i) => {
        if (v === null || !Number.isFinite(v)) return null;
        const y = (1 - Math.max(0, Math.min(1, (v - min) / (max - min)))) * (height - dot);
        return <View key={i} style={[styles.dot, { left: (start + i) * step + step / 2 - dot / 2, top: y, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, overflow: 'hidden' },
  grid: { position: 'absolute', left: 0, height: 1, backgroundColor: C.rule },
  dot: { position: 'absolute' },
});
