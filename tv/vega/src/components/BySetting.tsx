import { bySettingLine } from '../mirror/format';
import { DetailRow } from './DetailRow';

/**
 * By setting, in Progress's Details: each practised habit's rate before and after within work
 * talk, casual chats and meetings, as the hub words it (it says "too little speech" instead of a
 * number). Hidden when no setting has enough speech; never the pre-registered result.
 */
export function BySettingLine({ line }: { line: string | null | undefined }) {
  const text = bySettingLine(line);
  if (!text) return null;
  return <DetailRow testID="by-setting" tag="By setting" text={text} caveat="a closer look, not the test" />;
}
