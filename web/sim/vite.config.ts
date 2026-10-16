// The Alexa+ simulator, built with the root vite into dist/web/sim and served by the hub at /sim/
// (src/hub/static.ts). Dev: npx vite --config web/sim/vite.config.ts (proxies /mcp and /api to the hub).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const hub = process.env.HUB_URL ?? "http://127.0.0.1:8791";

export default defineConfig({
  root,
  base: "/sim/",
  build: {
    outDir: "../../dist/web/sim",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5175,
    proxy: { "/mcp": hub, "/api": hub },
  },
});
