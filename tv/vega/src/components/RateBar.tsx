import { StyleSheet, View } from 'react-native';
import { frac } from '../mirror/format';
import { C } from '../theme';

/**
 * A horizontal rate bar on a 0..max axis with its 95% interval as a whisker. RN Views only, so it
 * draws the same on react-native-web and on Vega.
 */
export function RateBar({ value, ci, max, color, width, height = 30, testID }: { value: number; ci?: [number, number] | null; max: number; color: string; width: number; height?: number; testID?: string }) {
  const w = frac(value, max) * width;
  const lo = ci ? frac(ci[0], max) * width : 0;
  const hi = ci ? frac(ci[1], max) * width : 0;
  return (
    <View testID={testID} style={[styles.track, { width, height }]}>
      <View style={[styles.fill, { width: Math.max(4, w), height, backgroundColor: color }]} />
      {ci ? (
        <>
          <View style={[styles.whisker, { left: lo, width: Math.max(2, hi - lo), top: height / 2 - 2 }]} />
          <View style={[styles.cap, { left: lo - 2, top: height / 2 - 12 }]} />
          <View style={[styles.cap, { left: hi - 2, top: height / 2 - 12 }]} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 6, overflow: 'visible' },
  fill: { position: 'absolute', left: 0, top: 0, borderRadius: 6, opacity: 0.9 },
  whisker: { position: 'absolute', height: 4, backgroundColor: C.text, opacity: 0.85 },
  cap: { position: 'absolute', width: 4, height: 24, backgroundColor: C.text, borderRadius: 2 },
});
