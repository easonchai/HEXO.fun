export type AtomicAmount = bigint;

export type IndexerEventName =
  | "DepositRecorded"
  | "WithdrawalRecorded"
  | "EntriesRefreshed"
  | "PositionPurchased"
  | "RoundRandomnessRequested"
  | "RoundSettled"
  | "RoundRewardClaimed"
  | "PrizeFunded"
  | "PrizeSnapshotCommitted"
  | "PrizeRandomnessRequested"
  | "PrizeDrawn"
  | "PrizeClaimed"
  | "ProtocolPauseChanged";

export interface Cursor {
  readonly slot: bigint;
  readonly signature: string;
  readonly eventIndex: number;
}

export interface EventEnvelope<
  TName extends IndexerEventName = IndexerEventName,
> {
  readonly programId: string;
  readonly name: TName;
  readonly data: Record<string, unknown>;
  readonly cursor: Cursor;
  readonly finality: "finalized";
}

export const cursorKey = (cursor: Cursor): string =>
  `${cursor.slot}:${cursor.signature}:${cursor.eventIndex}`;

export const compareCursor = (left: Cursor, right: Cursor): number => {
  if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1;
  if (left.signature !== right.signature) {
    return left.signature < right.signature ? -1 : 1;
  }
  return left.eventIndex - right.eventIndex;
};

export const asAtomicAmount = (value: unknown, field: string): AtomicAmount => {
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
