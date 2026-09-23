import { describe, expect, it } from "vitest";

import { findLeak } from "./check-bundle-keys.mjs";

describe("findLeak", () => {
  it("flags a bundle carrying a keyed RPC URL", () => {
    const hit = findLeak([
      { path: "dist/assets/index.js", text: 'const RPC="https://x/?api-key=abc"' },
    ]);
    expect(hit).toEqual({
      file: "dist/assets/index.js",
      pattern: "api-key query param",
    });
  });

  it("passes a clean bundle", () => {
    const hit = findLeak([
      { path: "dist/assets/index.js", text: 'const RPC="https://api.devnet.solana.com"' },
    ]);
    expect(hit).toBeNull();
  });
});
