/**
 * Chain-anchored clock. Every countdown and window check derives from chain
 * time, not the browser clock — local test validators run chain time far
 * faster than wall time, so wall-clock timers would lie.
 *
 * Ticket 07: the chain read is gone. `chainTimeSeconds` is `GET /state`'s
 * `chainTime` field (the backend's own extrapolated Clock sysvar read), fed
 * in by whoever owns the state poll; this hook only ticks locally between
 * syncs and resyncs whenever that value changes — which happens on every
 * poll, including the immediate one on tab focus, so a wrong local clock
 * never shows the draw firing early and a fast local validator stays in
 * step. The interpolation itself lives in `clock.ts`, tested on its own.
 */
import { useEffect, useRef, useState } from "react";

import { chainTimeNow, syncChainClock, type ChainClockSync } from "./clock.js";

const TICK_MS = 250;

export function useChainClock(chainTimeSeconds: bigint | null): bigint | null {
  const [now, setNow] = useState<bigint | null>(chainTimeSeconds);
  const syncRef = useRef<ChainClockSync | null>(null);

  useEffect(() => {
    if (chainTimeSeconds === null) return;
    syncRef.current = syncChainClock(chainTimeSeconds, performance.now());
    setNow(chainTimeSeconds);
  }, [chainTimeSeconds]);

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
