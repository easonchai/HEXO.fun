/**
 * Real-time program events. Solana's RPC WebSocket pushes every transaction
 * log; the Anchor client decodes our typed events from it. This gives every
 * connected viewer the same sub-second view of settles, buys, deposits, and
 * draws — no custom WebSocket backend. The REST /events feed supplies only
 * pre-subscription history.
 */
import { useEffect, useRef, useState } from "react";

import type { HexVaultProgram } from "./chain.js";

export interface LiveEvent {
  key: string;
  name: string;
  slot: number;
  signature: string;
  /** Decoded event fields (camelCase, BN left as-is). */
  data: Record<string, unknown>;
  /** Local receive timestamp, for feed ordering. */
  at: number;
}

export interface ProgramEvents {
  events: LiveEvent[];
  /** False when the WebSocket subscription failed (polling fallback covers). */
  live: boolean;
}

/** Every event name the IDL declares — kept in sync by useProgramEvents.test.ts. */
export const EVENT_NAMES = [
  "PoolCreated",
  "EpochCreated",
  "DepositRecorded",
  "WithdrawalRecorded",
  "EntriesRefreshed",
  "PositionPurchased",
  "RoundRandomnessRequested",
  "RoundSettled",
  "RoundRewardClaimed",
  "PrizeSnapshotCommitted",
  "JackpotCommitted",
  "PrizeRandomnessRequested",
  "JackpotRandomnessRequested",
  "PrizeDrawn",
  "JackpotDrawn",
  "PrizeClaimed",
  "JackpotClaimed",
  "PrizeExpired",
  "JackpotExpired",
  "ProtocolPauseChanged",
  "PrizeFunded",
  "JackpotFunded",
] as const;

const MAX_EVENTS = 60;

/** Subscribes to every program event; newest first. Null program = silent. */
export function useProgramEvents(
  program: HexVaultProgram | null,
): ProgramEvents {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [live, setLive] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!program) return;
    // The loosely-typed program view needs the raw Anchor event emitter.
    const emitter = program as unknown as {
      addEventListener?: (
        name: string,
        callback: (data: unknown, slot: number, signature: string) => void,
      ) => number;
      removeEventListener?: (id: number) => Promise<void>;
    };
    if (!emitter.addEventListener || !emitter.removeEventListener) {
      setLive(false);
      return;
    }

    const ids: number[] = [];
    const push =
      (name: string) => (data: unknown, slot: number, signature: string) => {
        seq.current += 1;
        const event: LiveEvent = {
          key: `${slot}-${signature}-${seq.current}`,
          name,
          slot,
          signature,
          data: (data ?? {}) as Record<string, unknown>,
          at: Date.now(),
        };
        setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
      };

    let failed = false;
    for (const name of EVENT_NAMES) {
      try {
        ids.push(emitter.addEventListener(name, push(name)));
      } catch {
        failed = true;
      }
    }
    setLive(ids.length > 0 && !failed);

    return () => {
      for (const id of ids) void emitter.removeEventListener!(id);
    };
  }, [program]);

  return { events, live };
}
