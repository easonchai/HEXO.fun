// Nest's DI relies on emitDecoratorMetadata, which esbuild (Vite's default
// transform) does not produce. unplugin-swc reads tsconfig.json's decorator
// settings and swaps in swc for the transform instead.
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
  plugins: [swc.vite()],
});
