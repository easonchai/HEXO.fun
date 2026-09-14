/**
 * Chain-anchored clock. Every countdown and window check derives from chain
 * time, not the browser clock — local test validators run chain time far
 * faster than wall time, so wall-clock timers would lie.
 *
 * Ticket 07: the chain read is gone. `chainTimeSeconds` is `GET /state`'s
 * `chainTime` field (the backend's own extrapolated Clock sysvar read), fed
 * in by whoever owns the state poll. The interpolation itself lives in
 * `clock.ts`, tested on its own.
 *
 * It anchors once per round, not once per poll. Devnet's `unix_timestamp` is
 * a stake-weighted median of validator vote timestamps: measured 1.40 s behind
 * wall time with a 2.23 s spread and no cumulative drift (1.0019 chain-seconds
 * per wall-second). Both sides serve whole seconds, so re-anchoring on every
 * changed value dragged the local second boundary back and forth by up to a
 * second every 2 s, and that is what the countdown stutter was. Between
 * anchors it free-runs on `performance.now()`, worth 0.17 s of error across a
 * 90 s round. `roundId` changing is a round boundary, where the stage resets
 * anyway, so the correction there does not show.
 */
import { useEffect, useRef, useState } from "react";

import {
  chainTimeNow,
  needsResync,
  syncChainClock,
  type ChainClockSync,
} from "./clock.js";

const TICK_MS = 250;

/**
 * How far the served time has to be from the local one to re-anchor without
 * waiting for a round boundary. Above the 2.23 s jitter, so ordinary devnet
 * noise never trips it. What does trip it: a local validator running chain
 * time faster than wall time, which pulls away within seconds and so keeps
 * resyncing on nearly every poll the way this hook used to; a
 * `performance.now()` that stopped while the device slept; and a pool left
 * sitting on one round long enough for the rate difference to add up, about
 * 26 minutes at the measured devnet rate.
 */
const RESYNC_TOLERANCE_SECONDS = 3n;

export function useChainClock(
  chainTimeSeconds: bigint | null,
  roundId: bigint | null,
): bigint | null {
  const [now, setNow] = useState<bigint | null>(chainTimeSeconds);
  const syncRef = useRef<ChainClockSync | null>(null);
  const anchoredRoundRef = useRef<bigint | null>(null);

  useEffect(() => {
    if (chainTimeSeconds === null) return;
    const sync = syncRef.current;
    const sameRound = sync !== null && roundId === anchoredRoundRef.current;
    if (
      sameRound &&
      !needsResync(sync, chainTimeSeconds, performance.now(), RESYNC_TOLERANCE_SECONDS)
    ) {
      return;
    }
    anchoredRoundRef.current = roundId;
    syncRef.current = syncChainClock(chainTimeSeconds, performance.now());
    setNow(chainTimeSeconds);
  }, [chainTimeSeconds, roundId]);

  useEffect(() => {
    const tick = setInterval(() => {
      const sync = syncRef.current;
      if (!sync) return;
      const next = chainTimeNow(sync, performance.now());
      setNow((current) => (current === next ? current : next));
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  return now;
}
