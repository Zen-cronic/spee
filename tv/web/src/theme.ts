import { StyleSheet } from 'react-native';
import { F } from './platform/fonts';

/**
 * Design tokens for the 10-foot UI (1920x1080 stage, read from about 3 m). Shared verbatim by the
 * web TV and the Vega app (npm run tv:sync); only the font family differs (platform/fonts.ts).
 *
 * Navy ground; mint for "better / pass / dropped"; coral for "worse / fail / nudge"; lavender only
 * for "verified by Bee" (Bee is the input of record); amber for waiting states.
 */
export const C = {
  bg: '#0b1430',
  surface: '#121d40',
  surface2: '#1a2752',
  line: '#2b3b6e',
  text: '#f3f6ff',
  dim: '#aab5d8',
  faint: '#7380aa',
  mint: '#5ef2c2',
  mintInk: '#03261c',
  mintBg: '#0f3b3a',
  coral: '#ff7b6b',
  coralInk: '#2e0b07',
  coralBg: '#3f1f33',
  lavender: '#bba8ff',
  lavenderInk: '#1a1040',
  lavenderBg: '#2a2360',
  amber: '#ffc866',
  amberBg: '#3a2f1e',
  focus: '#ffffff', // remote focus ring: never used for anything else
  rule: 'rgba(255,255,255,0.10)',
};

/** Type scale. Fire TV guidance: body text at least 28 px at 1080p. Only labels use 24 px. */
export const T = { hero: 156, big: 96, h1: 56, h2: 44, title: 38, body: 30, small: 28, label: 24 };
/** Overscan safe zone: nothing within the outer 5% of the 1920x1080 stage. */
export const SAFE = { x: 96, y: 54 };
export const SP = { xs: 8, s: 12, m: 20, l: 28, xl: 40, xxl: 64 };
export const R = { s: 10, m: 16, l: 24, pill: 999 };
export { F };

export const S = StyleSheet.create({
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '800', letterSpacing: 3, fontFamily: F.family },
  card: { backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.l, paddingVertical: SP.m },
  footnote: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  body: { color: C.text, fontSize: T.body, fontFamily: F.family },
  dim: { color: C.dim, fontSize: T.small, fontFamily: F.family },
});
