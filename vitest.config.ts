// Unit tests live in test/ only. tv/vega (jest), tv/web and web/* keep their own tooling and
// node_modules, so vitest must not pick up their files.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
