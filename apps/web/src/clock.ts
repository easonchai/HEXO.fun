/**
 * Pure chain-clock arithmetic (ticket 07), beside `status.ts` and `engine.ts`:
 * no React, no chain I/O. `useChainClock.ts` keeps the effects and calls in
 * here for the math, so the interpolation itself is unit-testable without a
 * browser or a fake timer.
 *
 * The countdown is driven by chain time — a local validator runs it faster
 * than wall time — interpolated against the browser's own monotonic clock
 * (`performance.now()`), never `Date.now()`: a wrong device clock must never
 * make the draw look like it fired early or late.
 */

/** Chain time as last observed, and the monotonic instant it was observed at. */
export interface ChainClockSync {
  readonly chainTimeSeconds: bigint;
  readonly syncedAtMs: number;
}

/** Anchors `chainTimeSeconds` to `monotonicNowMs` (a `performance.now()` reading). */
export function syncChainClock(
  chainTimeSeconds: bigint,
  monotonicNowMs: number,
): ChainClockSync {
  return { chainTimeSeconds, syncedAtMs: monotonicNowMs };
}

/**
 * Chain time extrapolated to `monotonicNowMs`: the synced value plus whole
 * seconds elapsed on the monotonic clock since the sync. Never reads a wall
 * clock, so a served chain time that is far ahead of (a fast local
 * validator) or behind (a laggy indexer) wall time still ticks forward
 * correctly from wherever it started.
 */
export function chainTimeNow(sync: ChainClockSync, monotonicNowMs: number): bigint {
  const elapsedMs = monotonicNowMs - sync.syncedAtMs;
  return sync.chainTimeSeconds + BigInt(Math.floor(elapsedMs / 1000));
}
