import type { MirrorConfig } from '../mirror/useMirror';

/**
 * The web TV talks to the hub that serves it (/tv/ on the hub, or the Vite dev proxy on 5183).
 * Meters render at the phone's 10 Hz here; the Vega app throttles them to 5 Hz.
 */
const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
const host = typeof location !== 'undefined' ? location.host : 'localhost:8791';
export const MIRROR_CONFIG: MirrorConfig = { wsUrl: `${proto}://${host}/ws`, httpBase: '', name: 'tv', metersHz: 10, platform: 'web' };
