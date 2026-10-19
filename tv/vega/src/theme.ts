import { StyleSheet } from 'react-native';
import { F } from './platform/fonts';

/**
 * Design tokens for the 10-foot UI (1920x1080 stage, read from about 3 m). Shared verbatim by the
 * web TV and the Vega app (npm run tv:sync); only the font family differs (platform/fonts.ts).
 *
 * Warm charcoal ground; one paper card per screen carries the hero. Two accents only: lime for
 * "the thing to do / better / pass", lavender only for "checked by Bee" (Bee is the input of
 * record). Coral is kept for a fail or a wrist nudge; amber only for a lost hub connection.
 */
export const C = {
  bg: '#121211',
  surface: '#1d1d1b',
  surface2: '#282825',
  line: '#34332f',
  text: '#f4f3ed',
  dim: '#abaaa2',
  faint: '#7a7972',
  paper: '#eeede6',
  ink: '#131312',
  inkDim: '#5f5e58',
  inkFaint: '#8c8b84',
  lime: '#d7f26a',
  limeInk: '#1a2006',
  limeBg: '#2a3114',
  lavender: '#bbaef7',
  lavenderInk: '#1d1640',
  lavenderBg: '#2b2748',
  coral: '#f2876e',
  coralInk: '#2e0f08',
  coralBg: '#3a241e',
  amber: '#e9c46a',
  amberBg: '#3a301c',
  // older names, kept so per-app files read the same palette
  mint: '#d7f26a',
  mintInk: '#1a2006',
  mintBg: '#2a3114',
  focus: '#ffffff', // remote focus ring: never used for anything else
  rule: 'rgba(255,255,255,0.08)',
};

/** Type scale. Fire TV guidance: body text at least 28 px at 1080p. Only labels use 24 px. */
export const T = { hero: 200, big: 120, h1: 64, h2: 46, title: 38, body: 30, small: 28, label: 24 };
/** Overscan safe zone: nothing within the outer 5% of the 1920x1080 stage. */
export const SAFE = { x: 96, y: 54 };
export const SP = { xs: 8, s: 12, m: 20, l: 28, xl: 40, xxl: 64, xxxl: 96 };
export const R = { s: 12, m: 20, l: 32, pill: 999 };
export { F };

export const S = StyleSheet.create({
  kicker: { color: C.dim, fontSize: T.label, fontWeight: '700', fontFamily: F.family },
  card: { backgroundColor: C.surface, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.xl },
  paper: { backgroundColor: C.paper, borderRadius: R.l, paddingHorizontal: SP.xl, paddingVertical: SP.xl },
  footnote: { color: C.faint, fontSize: T.label, fontFamily: F.family },
  body: { color: C.text, fontSize: T.body, fontFamily: F.family },
  dim: { color: C.dim, fontSize: T.small, fontFamily: F.family },
});
