// The Vega app runs the same views, components, mirror state and contract as the web TV
// (npm run tv:sync copies them; scripts/tv-sync.ts). Any drift fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_CONTRACT, ROOT, staleCopies, syncDiff, syncPairs, SYNC_DIRS } from "../scripts/tv-sync.js";

describe("tv-sync: web and Vega share their code byte for byte", () => {
  it("covers the contract, the theme and every view, component and mirror module", () => {
    const rel = syncPairs().map(([, d]) => d.slice(ROOT.length));
    expect(rel).toEqual(expect.arrayContaining(["tv/web/src/contract.ts", "tv/vega/src/contract.ts", "tv/vega/src/theme.ts", "tv/vega/src/mirror/reducer.ts", "tv/vega/src/mirror/useMirror.ts", "tv/vega/src/views/LiveView.tsx", "tv/vega/src/views/PracticeView.tsx", "tv/vega/src/views/WeekView.tsx", "tv/vega/src/views/TransferView.tsx", "tv/vega/src/views/RecapOverlay.tsx"]));
    expect(SYNC_DIRS).toEqual(["views", "components", "mirror"]);
  });
  it("every copy is identical to its source and none is stale", () => {
    expect(syncDiff()).toEqual([]);
    expect(staleCopies()).toEqual([]);
  });
  it("both apps carry the hub's contract.ts verbatim", () => {
    const hub = readFileSync(HUB_CONTRACT, "utf8");
    expect(readFileSync(join(ROOT, "tv/web/src/contract.ts"), "utf8")).toBe(hub);
    expect(readFileSync(join(ROOT, "tv/vega/src/contract.ts"), "utf8")).toBe(hub);
  });
});
