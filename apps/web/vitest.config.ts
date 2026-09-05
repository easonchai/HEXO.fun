// Without this, `vitest run` falls back to vite.config.ts and picks up
// e2e/demo.spec.ts under its default "**/*.spec.ts" include: Playwright's
// `test()` isn't vitest's, so vitest crashes trying to run it. Merge, don't
// replace, so the app's own vite.config.ts (React plugin, the buffer alias)
// still applies to src/**/*.test.ts.
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    },
  }),
);
