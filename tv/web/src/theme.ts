import { StyleSheet } from 'react-native';
import { F } from './platform/fonts';

/**
 * Design tokens for the 10-foot UI (1920x1080 stage, read from about 3 m). Shared verbatim by the
 * web TV and the Vega app (npm run tv:sync); only the font family differs (platform/fonts.ts).
 *
 * Warm espresso ground and cream paper. Meaning colours, never decoration: lime for "the thing to
 * do / better / pass", coral for "not yet" or a wrist nudge, the bee colour (C.bee) only for "checked by Bee",
 * amber only for a lost hub connection (always with the words). Each habit has its own hue (HABIT_HUE),
 * the same on every screen, so a habit is recognisable by colour as well as by its name.
 */
export const C = {
  bg: '#17130f',
  surface: '#241e18',
  surface2: '#332b22',
  line: '#43392d',
  text: '#f8f2e7',
  dim: '#c4b9a8',
  faint: '#a0947f',
  paper: '#f6eedd',
  ink: '#1b160f',
  inkDim: '#5c5244',
  inkFaint: '#6f6555',
  lime: '#d7f26a',
  limeInk: '#1a2006',
  limeBg: '#2a3114',
  // "checked by Bee", and nothing else: the one place its colour is set (web/phone, web/sim and
  // web/hub use the same values as --bee, --bee-ink, --bee-on-light). Sky, from the logo.
  bee: '#8ccfff', // on the dark ground
  beeInk: '#0c2233', // text on a solid bee pill
  beeBg: '#1c3447', // a bee-tinted pill on the dark ground (text: bee)
  beeWash: '#dcecf9', // a bee-tinted pill or band on paper (text: beeTextOnLight)
  beeOnLight: '#1a6aab', // a bee mark (dot, ring) on paper
  beeTextOnLight: '#16609c', // bee text on paper or on beeWash
  coral: '#f2876e',
  coralInk: '#2e0f08',
  coralBg: '#3d2219',
  amber: '#e9c46a',
  amberBg: '#3a301c',
  // older names, kept so per-app files read the same palette
  mint: '#d7f26a',
  mintInk: '#1a2006',
  mintBg: '#2a3114',
  focus: '#ffffff', // remote focus ring: never used for anything else
  rule: 'rgba(255,240,220,0.09)',
};

/**
 * One hue per habit, on Today, Progress and Live: `hue` for numbers and marks on the dark ground,
 * `tint` for a card filled with it, `deep` for the hue on paper. None is lime, coral, the bee colour or
 * amber, so a habit's colour never reads as a verdict. The words always name the habit too.
 */
export interface Hue {
  hue: string;
  tint: string;
  deep: string;
}
export const HABIT_HUE: Record<string, Hue> = {
  hedges: { hue: '#e8c897', tint: '#33291b', deep: '#7a5a22' },
  'filler:like': { hue: '#6fdcc4', tint: '#152e28', deep: '#0e6857' },
  fillers: { hue: '#6fdcc4', tint: '#152e28', deep: '#0e6857' },
  vague: { hue: '#a89c8c', tint: '#2a2622', deep: '#5c544a' },
  restart: { hue: '#f5a8d0', tint: '#36202c', deep: '#97306a' },
  restarts: { hue: '#f5a8d0', tint: '#36202c', deep: '#97306a' },
};
const NO_HUE: Hue = { hue: C.dim, tint: C.surface, deep: C.inkDim };
/** A habit key's hue ('hedge:...' and 'filler:...' keys take their family's). */
export function habitHue(key: string | null | undefined): Hue {
  const k = key ?? '';
  return HABIT_HUE[k] ?? (k.startsWith('hedge') ? HABIT_HUE.hedges! : k.startsWith('filler') ? HABIT_HUE.fillers! : NO_HUE);
}

/** Type scale. Fire TV guidance: body text at least 28 px at 1080p. Only labels use 24 px. */
export const T = { hero: 200, big: 120, h1: 64, h2: 46, title: 38, body: 30, small: 28, label: 24 };
/** Overscan safe zone: nothing within the outer 5% of the 1920x1080 stage. */
export const SAFE = { x: 96, y: 54 };
/** One fixed split for every two-panel screen (Today, Live, Practice): the paper card is this wide, so panels never move between tabs or states. */
export const SPLIT = { left: 860 };
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
