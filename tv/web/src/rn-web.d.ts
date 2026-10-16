// react-native-web ships no types; reuse a minimal surface for the primitives this app uses.
declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react';
  export type StyleProp<T> = T | T[] | null | undefined | false | StyleProp<T>[];
  export type ViewStyle = Record<string, unknown>;
  export type TextStyle = Record<string, unknown>;
  interface Common {
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    testID?: string;
    nativeID?: string;
    pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only';
  }
  export const View: ComponentType<Common & { accessibilityLabel?: string }>;
  export const Text: ComponentType<Common & { numberOfLines?: number; selectable?: boolean }>;
  export const Pressable: ComponentType<Common & { onPress?: () => void; onFocus?: () => void; onBlur?: () => void; focusable?: boolean }>;
  export const ScrollView: ComponentType<Common & { horizontal?: boolean }>;
  export const StyleSheet: { create<T extends Record<string, ViewStyle>>(s: T): T; absoluteFillObject: ViewStyle; flatten(s: unknown): ViewStyle };
  export const Platform: { OS: 'web' | 'ios' | 'android' | 'kepler' | string; select<T>(o: Record<string, T>): T | undefined };
  export const findNodeHandle: (r: unknown) => number | null;
  namespace AnimatedNS {
    class Value {
      constructor(v: number);
      setValue(v: number): void;
      interpolate(c: { inputRange: number[]; outputRange: number[] | string[]; extrapolate?: 'clamp' | 'extend' }): Value;
    }
    interface CompositeAnimation {
      start(cb?: (r: { finished: boolean }) => void): void;
      stop(): void;
    }
    interface TimingConfig {
      toValue: number;
      duration?: number;
      delay?: number;
      easing?: (t: number) => number;
      useNativeDriver: boolean;
    }
  }
  export const Animated: {
    Value: typeof AnimatedNS.Value;
    View: ComponentType<Common & { accessibilityLabel?: string }>;
    Text: ComponentType<Common & { numberOfLines?: number }>;
    timing(v: AnimatedNS.Value, c: AnimatedNS.TimingConfig): AnimatedNS.CompositeAnimation;
    spring(v: AnimatedNS.Value, c: { toValue: number; friction?: number; tension?: number; useNativeDriver: boolean }): AnimatedNS.CompositeAnimation;
    sequence(a: AnimatedNS.CompositeAnimation[]): AnimatedNS.CompositeAnimation;
    parallel(a: AnimatedNS.CompositeAnimation[]): AnimatedNS.CompositeAnimation;
    loop(a: AnimatedNS.CompositeAnimation, c?: { iterations?: number }): AnimatedNS.CompositeAnimation;
    delay(ms: number): AnimatedNS.CompositeAnimation;
  };
  export const Easing: { out(f: (t: number) => number): (t: number) => number; in(f: (t: number) => number): (t: number) => number; inOut(f: (t: number) => number): (t: number) => number; cubic: (t: number) => number; quad: (t: number) => number; linear: (t: number) => number; ease: (t: number) => number };
  export const AppRegistry: { registerComponent(name: string, fn: () => ComponentType): void; runApplication(name: string, opts: { rootTag: Element | null }): void };
}
