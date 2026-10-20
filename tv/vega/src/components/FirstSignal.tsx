import type { FirstSignal } from '../contract';
import { FIRST_SIGNAL_CAVEAT, firstSignalLine } from '../mirror/format';
import { DetailRow } from './DetailRow';

/**
 * The first signal, in Progress's Details: per practised habit, the conversation before its first
 * practice against the next one after it. A number always comes with its caveat: one conversation
 * is a glance, the pre-registered before/after on the cards is the result.
 */
export function FirstSignalLines({ signals }: { signals: FirstSignal[] | undefined }) {
  const line = firstSignalLine(signals);
  if (!line) return null;
  return <DetailRow testID="first-signal" tag="First signal" text={line.text} caveat={line.measured ? FIRST_SIGNAL_CAVEAT : null} />;
}
