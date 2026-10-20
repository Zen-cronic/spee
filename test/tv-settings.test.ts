// The TV's setting chip and per-setting strip (tv/web/src/mirror, synced to tv/vega): plain words,
// the cycle order, and the reducer keeping every held copy of the recap in step. Synthetic data.
import { describe, expect, it } from "vitest";
import type { SettingTag } from "../src/hub/contract.js";
import { loadFixtureV2 } from "../src/hub/fixtureV2.js";
import { bySettingLine, nextSetting, settingName } from "../tv/web/src/mirror/format.js";
import { initialMirror, mirrorReducer, RECAP_VISIBLE_MS, type MirrorState, type SeqEvent } from "../tv/web/src/mirror/reducer.js";

const fx = loadFixtureV2();
const ev = (seq: number, topic: string, payload: Record<string, unknown> = {}): SeqEvent => ({ topic, payload: { seq, at: 1792517400000 + seq, ...payload } });

describe("setting words on the TV", () => {
  it("Meeting, Work talk, Casual, in that cycle", () => {
    expect(settingName({ setting: "meeting" })).toBe("Meeting");
    expect(settingName({ setting: "work" })).toBe("Work talk");
    expect(settingName({ setting: "casual" })).toBe("Casual");
    expect(settingName(null)).toBeNull();
    expect([nextSetting("meeting"), nextSetting("work"), nextSetting("casual")]).toEqual(["work", "casual", "meeting"]);
  });
  it("the strip shows the hub's line without its prefix, and nothing without a line", () => {
    expect(bySettingLine("By setting · Unsure words: work talk 2.1 → 1.4 · casual: too little speech")).toBe("Unsure words: work talk 2.1 → 1.4 · casual: too little speech");
    expect(bySettingLine(null)).toBeNull();
  });
});

describe("reducer: recapSetting", () => {
  it("updates the shown recap and Live's last conversation, and keeps the recap up for another 30 s", () => {
    const recap = { ...fx["recap.json"], setting: { setting: "work", source: "auto", confidence: "high", reasons: ["work-hours", "speakers"] } };
    let s: MirrorState = mirrorReducer(initialMirror(), { type: "event", event: ev(1, "recap.ready", { recap }), now: 1000 });
    expect(s.recapVisible).toBe(true);
    s = mirrorReducer(s, { type: "recapSetting", conversationId: recap.conversationId, setting: { setting: "casual", source: "you", confidence: "high", reasons: ["you"] }, now: 20_000 });
    expect(s.recap?.setting?.setting).toBe("casual");
    expect(s.latestRecap?.setting?.source).toBe("you");
    expect(s.recapShownAt).toBe(20_000);
    s = mirrorReducer(s, { type: "tick", now: 20_000 + RECAP_VISIBLE_MS - 1 });
    expect(s.recapVisible).toBe(true);
    // another conversation's change leaves this one alone
    expect(mirrorReducer(s, { type: "recapSetting", conversationId: "other", setting: null, now: 30_000 })).toBe(s);
  });
});

describe("reducer: recapWording", () => {
  // the recap as it arrived (recap.ready), before the wearer changed the setting
  const shown = {
    ...fx["recap.json"],
    setting: { setting: "work", source: "auto", confidence: "medium", reasons: ["work-hours"] },
    headline: "Unsure words ran high: 2.4 per 100 words against your usual 1.4 at work.",
    narration: "You used 5 unsure words, 2.4 out of every 100 words you said against your usual 1.4 at work.",
    metrics: { ...fx["recap.json"].metrics, baselineSetting: "work" },
  };
  const meeting: SettingTag = { setting: "meeting", source: "you", confidence: "high", reasons: ["you"] };
  const served = { ...shown, setting: meeting, headline: "Unsure words ran high: 2.4 per 100 words against your usual 1.4 from work talk.", narration: "You used 5 unsure words, 2.4 out of every 100 words you said against your usual 1.4 from work talk." };
  it("after a setting change the overlay and Live's last conversation take the hub's new wording", () => {
    let s: MirrorState = mirrorReducer(initialMirror(), { type: "event", event: ev(1, "recap.ready", { recap: shown }), now: 1000 });
    s = mirrorReducer(s, { type: "recapSetting", conversationId: shown.conversationId, setting: meeting, now: 2000 });
    s = mirrorReducer(s, { type: "recapWording", recap: served as never });
    expect(s.recap?.headline).toBe(served.headline);
    expect(s.latestRecap?.headline).toBe(served.headline);
    expect(s.recap?.narration).toBe(served.narration);
    expect(s.recap?.setting).toEqual(meeting);
    expect(s.recapVisible).toBe(true);
  });
  it("an answer for a setting the chip no longer shows, or another recap, changes nothing", () => {
    let s: MirrorState = mirrorReducer(initialMirror(), { type: "event", event: ev(1, "recap.ready", { recap: shown }), now: 1000 });
    s = mirrorReducer(s, { type: "recapSetting", conversationId: shown.conversationId, setting: { ...meeting, setting: "casual" }, now: 2000 });
    expect(mirrorReducer(s, { type: "recapWording", recap: served as never })).toBe(s);
    expect(mirrorReducer(s, { type: "recapWording", recap: { ...served, id: "rcp_other", setting: { ...meeting, setting: "casual" } } as never })).toBe(s);
  });
});
