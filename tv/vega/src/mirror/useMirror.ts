import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { BridgeClient } from '@rackboard/tv-voice-bridge';
import type { HubState, LiveState, PracticeMeters, Recap, RecapList, StatsResponse, TransferResponse } from '../contract';
import { initialMirror, mirrorReducer, type ScreenView } from './reducer';

/**
 * The mirror's connection to the hub, shared by the web TV and the Vega app (only MirrorConfig
 * differs). Joins the bridge as a `screen`, feeds sequenced events and `hub.state` to the reducer,
 * batches the room-scoped meters at `metersHz` (10 on the web, 5 on Vega), and fetches the week's
 * stats and the transfer result on start and after every `stats.updated`.
 *
 * Privacy: nothing is written to storage. The room code lives in this module for the app run
 * only, and every bit of wearer text on screen is what the hub served.
 */
export interface MirrorConfig {
  wsUrl: string; // ws://<hub>/ws
  httpBase: string; // '' (same origin) or http://<hub>
  name: string; // the screen's peer name (`by` on its mirror.focus)
  metersHz: number; // render rate for practice meters
  platform: 'web' | 'vega';
}

export type LinkStatus = 'connecting' | 'online' | 'offline';

let savedCode: string | undefined;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export function useMirror(cfg: MirrorConfig) {
  const [state, dispatch] = useReducer(mirrorReducer, undefined, () => initialMirror('week'));
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [code, setCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [mics, setMics] = useState(0);
  const [partial, setPartial] = useState<{ text: string; at: number } | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [transfer, setTransfer] = useState<TransferResponse | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);
  const meterBuf = useRef<PracticeMeters[]>([]);

  useEffect(() => {
    const client = new BridgeClient({ url: cfg.wsUrl, role: 'screen', code: savedCode, name: cfg.name });
    clientRef.current = client;
    const offs = [
      client.on('open', () => setStatus('online')),
      client.on('close', () => setStatus('offline')),
      client.on('welcome', (m) => {
        savedCode = m.code;
        setCode(m.code);
        setJoinUrl(m.joinUrl ?? null);
        setMics(m.peers.filter((p) => p.role === 'mic').length);
        setRttMs(client.rttMs);
      }),
      client.on('peers', (m) => setMics(m.peers.filter((p) => p.role === 'mic').length)),
      client.on('app', (m) => {
        const p = m.payload as Record<string, unknown> | null;
        if (!p || typeof p !== 'object') return;
        if (m.topic === 'hub.state') dispatch({ type: 'hubState', state: p as unknown as HubState, now: Date.now() });
        else if (m.topic === 'practice.meters') meterBuf.current.push(p as unknown as PracticeMeters);
        else if (typeof p.seq === 'number') dispatch({ type: 'event', event: { topic: m.topic, payload: p as { seq: number } }, now: Date.now() });
      }),
      client.on('transcript.partial', (m) => setPartial({ text: m.text, at: Date.now() })),
      client.on('transcript.final', (m) => setPartial({ text: m.text, at: Date.now() })),
    ];
    client.connect().catch(() => setStatus('offline'));
    const flush = setInterval(() => {
      if (!meterBuf.current.length) return;
      const frames = meterBuf.current;
      meterBuf.current = [];
      dispatch({ type: 'meters', frames, now: Date.now() });
    }, Math.round(1000 / Math.max(1, cfg.metersHz)));
    const tick = setInterval(() => {
      dispatch({ type: 'tick', now: Date.now() });
      setPartial((x) => (x && Date.now() - x.at > 6000 ? null : x));
    }, 500);
    return () => {
      offs.forEach((o) => o());
      clearInterval(flush);
      clearInterval(tick);
      client.close();
    };
  }, [cfg.wsUrl]);

  // the week, the transfer result and the live state: on start, on reconnect, after stats.updated
  useEffect(() => {
    if (status !== 'online') return;
    let alive = true;
    void getJson<StatsResponse>(`${cfg.httpBase}/api/stats?range=week`).then((r) => alive && r && setStats(r));
    void getJson<TransferResponse>(`${cfg.httpBase}/api/transfer`).then((r) => alive && r && setTransfer(r));
    return () => {
      alive = false;
    };
  }, [status, state.statsVersion, cfg.httpBase]);
  useEffect(() => {
    if (status !== 'online') return;
    void getJson<LiveState>(`${cfg.httpBase}/api/live`).then((r) => r && r.mode && dispatch({ type: 'liveState', live: r }));
  }, [status, cfg.httpBase]);
  useEffect(() => {
    const want = state.recapWanted;
    if (!want) return;
    const url = want === 'latest' ? `${cfg.httpBase}/api/recaps?limit=1` : `${cfg.httpBase}/api/recaps/${encodeURIComponent(want)}`;
    void getJson<Recap | RecapList>(url).then((r) => {
      const recap = r && 'recaps' in r ? r.recaps[0] : (r as Recap | null);
      if (recap && recap.id) dispatch({ type: 'recap', recap, show: true, now: Date.now() });
    });
  }, [state.recapWanted, cfg.httpBase]);

  const show = useCallback((view: ScreenView) => dispatch({ type: 'show', view }), []);
  const dismissRecap = useCallback(() => dispatch({ type: 'dismissRecap' }), []);
  return { state, status, code, joinUrl, mics, partial, stats, transfer, rttMs, show, dismissRecap };
}

export type Mirror = ReturnType<typeof useMirror>;
