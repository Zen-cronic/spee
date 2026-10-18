/**
 * Where the coach hub lives, as seen from the TV. Edit src/hub.json, or run
 *   npm --prefix tv/vega run hub -- 192.168.1.20:8791     (then rebuild)
 *
 * - Vega Virtual Device: 127.0.0.1:8791 plus `vega device start-port-forwarding --port 8791
 *   --forward false` (a reverse tunnel). Not the emulator NAT address 10.0.2.2: it drops
 *   WebSocket frames over about 1.4 kB.
 * - Fire TV Stick on Wi-Fi: the dev machine's LAN IP, e.g. 192.168.1.20:8791, with the hub
 *   started as `npm run hub -- --lan` (without it the gate treats LAN devices as public).
 * Metro does not inline process.env, so the address is a JSON file.
 *
 * Meters render at 5 Hz on Vega (the phone sends 10 Hz; frames are batched, none are lost).
 */
import type {MirrorConfig} from '../mirror/useMirror';
import hub from '../hub.json';

export const HUB_HOSTPORT: string = hub.hostport;
export const MIRROR_CONFIG: MirrorConfig = {wsUrl: `ws://${HUB_HOSTPORT}/ws`, httpBase: `http://${HUB_HOSTPORT}`, name: 'tv', metersHz: 5, platform: 'vega'};
