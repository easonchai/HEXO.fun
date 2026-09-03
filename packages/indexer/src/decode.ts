import { readFileSync } from "node:fs";
import { BorshEventCoder, type Idl } from "@anchor-lang/core";
import {
  EVENT_NAMES,
  asPublicKey,
  type Cursor,
  type EventName,
  type EventRow,
} from "./events.ts";

const PROGRAM_DATA_PREFIX = "Program data: ";
const KNOWN = new Set<string>(EVENT_NAMES);

export interface RawLog {
  readonly slot: bigint;
  readonly signature: string;
  readonly logs: readonly string[];
  readonly blockTime?: number | null;
}

export interface DecodedEvent {
  readonly name: EventName;
  readonly pool: string;
  readonly payload: Record<string, unknown>;
}

export const loadIdl = (path: string): Idl =>
  JSON.parse(readFileSync(path, "utf8")) as Idl;

/**
 * Anchor's coder hands back PublicKey objects and BN instances; neither is
 * JSON-serializable, so every field is flattened to strings/numbers here.
 */
const normalize = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  const candidate = value as {
    toBase58?: unknown;
    toString: (radix?: number) => string;
  };
  if (typeof candidate.toBase58 === "function") return candidate.toBase58();
  if (candidate.constructor?.name === "BN") return candidate.toString(10);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
};

export function createEventDecoder(
  idl: Idl,
): (log: string) => DecodedEvent | null {
  const coder = new BorshEventCoder(idl);
  return (log: string) => {
    if (!log.startsWith(PROGRAM_DATA_PREFIX)) return null;
    const decoded = coder.decode(log.slice(PROGRAM_DATA_PREFIX.length));
    if (!decoded || !KNOWN.has(decoded.name)) return null;
    const payload = normalize(decoded.data) as Record<string, unknown>;
    if (typeof payload.pool !== "string") return null;
    return {
      name: decoded.name as EventName,
      pool: payload.pool,
      payload,
    };
  };
}

/**
 * Extracts events from a transaction's log messages. Anchor emits each event as
 * `Program data: <base64>`; bare base64 lines are never guessed at.
 */
export function decodeLogs(
  logs: readonly string[],
  decode: (log: string) => DecodedEvent | null,
  programId?: string,
): DecodedEvent[] {
  const found: DecodedEvent[] = [];
  const invocationStack: string[] = [];
  for (const line of logs) {
    const invoked = line.match(/^Program (\S+) invoke \[\d+\]$/);
    if (invoked) {
      invocationStack.push(invoked[1]);
      continue;
    }
    const completed = line.match(/^Program (\S+) (?:success|failed:.*)$/);
    if (completed) {
      if (invocationStack.at(-1) === completed[1]) invocationStack.pop();
      continue;
    }
    if (programId && invocationStack.at(-1) !== programId) continue;
    const event = decode(line);
    if (event) found.push(event);
  }
  return found;
}

export interface Batch {
  /** Null when the batch carried no events — the cursor must not advance. */
  readonly cursor: Cursor | null;
  readonly events: EventRow[];
}

/** Turns raw finalized logs into ordered, storable rows. */
export function toEventRows(
  raw: readonly RawLog[],
  decode: (log: string) => DecodedEvent | null,
  programId: string,
): Batch {
  const events: EventRow[] = [];
  for (const entry of raw) {
    const decoded = decodeLogs(entry.logs, decode, programId);
    decoded.forEach((event, eventIndex) => {
      const cursor: Cursor = {
        slot: entry.slot,
        signature: entry.signature,
        eventIndex,
      };
      events.push({
        slot: entry.slot,
        signature: entry.signature,
        eventIndex,
        name: event.name,
        pool: asPublicKey(event.pool, "pool"),
        payload: { ...event.payload, programId },
        blockTime: entry.blockTime ?? null,
      });
    });
  }
  const last = events.at(-1);
  return {
    events,
    cursor: last
      ? {
          slot: last.slot,
          signature: last.signature,
          eventIndex: last.eventIndex,
        }
      : null,
  };
}
