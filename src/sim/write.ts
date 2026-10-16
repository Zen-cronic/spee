import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "./world.js";

export function writeWorld(world: World, root = "fixtures") {
  for (const v of ["verbatim", "cleaned"] as const) {
    const dir = join(root, v);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "conversations"), { recursive: true });
    for (const c of world.conversations[v]) writeFileSync(join(dir, "conversations", `${c.conversation.id}.json`), JSON.stringify(c, null, 1) + "\n");
    writeFileSync(join(dir, "journals.json"), JSON.stringify({ journals: world.journals[v], next_cursor: null, timezone: "America/Toronto" }, null, 1) + "\n");
  }
  mkdirSync(join(root, "_truth"), { recursive: true });
  for (const lang of ["en", "fr"] as const) writeFileSync(join(root, "_truth", `${lang}.json`), JSON.stringify(world.truth[lang], null, 1) + "\n");
}
