/**
 * Chain-anchored clock. Every countdown and window check derives from chain
 * block time, not the browser clock — local test validators run chain time
 * far faster than wall time, so wall-clock timers would lie. We anchor once
 * via getBlockTime on a recent slot, tick locally between resyncs, and resync
 * periodically (and on focus) to absorb drift.
 */
import { useEffect, useRef, useState } from "react";
import type { Connection } from "@solana/web3.js";

export interface ChainClock {
  /** Chain time in seconds, ticking ~4x/second. Null until first anchor. */
  now: bigint | null;
  /** Most recent observed slot (header chip). */
  slot: number | null;
}

const RESYNC_MS = 15_000;

export function useChainClock(connection: Connection): ChainClock {
  const [state, setState] = useState<ChainClock>({ now: null, slot: null });
  /** Offset = chainTimeMs - performance.now(), refined at each resync. */
  const offsetRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const anchor = async () => {
      try {
        const slot = await connection.getSlot("confirmed");
        const blockTime = await connection.getBlockTime(slot);
        if (blockTime === null || cancelled) return;
        offsetRef.current = blockTime * 1000 - performance.now();
        setState((current) => ({
          now: BigInt(blockTime),
          slot: Math.max(current.slot ?? 0, slot),
        }));
      } catch {
        // Keep the last good anchor; the interpolation keeps ticking.
      }
    };

    void anchor();
    const resync = setInterval(() => void anchor(), RESYNC_MS);
    const tick = setInterval(() => {
      const offset = offsetRef.current;
      if (offset === null || cancelled) return;
      const chainSeconds = Math.floor((performance.now() + offset) / 1000);
      setState((current) =>
        current.now === BigInt(chainSeconds)
          ? current
          : { now: BigInt(chainSeconds), slot: current.slot },
      );
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(resync);
      clearInterval(tick);
    };
  }, [connection]);

  return state;
}
