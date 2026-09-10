// The slice of on-chain state one tick needs, decoded out of Anchor's BN/
// PublicKey soup into plain bigints so the step logic (and its tests) never
// touch a coder. Mirrors programs/hex_vault/src/state.rs and constants.rs.
import type { Idl, Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

export const EPOCH_STATUS = {
  OPEN: 0,
  REGISTERING: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
} as const;

export const ROUND_STATUS = {
  OPEN: 0,
  REQUESTED: 1,
  SETTLED: 2,
  FORFEITED: 3,
  VOIDED: 4,
} as const;

export interface PoolState {
  readonly address: PublicKey;
  readonly authority: PublicKey;
  readonly acceptedMint: PublicKey;
  readonly treasury: PublicKey;
  readonly buybackReserve: PublicKey;
  readonly house: PublicKey;
  readonly vrfNetworkState: PublicKey;
  readonly epochSeconds: bigint;
  readonly roundSeconds: bigint;
  readonly closeBuffer: bigint;
  readonly vrfTimeout: bigint;
  readonly paused: boolean;
  readonly currentEpochId: bigint;
  readonly nextRoundId: bigint;
  readonly openRoundId: bigint;
  readonly totalPrincipal: bigint;
}

export interface EpochState {
  readonly epochId: bigint;
  readonly startsAt: bigint;
  readonly endsAt: bigint;
  readonly status: number;
  readonly registeredCount: number;
  readonly jackpotAmount: bigint;
  readonly vrfSeed: Uint8Array;
  readonly requestedAt: bigint;
  readonly target: bigint;
}

export interface RoundState {
  readonly roundId: bigint;
  readonly endsAt: bigint;
  readonly status: number;
  readonly vrfSeed: Uint8Array;
  readonly requestedAt: bigint;
}

/** Only the field the Sparring player spends; add more when something needs them. */
export interface PlayerState {
  readonly entries: bigint;
}

/** Anchor hands back BN for u64/u128 and number[] for byte arrays. */
type Decoded = Record<
  string,
  { toString(): string } | number | boolean | PublicKey | number[]
>;

const big = (value: unknown): bigint => BigInt(String(value));

export function decodePool(
  program: Program<Idl>,
  address: PublicKey,
  data: Buffer,
): PoolState {
  const raw = program.coder.accounts.decode<Decoded>("pool", data);
  return {
    address,
    authority: raw.authority as PublicKey,
    acceptedMint: raw.acceptedMint as PublicKey,
    treasury: raw.treasury as PublicKey,
    buybackReserve: raw.buybackReserve as PublicKey,
    house: raw.house as PublicKey,
    vrfNetworkState: raw.vrfNetworkState as PublicKey,
    epochSeconds: big(raw.epochSeconds),
    roundSeconds: big(raw.roundSeconds),
    closeBuffer: big(raw.closeBuffer),
    vrfTimeout: big(raw.vrfTimeout),
    paused: raw.paused === true,
    currentEpochId: big(raw.currentEpochId),
    nextRoundId: big(raw.nextRoundId),
    openRoundId: big(raw.openRoundId),
    totalPrincipal: big(raw.totalPrincipal),
  };
}

export function decodeEpoch(program: Program<Idl>, data: Buffer): EpochState {
  const raw = program.coder.accounts.decode<Decoded>("epoch", data);
  return {
    epochId: big(raw.epochId),
    startsAt: big(raw.startsAt),
    endsAt: big(raw.endsAt),
    status: Number(raw.status),
    registeredCount: Number(raw.registeredCount),
    jackpotAmount: big(raw.jackpotAmount),
    vrfSeed: Uint8Array.from(raw.vrfSeed as number[]),
    requestedAt: big(raw.requestedAt),
    target: big(raw.target),
  };
}

export function decodeRound(program: Program<Idl>, data: Buffer): RoundState {
  const raw = program.coder.accounts.decode<Decoded>("round", data);
  return {
    roundId: big(raw.roundId),
    endsAt: big(raw.endsAt),
    status: Number(raw.status),
    vrfSeed: Uint8Array.from(raw.vrfSeed as number[]),
    requestedAt: big(raw.requestedAt),
  };
}

export function decodePlayer(program: Program<Idl>, data: Buffer): PlayerState {
  const raw = program.coder.accounts.decode<Decoded>("player", data);
  return { entries: big(raw.entries) };
}

/**
 * `unix_timestamp` out of the Clock sysvar: slot, epoch_start_timestamp,
 * epoch, leader_schedule_epoch, then the i64 we want at offset 32. The tick
 * compares against on-chain deadlines, and a test validator's slot-derived
 * clock drifts from wall time under load, so `Date.now()` is not usable here.
 */
export function clockUnixTimestamp(data: Buffer | undefined): bigint {
  if (!data || data.length < 40) {
    throw new Error("clock sysvar account is missing or truncated");
  }
  return data.readBigInt64LE(32);
}
