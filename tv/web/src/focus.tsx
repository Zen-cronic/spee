import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { subscribeRemote, type RemoteKey } from './platform/remote';
import { C, F, R, SP, T } from './theme';

/**
 * Web focus layer: focusables live on a (row, col) grid; arrows move, Enter presses, Back calls
 * onBack. Keys no focusable handles go to `onKey` (the mirror's left/right screen switching).
 * The Vega app keeps the same exports on top of platform focus (tv/vega/src/focus.tsx).
 */
interface Item {
  id: string;
  row: number;
  col: number;
  onPress: () => void;
}
interface Ctx {
  focused: string | null;
  register: (i: Item) => () => void;
  setFocused: (id: string) => void;
}
const FocusCtx = createContext<Ctx | null>(null);

export function FocusRoot({ children, onBack, initial, onKey }: { children: ReactNode; onBack?: () => boolean | void; initial?: string; onKey?: (k: RemoteKey) => boolean | void }) {
  const items = useRef(new Map<string, Item>());
  const [focused, setFocused] = useState<string | null>(initial ?? null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  const register = useCallback((i: Item) => {
    items.current.set(i.id, i);
    if (!focusedRef.current) setFocused(i.id);
    return () => {
      items.current.delete(i.id);
    };
  }, []);

  useEffect(
    () =>
      subscribeRemote((k) => {
        const all = [...items.current.values()];
        const cur = (focusedRef.current && items.current.get(focusedRef.current)) || all[0];
        if (k === 'back') return backRef.current?.();
        if (!cur) return keyRef.current?.(k);
        if (k === 'select') return cur.onPress();
        const rows = [...new Set(all.map((i) => i.row))].sort((a, b) => a - b);
        if (k === 'left' || k === 'right') {
          const inRow = all.filter((i) => i.row === cur.row).sort((a, b) => a.col - b.col);
          const idx = inRow.findIndex((i) => i.id === cur.id) + (k === 'right' ? 1 : -1);
          const next = inRow[idx];
          if (next) setFocused(next.id);
          else keyRef.current?.(k);
        } else if (k === 'up' || k === 'down') {
          const ri = rows.indexOf(cur.row) + (k === 'down' ? 1 : -1);
          const row = rows[ri];
          if (row === undefined) return keyRef.current?.(k);
          const inRow = all.filter((i) => i.row === row).sort((a, b) => Math.abs(a.col - cur.col) - Math.abs(b.col - cur.col));
          if (inRow[0]) setFocused(inRow[0].id);
        } else keyRef.current?.(k);
      }),
    [],
  );

  const value = useMemo(() => ({ focused, register, setFocused }), [focused, register]);
  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocusable(id: string, row: number, col: number, onPress: () => void) {
  const ctx = useContext(FocusCtx);
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  useEffect(() => ctx?.register({ id, row, col, onPress: () => pressRef.current() }), [ctx?.register, id, row, col]);
  return { focused: ctx?.focused === id, focus: () => ctx?.setFocused(id) };
}

export type ButtonTone = 'default' | 'accent' | 'ghost' | 'active';

export function FocusButton(props: { id: string; row: number; col: number; label: string; onPress: () => void; tone?: ButtonTone; style?: StyleProp<ViewStyle>; small?: boolean; preferred?: boolean; current?: boolean }) {
  const { focused, focus } = useFocusable(props.id, props.row, props.col, props.onPress);
  useEffect(() => {
    if (props.current) focus();
  }, [props.current]);
  const tone = props.tone ?? 'default';
  // focus is a filled paper pill (an inverted, physical change); the current tab is a raised charcoal pill
  const bg = focused ? C.paper : tone === 'accent' ? C.lime : tone === 'active' ? C.surface2 : tone === 'ghost' ? 'transparent' : C.surface;
  const ink = focused ? C.ink : tone === 'accent' ? C.limeInk : tone === 'active' ? C.text : tone === 'ghost' ? C.dim : C.text;
  const border = focused ? C.focus : 'transparent';
  return (
    <Pressable testID={`btn-${props.id}`} onPress={props.onPress} onFocus={focus} style={[styles.btn, props.small && styles.btnSmall, { backgroundColor: bg, borderColor: border }, focused && styles.lift, props.style]}>
      <Text style={[styles.btnText, props.small && { fontSize: T.body }, { color: ink }]}>{props.label}</Text>
    </Pressable>
  );
}

/** A focusable card. `current` pulls the remote's focus to it when it becomes current. */
export function FocusCard(props: { id: string; row: number; col: number; onPress: () => void; current?: boolean; preferred?: boolean; testID?: string; label?: string; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { focused, focus } = useFocusable(props.id, props.row, props.col, props.onPress);
  useEffect(() => {
    if (props.current) focus();
  }, [props.current]);
  return (
    <Pressable testID={props.testID} onPress={props.onPress} onFocus={focus} style={[props.style, focused && styles.ring]}>
      {props.children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 32, paddingVertical: 14, borderRadius: R.pill, borderWidth: 3, marginRight: SP.xs },
  btnSmall: { paddingHorizontal: 28, paddingVertical: 10 },
  // the focus ring: a thick white border and a lift in scale (a physical change, not colour alone)
  ring: { borderColor: C.focus, borderWidth: 5, transform: [{ scale: 1.05 }] },
  lift: { transform: [{ scale: 1.06 }] },
  btnText: { fontSize: T.small, fontWeight: '600', fontFamily: F.family },
});
