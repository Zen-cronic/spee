import type { ConversationSetting, SettingTag } from '../contract';

/**
 * The setting chip's requests to the hub, one conversation at a time. Each press shows its choice
 * at once; the POSTs for one conversation are sent one after another, never two at once, and presses
 * made while one is on its way are folded into a single next POST with the latest choice. So the hub
 * stores the last choice, and only the answer to that last POST reaches the chip. When it fails, the
 * chip shows what the hub has (`current`, a fresh read), else the last value the hub confirmed.
 */
export interface SettingSenderDeps {
  post: (id: string, setting: ConversationSetting) => Promise<SettingTag | null>; // null: refused or failed
  current: (id: string) => Promise<SettingTag | null>; // the hub's stored tag, read again after a failure
  apply: (id: string, tag: SettingTag) => void;
}

export const youChose = (setting: ConversationSetting): SettingTag => ({ setting, source: 'you', confidence: 'high', reasons: ['you'] });

export function createSettingSender(d: SettingSenderDeps) {
  const lanes = new Map<string, { busy: boolean; queued: ConversationSetting | null; confirmed: SettingTag }>();
  const send = async (id: string, want: ConversationSetting): Promise<void> => {
    const lane = lanes.get(id)!;
    lane.busy = true;
    const tag = await d.post(id, want).catch(() => null);
    if (tag) lane.confirmed = tag;
    if (lane.queued) {
      const next = lane.queued;
      lane.queued = null;
      return send(id, next);
    }
    const shown = tag ?? (await d.current(id).catch(() => null)) ?? lane.confirmed;
    if (lane.queued) {
      // pressed again while the hub's value was being read: that press goes next
      const next = lane.queued;
      lane.queued = null;
      return send(id, next);
    }
    lane.confirmed = shown;
    lane.busy = false;
    d.apply(id, shown);
  };
  /** A press: `shown` is the chip's tag now (the hub's, when nothing is on its way), `want` the next setting. */
  return (id: string, shown: SettingTag, want: ConversationSetting): Promise<void> => {
    let lane = lanes.get(id);
    if (!lane) lanes.set(id, (lane = { busy: false, queued: null, confirmed: shown }));
    else if (!lane.busy) lane.confirmed = shown;
    d.apply(id, youChose(want));
    if (lane.busy) {
      lane.queued = want;
      return Promise.resolve();
    }
    return send(id, want);
  };
}
