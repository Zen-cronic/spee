// The TV's setting chip requests (tv/web/src/mirror/settingSender.ts, synced to tv/vega): quick
// presses never leave the chip showing an older choice than the hub stored, and a failure shows the
// hub's value, not the previous press. Synthetic ids only.
import { describe, expect, it } from "vitest";
import type { ConversationSetting, SettingTag } from "../src/hub/contract.js";
import { createSettingSender, youChose } from "../tv/web/src/mirror/settingSender.js";

const auto = (setting: ConversationSetting): SettingTag => ({ setting, source: "auto", confidence: "high", reasons: ["captions"] });

// A hub whose POST answers are resolved by the test, in any order.
function rig(o: { fail?: (n: number) => boolean } = {}) {
  let stored: SettingTag = auto("meeting");
  const posts: { setting: ConversationSetting; resolve: () => void }[] = [];
  const shown: SettingTag[] = [];
  const send = createSettingSender({
    post: (_id, setting) =>
      new Promise((res) => {
        const n = posts.length;
        posts.push({ setting, resolve: () => (o.fail?.(n) ? res(null) : ((stored = youChose(setting)), res(stored))) });
      }),
    current: async () => stored,
    apply: (_id, tag) => shown.push(tag),
  });
  return { send, posts, shown, stored: () => stored };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("setting chip requests", () => {
  it("two quick presses: one POST at a time, the second carries the latest choice, and the chip ends on what the hub stored", async () => {
    const r = rig();
    void r.send("c1", auto("meeting"), "work");
    void r.send("c1", youChose("work"), "casual");
    expect(r.posts.map((p) => p.setting)).toEqual(["work"]); // the second waits for the first
    expect(r.shown.at(-1)).toEqual(youChose("casual")); // shown at once
    r.posts[0]!.resolve();
    await flush();
    expect(r.posts.map((p) => p.setting)).toEqual(["work", "casual"]);
    expect(r.shown.at(-1)).toEqual(youChose("casual")); // the first answer is not applied
    r.posts[1]!.resolve();
    await flush();
    expect(r.stored()).toEqual(youChose("casual"));
    expect(r.shown.at(-1)).toEqual(youChose("casual"));
  });

  it("three presses while one is on its way fold into a single next POST", async () => {
    const r = rig();
    void r.send("c1", auto("meeting"), "work");
    void r.send("c1", youChose("work"), "casual");
    void r.send("c1", youChose("casual"), "meeting");
    r.posts[0]!.resolve();
    await flush();
    expect(r.posts.map((p) => p.setting)).toEqual(["work", "meeting"]);
    r.posts[1]!.resolve();
    await flush();
    expect(r.shown.at(-1)).toEqual(youChose("meeting"));
    expect(r.stored()).toEqual(youChose("meeting"));
  });

  it("a failed last POST shows the hub's stored value, not the previous press's", async () => {
    const r = rig({ fail: (n) => n === 1 });
    void r.send("c1", auto("meeting"), "work");
    void r.send("c1", youChose("work"), "casual");
    r.posts[0]!.resolve(); // the hub stores work
    await flush();
    r.posts[1]!.resolve(); // casual refused
    await flush();
    await flush();
    expect(r.stored()).toEqual(youChose("work"));
    expect(r.shown.at(-1)).toEqual(youChose("work"));
  });

  it("a single failed press goes back to the hub's value", async () => {
    const r = rig({ fail: () => true });
    void r.send("c1", auto("meeting"), "work");
    r.posts[0]!.resolve();
    await flush();
    await flush();
    expect(r.shown.at(-1)).toEqual(auto("meeting"));
  });
});
