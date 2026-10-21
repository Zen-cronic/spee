import { View } from 'react-native';
import { C } from '../theme';

/**
 * The Spee mark, "two voices": your speech bubble and its reflection (the one Bee
 * checked, in the bee colour) across a mirror bar, the reflection sitting lower (call and answer).
 * Plain Views, no SVG, so it is the same on the web TV and on Vega.
 *
 * Geometry from the approved logo board (brandmark-recipe.json; 1 unit = 1 stage px at that size).
 * The small master is for 16, 24 and 32 (square tail corners, heavier bar); the large master for 48
 * and up (tail corners slightly softened). Each bubble's tail is the corner that faces the bar: the
 * left bubble's bottom-right, the right bubble's top-left. Use the sizes listed; never scale a View.
 */
type Spec = { bw: number; bh: number; t: number; lx: number; ly: number; rx: number; ry: number; barX: number; barY: number; barW: number; barH: number };

export const MARK_SPECS: Record<16 | 24 | 32 | 48 | 64 | 128, Spec> = {
  16: { bw: 6, bh: 5, t: 0, lx: 0, ly: 4, rx: 10, ry: 7, barX: 7, barY: 3, barW: 2, barH: 10 },
  24: { bw: 9, bh: 8, t: 0, lx: 0, ly: 5, rx: 15, ry: 10, barX: 10, barY: 4, barW: 4, barH: 15 },
  32: { bw: 12, bh: 10, t: 0, lx: 0, ly: 8, rx: 20, ry: 14, barX: 14, barY: 6, barW: 4, barH: 20 },
  48: { bw: 18, bh: 15, t: 1.5, lx: 2.25, ly: 11.25, rx: 27.75, ry: 21.75, barX: 22.5, barY: 8.25, barW: 3, barH: 31.5 },
  64: { bw: 24, bh: 20, t: 2, lx: 3, ly: 15, rx: 37, ry: 29, barX: 30, barY: 11, barW: 4, barH: 42 },
  128: { bw: 48, bh: 40, t: 4, lx: 6, ly: 30, rx: 74, ry: 58, barX: 60, barY: 22, barW: 8, barH: 84 },
};

/**
 * `you` is the left bubble and the bar; `bee` is the reflection, the product's "checked by Bee" colour.
 * Dark: lime and the bee colour on the espresso ground. Light: olive and the bee mark colour on paper.
 */
export const MARK_TONES = {
  dark: { you: C.lime, bee: C.bee },
  light: { you: C.limeOnLight, bee: C.beeOnLight },
};

export function BrandMark({ size = 48, tone = 'dark' }: { size?: keyof typeof MARK_SPECS; tone?: keyof typeof MARK_TONES }) {
  const s = MARK_SPECS[size];
  const c = MARK_TONES[tone];
  const r = s.bh / 2;
  return (
    <View testID="brand-mark" style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: s.lx,
          top: s.ly,
          width: s.bw,
          height: s.bh,
          backgroundColor: c.you,
          borderTopLeftRadius: r,
          borderTopRightRadius: r,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: s.t,
        }}
      />
      <View style={{ position: 'absolute', left: s.barX, top: s.barY, width: s.barW, height: s.barH, borderRadius: s.barW / 2, backgroundColor: c.you }} />
      <View
        style={{
          position: 'absolute',
          left: s.rx,
          top: s.ry,
          width: s.bw,
          height: s.bh,
          backgroundColor: c.bee,
          borderTopLeftRadius: s.t,
          borderTopRightRadius: r,
          borderBottomRightRadius: r,
          borderBottomLeftRadius: r,
        }}
      />
    </View>
  );
}
