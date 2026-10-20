import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';

/** Native driver on Vega (transform/opacity off the JS thread); react-native-web has none. */
export const ND = Platform.OS !== 'web';

/** The viewer asked for less motion (web: prefers-reduced-motion). Every hook below then shows its end state at once. */
export const REDUCED_MOTION: boolean = (() => {
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    return Platform.OS === 'web' && typeof mm === 'function' && mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();

/** Fade and rise in whenever `key` changes (a new stage, a new nudge, a new caption). */
export function useEnter(key: unknown, from = 24, duration = 320) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (REDUCED_MOTION) return v.setValue(1);
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration, easing: Easing.out(Easing.cubic), useNativeDriver: ND }).start();
  }, [key]);
  return { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] };
}

/** A short scale "pop" when `key` changes (a verdict landing, a counter ticking up). */
export function usePop(key: unknown, amount = 0.08) {
  const v = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (REDUCED_MOTION || !amount) return;
    v.setValue(1 + amount);
    Animated.spring(v, { toValue: 1, friction: 5, tension: 120, useNativeDriver: ND }).start();
  }, [key]);
  return { transform: [{ scale: v }] };
}

/** 0 -> 1 -> 0 forever while `active` (the waiting pulse while Bee checks). */
export function useLoop(active: boolean, duration = 520, delay = 0) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || REDUCED_MOTION) {
      v.setValue(0);
      return;
    }
    const a = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
        Animated.timing(v, { toValue: 0, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [active]);
  return v;
}

/** Keep showing the last non-null value for `ms` after it goes null (a caption lingers after speech stops). */
export function useLinger<T>(value: T | null, ms: number): T | null {
  const [shown, setShown] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setShown(value);
      return;
    }
    const t = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return value ?? shown;
}
