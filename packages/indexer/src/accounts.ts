import { BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * PoolCreated only carries the pool id and the accepted mint, so the remaining
 * columns are filled in by decoding the Pool account itself.
 */
export interface PoolAccount {
  poolId: bigint;
  paused: boolean;
  acceptedMint: string;
  acceptedTokenProgram: string;
  acceptedDecimals: number;
  principalMint: string;
  entryMint: string;
  principalVault: string;
  prizeVault: string;
  jackpotVault: string;
  minDeposit: bigint;
  maxStakePerTile: bigint;
  maxRoundBonusEntries: bigint;
  minEpochSeconds: bigint;
  maxEpochSeconds: bigint;
  roundCloseBufferSeconds: bigint;
  latestEpochId: bigint;
}

export const decodePool = (idl: Idl, data: Buffer): PoolAccount => {
  const coder = new BorshAccountsCoder(idl);
  const decoded = coder.decode<Record<string, unknown>>("Pool", data);
  const bn = (value: unknown): bigint => BigInt(String(value));
  const key = (value: unknown): string => String(value);
  return {
    poolId: bn(decoded.pool_id),
    paused: Boolean(decoded.paused),
    acceptedMint: key(decoded.accepted_mint),
    acceptedTokenProgram: key(decoded.accepted_token_program),
    acceptedDecimals: Number(decoded.accepted_decimals),
    principalMint: key(decoded.principal_mint),
    entryMint: key(decoded.entry_mint),
    principalVault: key(decoded.principal_vault),
    prizeVault: key(decoded.prize_vault),
    jackpotVault: key(decoded.jackpot_vault),
    minDeposit: bn(decoded.min_deposit),
    maxStakePerTile: bn(decoded.max_stake_per_tile),
    maxRoundBonusEntries: bn(decoded.max_round_bonus_entries),
    minEpochSeconds: bn(decoded.min_epoch_seconds),
    maxEpochSeconds: bn(decoded.max_epoch_seconds),
    roundCloseBufferSeconds: bn(decoded.round_close_buffer_seconds),
    latestEpochId: bn(decoded.latest_epoch_id),
  };
};

export const POOL_UPDATES = (
  pool: string,
  account: PoolAccount,
): [string, unknown[]] => [
  `UPDATE pools SET accepted_token_program = $2, accepted_decimals = $3,
     principal_mint = $4, entry_mint = $5, principal_vault = $6, prize_vault = $7,
     jackpot_vault = $8, min_deposit = $9, max_stake_per_tile = $10,
     max_round_bonus_entries = $11, min_epoch_seconds = $12, max_epoch_seconds = $13,
     round_close_buffer_seconds = $14, latest_epoch_id = GREATEST(latest_epoch_id, $15),
     paused = $16, updated_at = now()
   WHERE address = $1`,
  [
    pool,
    account.acceptedTokenProgram,
    account.acceptedDecimals,
    account.principalMint,
    account.entryMint,
    account.principalVault,
    account.prizeVault,
    account.jackpotVault,
    account.minDeposit.toString(),
    account.maxStakePerTile.toString(),
    account.maxRoundBonusEntries.toString(),
    account.minEpochSeconds.toString(),
    account.maxEpochSeconds.toString(),
    account.roundCloseBufferSeconds.toString(),
    account.latestEpochId.toString(),
    account.paused,
  ],
];

export const fetchPoolAccount = async (
  connection: Connection,
  address: PublicKey,
): Promise<Buffer | null> => {
  const info = await connection.getAccountInfo(address);
  return info?.data ? Buffer.from(info.data) : null;
};
