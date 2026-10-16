/**
 * Remote-control input on the web build: arrow keys, Enter, Backspace/Escape (Fire TV remotes send
 * the same key codes to web views). The Vega app uses platform focus instead (tv/vega/src/focus.tsx).
 */
export type RemoteKey = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'playpause';

const MAP: Record<string, RemoteKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  ' ': 'select',
  Backspace: 'back',
  Escape: 'back',
  MediaPlayPause: 'playpause',
};

export function subscribeRemote(fn: (k: RemoteKey) => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    const k = MAP[e.key];
    if (!k) return;
    e.preventDefault();
    fn(k);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
