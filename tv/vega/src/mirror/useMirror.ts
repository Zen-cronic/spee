import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BridgeClient } from 'tv-voice-bridge';
import type { HubState, InstrumentResponse, LiveState, PracticeMeters, Recap, RecapList, SettingResponse, SettingsResponse, StatsResponse, TransferResponse } from '../contract';
import { nextSetting } from './format';
import { initialMirror, mirrorReducer, type ScreenView } from './reducer';
import { createSettingSender } from './settingSender';

/**
 * The mirror's connection to the hub, shared by the web TV and the Vega app (only MirrorConfig
 * differs). Joins the bridge as a `screen`, feeds sequenced events and `hub.state` to the reducer,
 * batches the room-scoped meters at `metersHz` (10 on the web, 5 on Vega), and fetches the week's
 * stats and the transfer result (and its secondary captions-included view) on start and after every `stats.updated` (today's drill tally on
 * start; `stats.updated` carries it after that).
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
  // Secondary, labelled: the same before/after with meeting captions, and the Bee-vs-captions check.
  const [captions, setCaptions] = useState<{ all: TransferResponse | null; instrument: InstrumentResponse | null }>({ all: null, instrument: null });
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
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
        dispatch({ type: 'room', code: m.code });
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
    void Promise.all([getJson<TransferResponse>(`${cfg.httpBase}/api/transfer?source=all`), getJson<InstrumentResponse>(`${cfg.httpBase}/api/instrument`)]).then(([all, instrument]) => alive && setCaptions({ all, instrument }));
    // the per-setting view: secondary, so an older hub without it just leaves the strip hidden
    void getJson<SettingsResponse>(`${cfg.httpBase}/api/settings`).then((r) => alive && r && setSettings(r));
    return () => {
      alive = false;
    };
  }, [status, state.statsVersion, cfg.httpBase]);
  useEffect(() => {
    if (status !== 'online') return;
    let alive = true; // a response from a superseded fetch is dropped
    void getJson<LiveState>(`${cfg.httpBase}/api/live`).then((r) => alive && r && r.mode && dispatch({ type: 'liveState', live: r }));
    return () => {
      alive = false;
    };
  }, [status, state.statsVersion, cfg.httpBase]); // the usual rates move with the week's stats
  useEffect(() => {
    const want = state.recapWanted;
    if (!want) return;
    const url = want === 'latest' ? `${cfg.httpBase}/api/recaps?limit=1` : `${cfg.httpBase}/api/recaps/${encodeURIComponent(want)}`;
    void getJson<Recap | RecapList>(url).then((r) => {
      const recap = r && 'recaps' in r ? r.recaps[0] : (r as Recap | null);
      if (recap && recap.id) dispatch({ type: 'recap', recap, show: true, now: Date.now() });
      dispatch({ type: 'recapFetched', ok: !!(recap && recap.id) });
    });
  }, [state.recapWanted, cfg.httpBase]);

  // The setting chip (the recap overlay's, or Live's last conversation): the next setting at once,
  // then the hub's answer to the last press (settingSender.ts: one POST at a time per conversation,
  // quick presses folded into one); after a failure, what the hub has.
  const stateRef = useRef(state);
  stateRef.current = state;
  const recapIds = useRef(new Map<string, string>());
  const sender = useMemo(
    () =>
      createSettingSender({
        post: (id, setting) =>
          fetch(`${cfg.httpBase}/api/sessions/${encodeURIComponent(id)}/setting`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ setting }) })
            .then(async (res) => (res.ok ? ((await res.json()) as SettingResponse).tag ?? null : null))
            .catch(() => null),
        current: async (id) => {
          const rid = recapIds.current.get(id);
          return rid ? ((await getJson<Recap>(`${cfg.httpBase}/api/recaps/${encodeURIComponent(rid)}`))?.setting ?? null) : null;
        },
        apply: (id, tag) => dispatch({ type: 'recapSetting', conversationId: id, setting: tag, now: Date.now() }),
        // the headline and narration as the hub now words them for the new setting
        settled: (id) => {
          const rid = recapIds.current.get(id);
          if (rid) void getJson<Recap>(`${cfg.httpBase}/api/recaps/${encodeURIComponent(rid)}`).then((r) => r && r.id && dispatch({ type: 'recapWording', recap: r }));
        },
      }),
    [cfg.httpBase],
  );
  const cycleSetting = useCallback(
    (which: 'recap' | 'last') => {
      const s = stateRef.current;
      const r = which === 'recap' ? s.recap : s.latestRecap;
      if (!r || !r.setting) return;
      recapIds.current.set(r.conversationId, r.id);
      void sender(r.conversationId, r.setting, nextSetting(r.setting.setting));
    },
    [sender],
  );

  const show = useCallback((view: ScreenView) => dispatch({ type: 'show', view }), []);
  const dismissRecap = useCallback(() => dispatch({ type: 'dismissRecap' }), []);
  return { state, status, code, joinUrl, mics, partial, stats, transfer, captions, settings, rttMs, show, dismissRecap, cycleSetting };
}

export type Mirror = ReturnType<typeof useMirror>;
