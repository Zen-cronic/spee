import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Developer details (seq counters, hub URL, room code) stay off the main surfaces.
 * Web: open with `?debug=1`, or press `D` to toggle. (Vega: the remote's Menu key, tv/vega/src/debug.tsx.)
 */
const DebugCtx = createContext(false);
export const useDebug = () => useContext(DebugCtx);

export function DebugProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'));
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D' || e.key === 'ContextMenu') setOn((x) => !x);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return <DebugCtx.Provider value={on}>{children}</DebugCtx.Provider>;
}
