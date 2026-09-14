import { describe, expect, it } from "vitest";

import { chainTimeNow, needsResync, syncChainClock } from "./clock.js";

describe("chainTimeNow", () => {
  it("reads the synced value exactly at the sync instant", () => {
    const sync = syncChainClock(1_000n, 5_000);
    expect(chainTimeNow(sync, 5_000)).toBe(1_000n);
  });

  it("extrapolates forward by whole seconds elapsed on the monotonic clock", () => {
    const sync = syncChainClock(1_000n, 0);
    expect(chainTimeNow(sync, 3_000)).toBe(1_003n);
  });

  it("floors a partial second rather than rounding up", () => {
    const sync = syncChainClock(1_000n, 0);
    expect(chainTimeNow(sync, 2_999)).toBe(1_002n);
    expect(chainTimeNow(sync, 999)).toBe(1_000n);
  });

  it("keeps ticking forward from a chain time far ahead of wall time, as a fast local validator serves", () => {
    // Chain time already years past whatever Date.now() would read; the
    // function never looks at Date.now(), so this is exactly as valid a
    // starting point as any other.
    const farAhead = syncChainClock(4_102_444_800n, 0);
    expect(chainTimeNow(farAhead, 10_000)).toBe(4_102_444_810n);
  });

  it("keeps ticking forward from a chain time behind wall time, as a laggy read serves", () => {
    const behind = syncChainClock(100n, 0);
    expect(chainTimeNow(behind, 60_000)).toBe(160n);
  });

  it("resyncing on a later poll rebases the extrapolation instead of compounding it", () => {
    const first = syncChainClock(1_000n, 0);
    expect(chainTimeNow(first, 2_000)).toBe(1_002n);
    // A fresh poll two seconds later reports chain time only advanced by 1 s
    // (a slow validator catching up wall time down, say) — the next sync
    // takes that at face value rather than carrying the old offset forward.
    const resynced = syncChainClock(1_001n, 2_000);
    expect(chainTimeNow(resynced, 2_500)).toBe(1_001n);
  });
});

describe("needsResync", () => {
  const TOLERANCE = 3n;

  it("ignores the jitter the chain's own clock serves within a round", () => {
    const sync = syncChainClock(1_000n, 0);
    // 30 s on, the anchor reads 1_030 and the served value wanders either
    // side of it by the measured 2.23 s spread. None of that is worth
    // dragging the local second boundary around for.
    for (const served of [1_028n, 1_029n, 1_030n, 1_031n, 1_032n]) {
      expect(needsResync(sync, served, 30_000, TOLERANCE)).toBe(false);
    }
  });

  it("re-anchors when the monotonic clock stopped while the device slept", () => {
    // `performance.now()` froze at 10 s while the served time kept moving.
    const sync = syncChainClock(1_000n, 0);
    expect(needsResync(sync, 1_600n, 10_000, TOLERANCE)).toBe(true);
  });

  it("re-anchors when the anchor has fallen behind by the whole tolerance", () => {
    const sync = syncChainClock(1_000n, 0);
    expect(needsResync(sync, 1_012n, 9_000, TOLERANCE)).toBe(true);
    expect(needsResync(sync, 1_011n, 9_000, TOLERANCE)).toBe(false);
  });

  it("re-anchors on a served time far enough behind, not only ahead", () => {
    const sync = syncChainClock(1_000n, 0);
    expect(needsResync(sync, 997n, 0, TOLERANCE)).toBe(true);
  });
});
