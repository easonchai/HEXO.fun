/** Decoded chain reads. Every balance the UI shows is re-read from chain here. */
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

import {
  accountOf,
  epochAddress,
  positionAddress,
  randomnessAddress,
  roundAddress,
  toBigint,
  type HexVaultProgram,
} from "./chain.js";

export interface PoolRow {
  poolId: bigint;
  paused: boolean;
  acceptedMint: PublicKey;
  acceptedTokenProgram: PublicKey;
  acceptedDecimals: number;
  principalMint: PublicKey;
  entryMint: PublicKey;
  principalVault: PublicKey;
  prizeVault: PublicKey;
  jackpotVault: PublicKey;
  minDeposit: bigint;
  maxStakePerTile: bigint;
  maxRoundBonusEntries: bigint;
  minEpochSeconds: bigint;
  maxEpochSeconds: bigint;
  roundCloseBufferSeconds: bigint;
  latestEpochId: bigint;
}

export interface EpochRow {
  pool: PublicKey;
  id: bigint;
  startsAt: bigint;
  entryCutoffAt: bigint;
  endsAt: bigint;
  prizeSnapshotAt: bigint;
  claimDeadline: bigint;
  status: number;
  prizeSnapshotRoot: number[];
  totalEntryWeight: bigint;
  prizeAmount: bigint;
  prizeTarget: bigint;
  jackpotStatus: number;
  jackpotAmount: bigint;
  jackpotTarget: bigint;
}

export interface RoundRow {
  pool: PublicKey;
  epoch: PublicKey;
  epochId: bigint;
  id: bigint;
  startsAt: bigint;
  endsAt: bigint;
  status: number;
  winningTile: number;
  bonusEntries: bigint;
  totalStake: bigint;
  tileStakes: bigint[];
}

export interface PositionRow {
  pool: PublicKey;
  owner: PublicKey;
  round: PublicKey;
  roundId: bigint;
  tiles: bigint;
  stakePerTile: bigint;
  rewardClaimed: boolean;
}

export interface RandomnessRow {
  pool: PublicKey;
  kind: number;
  status: number;
  subject: PublicKey;
  epochId: bigint;
  roundId: bigint;
}

/** A pool row plus its own address: what every screen needs. */
export type PoolLike = { address: PublicKey } & PoolRow;

/**
 * Anchor decodes accounts with the IDL's snake_case field names and BN for
 * u64/i64. The UI works in camelCase + bigint, so normalize once, here.
 * Pubkeys are re-keyed through THIS copy of web3.js: dependency hoisting can
 * put a second copy in the bundle, and foreign PublicKey instances break the
 * spl-token helpers (`mint.toBuffer is not a function`).
 */
function normalize(value: unknown): unknown {
  if (value instanceof BN) return toBigint(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof PublicKey) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function" &&
    typeof (value as { toBytes?: unknown }).toBytes === "function"
  ) {
    // Duck-type a PublicKey from any web3.js copy (they all expose both).
    return new PublicKey((value as { toBase58(): string }).toBase58());
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const camel = key.replace(/_([a-zA-Z0-9])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      out[camel] = normalize(item);
    }
    return out;
  }
  return value;
}

function decode<T>(raw: unknown): T {
  return normalize(raw) as T;
}

/** Every pool the program holds (localnet volumes are tiny). */
export async function listPools(
  program: HexVaultProgram,
): Promise<{ address: PublicKey; pool: PoolRow }[]> {
  const accounts = await accountOf(program, "pool").all();
  return accounts.map(({ publicKey, account }) => ({
    address: publicKey,
    pool: decode<PoolRow>(account),
  }));
}

export async function fetchPool(
  program: HexVaultProgram,
  address: PublicKey,
): Promise<PoolRow | null> {
  try {
    return decode<PoolRow>(await accountOf(program, "pool").fetch(address));
  } catch {
    return null;
  }
}

/** Epochs 1..latestEpochId for a pool; gaps come back null and are dropped. */
export async function listEpochs(
  program: HexVaultProgram,
  pool: PublicKey,
  latestEpochId: bigint,
): Promise<EpochRow[]> {
  if (latestEpochId <= 0n) return [];
  const keys = Array.from({ length: Number(latestEpochId) }, (_, i) =>
    epochAddress(pool, BigInt(i + 1)),
  );
  const rows = await accountOf(program, "epoch").fetchMultiple(keys);
  return rows.flatMap((row) => (row ? [decode<EpochRow>(row)] : []));
}

export async function listRounds(
  program: HexVaultProgram,
  epochKeys: PublicKey[],
): Promise<RoundRow[]> {
  if (epochKeys.length === 0) return [];
  const wanted = new Set(epochKeys.map((key) => key.toBase58()));
  const accounts = await accountOf(program, "round").all();
  return accounts
    .filter(({ account }) =>
      wanted.has(String((account as Record<string, unknown>).epoch)),
    )
    .map(({ account }) => decode<RoundRow>(account))
    .sort(byRoundOrder);
}

const byRoundOrder = (a: RoundRow, b: RoundRow): number =>
  a.epochId === b.epochId ? Number(a.id - b.id) : Number(a.epochId - b.epochId);

/** One position per wallet per round; rounds without one are simply absent. */
export async function listPositions(
  program: HexVaultProgram,
  pool: PublicKey,
  owner: PublicKey,
  rounds: RoundRow[],
): Promise<Map<string, PositionRow>> {
  if (rounds.length === 0) return new Map();
  const keys = rounds.map((round) =>
    positionAddress(pool, roundAddressOf(round), owner),
  );
  const rows = await accountOf(program, "position").fetchMultiple(keys);
  const out = new Map<string, PositionRow>();
  rows.forEach((row, index) => {
    const round = rounds[index]!;
    const key = `${round.epochId}:${round.id}`;
    if (row) out.set(key, decode<PositionRow>(row));
  });
  return out;
}

const roundAddressOf = (round: RoundRow): PublicKey =>
  roundAddress(round.pool, round.epochId, round.id);

/**
 * Prize (kind 1) and jackpot (kind 2) requests for every epoch, keyed
 * "prize:<id>" / "jackpot:<id>". One fetchMultiple instead of 2N single
 * fetches — this ran on every refresh and dominated the RPC call count.
 */
export async function listRandomness(
  program: HexVaultProgram,
  pool: PublicKey,
  epochs: EpochRow[],
): Promise<Map<string, RandomnessRow>> {
  const out = new Map<string, RandomnessRow>();
  if (epochs.length === 0) return out;
  const kinds = [1, 2] as const;
  const keys = epochs.flatMap((epoch) =>
    kinds.map((kind) =>
      randomnessAddress(pool, epochAddress(pool, epoch.id), kind),
    ),
  );
  const rows = await accountOf(program, "randomnessRequest").fetchMultiple(keys);
  rows.forEach((row, index) => {
    if (!row) return;
    const epoch = epochs[Math.floor(index / kinds.length)]!;
    const kind = kinds[index % kinds.length]!;
    out.set(
      `${kind === 1 ? "prize" : "jackpot"}:${epoch.id}`,
      decode<RandomnessRow>(row),
    );
  });
  return out;
}
