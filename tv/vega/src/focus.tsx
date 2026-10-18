import React, {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {BackHandler, Pressable, StyleSheet, Text, findNodeHandle, type StyleProp, type ViewStyle, type View} from 'react-native';
import {FocusManager, useTVEventHandler, type HWEvent} from '@amazon-devices/react-native-kepler';
import {C, F, R, SP, T} from './theme';

/**
 * Vega focus layer, with the same exports as the web build (tv/web/src/focus.tsx). The platform
 * owns focus here: Pressables are focusable, the D-pad moves focus, OK fires onPress, and Back
 * arrives through BackHandler. `row`/`col` are kept for the shared views' call signatures.
 * `onKey` gets Left/Right key-ups (the web build only sends them at a row's end; on Vega the
 * platform moves focus first, so the mirror ignores them unless a recap is open).
 */
export type RemoteKey = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'playpause';

export function FocusRoot({children, onBack, onKey}: {children: ReactNode; onBack?: () => boolean | void; initial?: string; onKey?: (k: RemoteKey) => boolean | void}) {
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // false lets the system handle Back, which exits the app on the root screen. onBack returns
      // false when there is nothing left to close or go back from.
      if (!backRef.current) return false;
      return backRef.current() !== false;
    });
    return () => sub.remove();
  }, []);
  // eventKeyAction 1 = key up; OK arrives as "enter" on the VVD and "select" on devices
  useTVEventHandler((evt: HWEvent) => {
    if (!evt || evt.eventKeyAction !== 1) return;
    const k = evt.eventType === 'enter' ? 'select' : (evt.eventType as RemoteKey);
    if (k === 'select' || k === 'back') keyRef.current?.(k);
  });
  return <>{children}</>;
}

/** Imperatively move platform focus to a view (FocusManager TurboModule). */
export function focusRef(ref: React.RefObject<View | null>) {
  const handle = ref.current ? findNodeHandle(ref.current) : null;
  if (handle) FocusManager.focus(handle);
}

export function useFocusState() {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  return {focused, onFocus, onBlur};
}

export type ButtonTone = 'default' | 'accent' | 'ghost' | 'active';

export function FocusButton(props: {id: string; row: number; col: number; label: string; onPress: () => void; tone?: ButtonTone; style?: StyleProp<ViewStyle>; small?: boolean; preferred?: boolean; current?: boolean}) {
  const {focused, onFocus, onBlur} = useFocusState();
  const ref = useRef<View>(null);
  useEffect(() => {
    if (props.current) focusRef(ref);
  }, [props.current]);
  const tone = props.tone ?? 'default';
  const bg = tone === 'accent' ? C.mint : tone === 'active' ? C.surface2 : tone === 'ghost' ? 'transparent' : C.surface;
  const ink = tone === 'accent' ? C.mintInk : tone === 'active' ? C.mint : tone === 'ghost' ? C.dim : C.text;
  const border = tone === 'accent' ? C.mint : tone === 'active' ? C.mint : tone === 'ghost' ? C.rule : C.line;
  return (
    <Pressable
      ref={ref}
      testID={`btn-${props.id}`}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hasTVPreferredFocus={props.preferred || props.current}
      onPress={props.onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      style={[styles.btn, props.small && styles.btnSmall, {backgroundColor: bg, borderColor: border}, focused && styles.ring, props.style]}>
      <Text style={[styles.btnText, props.small && {fontSize: T.label}, {color: ink}]}>{props.label}</Text>
    </Pressable>
  );
}

/** A focusable card. `current` pulls platform focus to it when it becomes current. */
export function FocusCard(props: {id: string; row: number; col: number; onPress: () => void; current?: boolean; preferred?: boolean; testID?: string; label?: string; style?: StyleProp<ViewStyle>; children: ReactNode}) {
  const {focused, onFocus, onBlur} = useFocusState();
  const ref = useRef<View>(null);
  useEffect(() => {
    if (props.current) focusRef(ref);
  }, [props.current]);
  return (
    <Pressable ref={ref} testID={props.testID} accessibilityRole="button" accessibilityLabel={props.label} hasTVPreferredFocus={props.preferred || props.current} onPress={props.onPress} onFocus={onFocus} onBlur={onBlur} style={[props.style, focused && styles.ring]}>
      {props.children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {paddingHorizontal: 30, paddingVertical: 14, borderRadius: R.m, borderWidth: 3, marginRight: SP.m},
  btnSmall: {paddingHorizontal: 22, paddingVertical: 8},
  // the focus ring: a thick white border plus a lift in scale (a physical change, not colour alone)
  ring: {borderColor: C.focus, borderWidth: 5, transform: [{scale: 1.05}]},
  btnText: {fontSize: T.small, fontWeight: '800', fontFamily: F.family},
});
