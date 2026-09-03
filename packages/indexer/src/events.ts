/**
 * Cursor ordering, envelope shape and amount coercion for the 22 HexVault
 * Anchor events. Every event carries a `pool` Pubkey.
 */

export const EVENT_NAMES = [
  "DepositRecorded",
  "WithdrawalRecorded",
  "EntriesRefreshed",
  "PositionPurchased",
  "RoundRandomnessRequested",
  "RoundSettled",
  "RoundRewardClaimed",
  "PrizeFunded",
  "JackpotFunded",
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
  "EpochCreated",
  "PoolCreated",
  "ProtocolPauseChanged",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface Cursor {
  readonly slot: bigint;
  readonly signature: string;
  readonly eventIndex: number;
}

export interface EventEnvelope<TName extends EventName = EventName> {
  readonly programId: string;
  readonly name: TName;
  readonly pool: string;
  readonly data: Record<string, EventField>;
  readonly cursor: Cursor;
  readonly slot: bigint;
  readonly blockTime?: number;
}

export type EventField = string | number | boolean | bigint | number[] | null;

export type EventRow = {
  slot: bigint;
  signature: string;
  eventIndex: number;
  name: EventName;
  pool: string;
  payload: Record<string, unknown>;
  blockTime: number | null;
};

export const cursorKey = (cursor: Cursor): string =>
  `${cursor.slot}:${cursor.signature}:${cursor.eventIndex}`;

export const compareCursor = (left: Cursor, right: Cursor): number => {
  if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1;
  if (left.signature !== right.signature) {
    return left.signature < right.signature ? -1 : 1;
  }
  return left.eventIndex - right.eventIndex;
};

export const asAtomicAmount = (value: unknown, field: string): bigint => {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${field} must be an unsigned atomic amount`);
};

export const asPublicKey = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty public-key string`);
  }
  return value;
};

export const asBytes32 = (value: unknown, field: string): Buffer => {
  const bytes = Array.isArray(value)
    ? Buffer.from(value as number[])
    : Buffer.from([]);
  if (bytes.length !== 32) throw new Error(`${field} must be 32 bytes`);
  return bytes;
};
