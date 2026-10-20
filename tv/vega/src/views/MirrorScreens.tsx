import { StyleSheet, Text, View } from 'react-native';
import { DataLabel, TABS, TAB_LABEL, TopBar } from '../components/Chrome';
import { useDebug } from '../debug';
import { FocusRoot } from '../focus';
import type { MirrorConfig } from '../mirror/useMirror';
import { useMirror } from '../mirror/useMirror';
import { backAction, type ScreenView } from '../mirror/reducer';
import { C, F, SAFE, T } from '../theme';
import { LiveView } from './LiveView';
import { PairingView } from './PairingView';
import { PracticeView } from './PracticeView';
import { RecapOverlay } from './RecapOverlay';
import { TransferView } from './TransferView';
import { WeekView } from './WeekView';

/**
 * The Speaking Mirror: one hub connection, five screens, the recap overlay. Shared verbatim by the
 * web TV and the Vega app; the platform passes its MirrorConfig. Screens switch by themselves on
 * hub events; the remote's tabs (row 0) and Left/Right at the row ends switch them by hand.
 */
export function MirrorScreens({ config }: { config: MirrorConfig }) {
  const m = useMirror(config);
  const debug = useDebug();
  const s = m.state;
  const order: ScreenView[] = TABS;
  const cur = s.view === 'drill' ? 'live' : s.view === 'recap' ? 'week' : s.view;
  const step = (d: number) => m.show(order[(order.indexOf(cur) + d + order.length) % order.length]!);
  // false = not handled: on the root screen the platform takes Back (and exits the app)
  const onBack = (): boolean => {
    const a = backAction(s);
    if (a === 'dismissRecap') m.dismissRecap();
    else if (a === 'home') m.show('week');
    return a !== 'exit';
  };
  const onKey = (k: string) => {
    if (s.recapVisible && (k === 'select' || k === 'back')) return m.dismissRecap();
    if (k === 'left') step(-1);
    if (k === 'right') step(1);
  };
  // Right on an open recap changes where it happened (the setting chip), before focus moves
  const onCapture = (k: string): boolean => {
    if (!s.recapVisible || !s.recap?.setting || k !== 'right') return false;
    m.cycleSetting('recap');
    return true;
  };
  const right = m.status !== 'online' ? (m.status === 'offline' ? 'Hub offline, retrying…' : 'Connecting…') : m.mics ? 'Phone paired' : `Pair code ${m.code ?? '····'}`;
  const diag = debug ? `${config.platform} · seq ${s.lastSeq ?? '–'} · applied ${s.applied} · dup ${s.duplicates} · gaps ${s.gaps}${m.rttMs !== null ? ` · rtt ${m.rttMs} ms` : ''} · meters ${s.practice.frames} @ ${config.metersHz} Hz` : null;

  let screen;
  switch (s.view) {
    case 'transfer':
      screen = <TransferView transfer={m.transfer} captions={m.captions} settings={m.settings} />;
      break;
    case 'live':
    case 'drill':
      screen = <LiveView drill={s.drill} live={s.live} partial={m.partial?.text ?? null} focus={s.view === 'drill' ? 'drill' : 'live'} last={s.latestRecap} onCycleSetting={() => m.cycleSetting('last')} />;
      break;
    case 'practice':
      screen = <PracticeView p={s.practice} code={m.code} mics={m.mics} />;
      break;
    case 'pair':
      screen = <PairingView code={m.code} joinUrl={m.joinUrl} status={m.status} mics={m.mics} />;
      break;
    default:
      screen = <WeekView stats={m.stats} today={s.practiceToday} deck={s.drill.deck} transfer={m.transfer} />;
  }
  return (
    <FocusRoot key="mirror" initial={`tab-${cur}`} onBack={onBack} onKey={onKey} onCapture={onCapture}>
      <View style={styles.root}>
        <TopBar view={s.view} onShow={m.show} right={s.view === 'pair' && m.status === 'online' ? null : right} rightTone={m.status === 'online' ? 'ok' : 'warn'} />
        {debug && s.viewReason && s.viewBy && s.viewBy !== 'remote' ? <Text style={styles.reason} numberOfLines={1}>{`${TAB_LABEL[s.view]}: ${s.viewReason} (${s.viewBy})`}</Text> : <View style={styles.reasonSpacer} />}
        <View style={styles.body}>{screen}</View>
        <DataLabel label={s.dataLabel ?? m.stats?.dataLabel ?? null} synthetic={s.synthetic || !!m.stats?.synthetic} replay={s.replay} extra={diag} />
      </View>
      {s.recapVisible && s.recap ? <RecapOverlay recap={s.recap} /> : null}
      {m.status === 'offline' ? (
        <View style={styles.offline}>
          <Text style={styles.offlineText}>Connection to the hub lost. Reconnecting…</Text>
        </View>
      ) : null}
    </FocusRoot>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingHorizontal: SAFE.x, paddingVertical: SAFE.y },
  body: { flex: 1, overflow: 'hidden' },
  reason: { color: C.faint, fontSize: T.label, height: 32, marginTop: 4, fontFamily: F.family },
  reasonSpacer: { height: 28 },
  offline: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.amber, padding: 14 },
  offlineText: { color: C.bg, fontSize: T.small, fontWeight: '800', textAlign: 'center', fontFamily: F.family },
});
