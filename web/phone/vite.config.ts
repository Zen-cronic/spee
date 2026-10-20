import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";

// The phone page, served by the hub at /p/<code>#k=... (npm run web:phone:build). Built with the
// root vite; the vendored bridge resolves to its TypeScript source. The favicons come from web/public,
// shared with the simulator.
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  base: "/p/",
  publicDir: "../public",
  resolve: { conditions: ["source", ...defaultClientConditions] },
  server: { port: 5184, strictPort: true, proxy: { "/ws": { target: "ws://localhost:8791", ws: true }, "/api": "http://localhost:8791" } },
  build: { outDir: "../../dist/web/phone", emptyOutDir: true },
});
