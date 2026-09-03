/** Program ids, PDA derivation and chain reads. Chain is authoritative. */
import idl from "./idl/hex_vault.json";
import { BN, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

/** Program id from the synced IDL (see scripts/sync-idl.mjs). */
export type HexVaultProgram = Program<Idl>;

/** Builder returned by `program.methods.<name>(...)`. */
export interface TxBuilder {
  accounts(accounts: Record<string, unknown>): TxBuilder;
  rpc(): Promise<string>;
}

/** Decoded-account accessor for one account type. */
export interface AccountApi {
  fetch(address: PublicKey): Promise<unknown>;
  fetchMultiple(addresses: PublicKey[]): Promise<(unknown | null)[]>;
  all(): Promise<{ publicKey: PublicKey; account: unknown }[]>;
}

/**
 * Loosely-typed view of the Anchor client: we drive it by IDL name instead of
 * generated types, so the app needs no codegen step.
 */
export interface ProgramApi {
  readonly methods: Record<string, (...args: unknown[]) => TxBuilder>;
  readonly account: Record<string, AccountApi>;
}

export const apiOf = (program: HexVaultProgram): ProgramApi =>
  program as unknown as ProgramApi;

/** Instruction builder by IDL name; fails loudly on a stale IDL copy. */
export const method = (
  program: HexVaultProgram,
  name: string,
): ((...args: unknown[]) => TxBuilder) => {
  const build = apiOf(program).methods[name];
  if (!build)
    throw new Error(`IDL has no instruction "${name}" (re-run sync-idl)`);
  return build;
};

/** Decoded-account accessor by IDL name. */
export const accountOf = (
  program: HexVaultProgram,
  name: string,
): AccountApi => {
  const api = apiOf(program).account[name];
  if (!api) throw new Error(`IDL has no account "${name}" (re-run sync-idl)`);
  return api;
};

export const PROGRAM_ID = new PublicKey(idl.address);

export const bn = (value: bigint | number | string): BN =>
  new BN(value.toString());

export const toBigint = (value: BN): bigint => BigInt(value.toString());

const pda = (seeds: (Uint8Array | Buffer)[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const le8 = (value: bigint): Buffer => bn(value).toArrayLike(Buffer, "le", 8);

export const configAddress = (): PublicKey => pda([Buffer.from("config")]);
export const poolAddress = (poolId: bigint): PublicKey =>
  pda([Buffer.from("pool"), le8(poolId)]);
export const epochAddress = (pool: PublicKey, epochId: bigint): PublicKey =>
  pda([Buffer.from("epoch"), pool.toBuffer(), le8(epochId)]);
/** Seeds mirror lib.rs: ["round", pool, epoch_id_le8, round_id_le8]. */
export const roundAddress = (
  pool: PublicKey,
  epochId: bigint,
  roundId: bigint,
): PublicKey =>
  pda([Buffer.from("round"), pool.toBuffer(), le8(epochId), le8(roundId)]);
export const playerAddress = (pool: PublicKey, owner: PublicKey): PublicKey =>
  pda([Buffer.from("player"), pool.toBuffer(), owner.toBuffer()]);
export const positionAddress = (
  pool: PublicKey,
  round: PublicKey,
  owner: PublicKey,
): PublicKey =>
  pda([
    Buffer.from("position"),
    pool.toBuffer(),
    round.toBuffer(),
    owner.toBuffer(),
  ]);
export const randomnessAddress = (
  pool: PublicKey,
  subject: PublicKey,
  kind: number,
): PublicKey =>
  pda([
    Buffer.from("randomness"),
    pool.toBuffer(),
    subject.toBuffer(),
    Buffer.from([kind]),
  ]);
export const principalVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("principal-vault"), pool.toBuffer()]);
export const prizeVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("prize-vault"), pool.toBuffer()]);
export const jackpotVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("jackpot-vault"), pool.toBuffer()]);

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
export const ASSOCIATED_TOKEN = ASSOCIATED_TOKEN_PROGRAM_ID;

/** Owner token account for a receipt mint (PT or ET), always token-2022. */
export const receiptAta = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

/** Owner token account for the accepted asset, in the pool's own token program. */
export const acceptedAta = (
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): PublicKey => getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);

/** Token balance in atomic units; a missing account reads as zero. */
export async function tokenBalance(
  connection: Connection,
  account: PublicKey,
): Promise<bigint> {
  try {
    const { value } = await connection.getTokenAccountBalance(account);
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}
