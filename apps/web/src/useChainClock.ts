/**
 * Chain-anchored clock. Every countdown and window check derives from chain
 * block time, not the browser clock — local test validators run chain time
 * far faster than wall time, so wall-clock timers would lie. We anchor on the
 * Clock sysvar (slot and unix_timestamp in one account read, the same source
 * the program's `now()` uses), tick locally between resyncs, and resync every
 * minute to absorb drift.
 */
import { useEffect, useRef, useState } from "react";
import { SYSVAR_CLOCK_PUBKEY, type Connection } from "@solana/web3.js";

export interface ChainClock {
  /** Chain time in seconds, ticking ~4x/second. Null until first anchor. */
  now: bigint | null;
  /** Most recent observed slot (header chip). */
  slot: number | null;
}

const RESYNC_MS = 60_000;

/** Clock sysvar layout: slot u64 at 0, unix_timestamp i64 at 32. */
const readClock = (data: Uint8Array): { slot: number; unixTimestamp: number } => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    slot: Number(view.getBigUint64(0, true)),
    unixTimestamp: Number(view.getBigInt64(32, true)),
  };
};

export function useChainClock(connection: Connection): ChainClock {
  const [state, setState] = useState<ChainClock>({ now: null, slot: null });
  /** Offset = chainTimeMs - performance.now(), refined at each resync. */
  const offsetRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const anchor = async () => {
      try {
        const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
        if (!info || cancelled) return;
        const { slot, unixTimestamp } = readClock(info.data);
        offsetRef.current = unixTimestamp * 1000 - performance.now();
        setState((current) => ({
          now: BigInt(unixTimestamp),
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
