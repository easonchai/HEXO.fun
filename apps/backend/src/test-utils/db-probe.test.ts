// Pre-mainnet review: an unreachable Postgres used to skip every database
// suite silently, so `pnpm test` (and the pre-push hook) passed with the
// api/, indexer/ and operator/ suites never run. The skip stays a skip; it
// is just no longer quiet.
import { describe, expect, it, vi } from "vitest";

import { isDatabaseReachableSync } from "./db-probe";

describe("isDatabaseReachableSync", () => {
  it("warns on stderr once, naming host and port, when Postgres is unreachable, and still answers false rather than throwing", () => {
    // Port 1 refuses at once, so the probe fails on the connection rather
    // than waiting out its timeout.
    const url = "postgresql://hexvault:hexvault@127.0.0.1:1/hexvault_nowhere";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(isDatabaseReachableSync(url, 1_000)).toBe(false);
      // Cached: neither a second probe nor a second warning.
      expect(isDatabaseReachableSync(url, 1_000)).toBe(false);

      const lines = write.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("127.0.0.1:1");
      expect(lines[0]).toMatch(/SKIPPED/);
      // Host and port only: never the credentials in the url.
      expect(lines[0]).not.toContain("hexvault:hexvault");
    } finally {
      write.mockRestore();
    }
  });
});
