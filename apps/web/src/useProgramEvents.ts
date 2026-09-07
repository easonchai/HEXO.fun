/**
 * Real-time program events. Solana's RPC WebSocket pushes every transaction
 * log; the Anchor event coder decodes our typed events out of them. Every
 * connected viewer gets the same sub-second view of settles, positions,
 * deposits and draws, with no custom WebSocket backend. The API's `/feed`
 * supplies only pre-subscription history.
 */
import { useEffect, useRef, useState } from "react";
import type { Connection } from "@solana/web3.js";

import { decodeEventLogs, PROGRAM_ID, type HexVaultProgram } from "./chain.js";

export interface LiveEvent {
  key: string;
  /** Decoded name, camelCase as the Anchor client spells it. */
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
  /** False when the WebSocket subscription never started. */
  live: boolean;
}

const MAX_EVENTS = 60;

/** Subscribes to the program's logs; newest first. Null program = silent. */
export function useProgramEvents(
  program: HexVaultProgram | null,
  connection: Connection,
): ProgramEvents {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [live, setLive] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!program) {
      setLive(false);
      return;
    }
    let subscription: number;
    try {
      subscription = connection.onLogs(
        PROGRAM_ID,
        ({ logs, signature }, { slot }) => {
          const decoded = decodeEventLogs(program, logs);
          if (decoded.length === 0) return;
          const rows = decoded.map((event) => {
            seq.current += 1;
            return {
              key: `${slot}-${signature}-${seq.current}`,
              name: event.name,
              slot,
              signature,
              data: event.data ?? {},
              at: Date.now(),
            };
          });
          setEvents((current) => [...rows.reverse(), ...current].slice(0, MAX_EVENTS));
        },
        "confirmed",
      );
    } catch {
      setLive(false);
      return;
    }
    setLive(true);

    return () => {
      setLive(false);
      void connection.removeOnLogsListener(subscription);
    };
  }, [program, connection]);

  return { events, live };
}
