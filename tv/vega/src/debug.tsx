import React, {createContext, useContext, useState, type ReactNode} from 'react';
import {useTVEventHandler, type HWEvent} from '@amazon-devices/react-native-kepler';

/**
 * Developer details (seq counters, hub address, meter rate) stay off the main surfaces.
 * Vega: press the remote's Menu key (or Play/Pause) to toggle. Web: ?debug=1 or D (tv/web/src/debug.tsx).
 */
const DebugCtx = createContext(false);
export const useDebug = () => useContext(DebugCtx);

export function DebugProvider({children}: {children: ReactNode}) {
  const [on, setOn] = useState(false);
  // eventKeyAction 1 = key up: toggle once per press
  useTVEventHandler((evt: HWEvent) => {
    if (evt && evt.eventKeyAction === 1 && (evt.eventType === 'menu' || evt.eventType === 'playPause' || evt.eventType === 'playpause')) setOn((x) => !x);
  });
  return <DebugCtx.Provider value={on}>{children}</DebugCtx.Provider>;
}
