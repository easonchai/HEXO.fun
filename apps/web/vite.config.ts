import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The Solana packages need the Node `Buffer` global in the browser. `buffer` is
 * already in the pnpm store as a transitive dependency, so alias it there
 * instead of adding a new top-level install.
 */
function bufferPackagePath(): string {
  const store = fileURLToPath(
    new URL("../../node_modules/.pnpm", import.meta.url),
  );
  const entry = readdirSync(store)
    .filter((name) => /^buffer@\d/.test(name))
    .sort()
    .at(-1);
  if (!entry) {
    throw new Error(
      "buffer@* not found in node_modules/.pnpm; run `pnpm install` at the workspace root",
    );
  }
  return fileURLToPath(
    new URL(
      `../../node_modules/.pnpm/${entry}/node_modules/buffer`,
      import.meta.url,
    ),
  );
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      buffer: bufferPackagePath(),
    },
  },
  define: {
    global: "globalThis",
  },
  // Bigint money math and u64 LE encoding need ES2020+.
  build: { target: "es2022" },
});
