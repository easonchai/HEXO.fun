/**
 * The five instructions this app sends. Each builds from the IDL by name,
 * signs with the connected wallet, confirms at `confirmed` and returns the
 * signature; the caller triggers the chain re-read.
 *
 * `settlePosition` and `register` are permissionless: the program takes no
 * signer for them, so the connected wallet is only the fee payer.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";

import {
  acceptedAta,
  bn,
  epochAddress,
  method,
  playerAddress,
  positionAddress,
  principalVaultAddress,
  roundAddress,
  TOKEN_PROGRAM,
  type HexVaultProgram,
  type TxBuilder,
} from "./chain.js";
import type { PoolLike } from "./read.js";

export type { PoolLike };

export interface TxSigner {
  readonly publicKey: PublicKey;
  /**
   * Wallet-owned send path (sign, broadcast, confirm; returns the base58
   * signature). When set, the transaction goes through it instead of
   * Anchor's `.rpc()`, so a sponsoring wallet can swap in its own fee payer.
   */
  readonly sendTransaction?:
    | ((transaction: Transaction) => Promise<string>)
    | undefined;
}

const CONFIRMED = { commitment: "confirmed" } as const;

/** Sends `builder` through the wallet's own path when it has one, else Anchor's. */
async function send(
  program: HexVaultProgram,
  owner: TxSigner,
  builder: TxBuilder,
): Promise<string> {
  if (!owner.sendTransaction) return builder.rpc(CONFIRMED);
  const transaction = await builder.transaction();
  transaction.feePayer = owner.publicKey;
  const { blockhash } =
    await program.provider.connection.getLatestBlockhash(CONFIRMED);
  transaction.recentBlockhash = blockhash;
  return owner.sendTransaction(transaction);
}

export async function deposit(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const builder = method(
    program,
    "deposit",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    // The faucet may already have created it; idempotent either way.
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        o,
        ownerToken,
        o,
        pool.acceptedMint,
        TOKEN_PROGRAM,
      ),
    ]);
  return send(program, owner, builder);
}

export async function withdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const builder = method(
    program,
    "withdraw",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      acceptedMint: pool.acceptedMint,
      ownerToken: acceptedAta(pool.acceptedMint, o),
      principalVault: principalVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM,
    });
  return send(program, owner, builder);
}

/** Stakes `stakePerTile` Entries on every tile set in `tilesMask`. */
export async function buyPosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
  tilesMask: bigint,
  stakePerTile: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, roundId);
  const builder = method(program, "buyPosition")(bn(tilesMask), bn(stakePerTile))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      round,
      position: positionAddress(round, o),
      systemProgram: SystemProgram.programId,
    });
  return send(program, owner, builder);
}

/** Credits the round reward as Entries and closes the Position (rent back). */
export async function settlePosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, roundId);
  const builder = method(program, "settlePosition")()
    .accounts({
      pool: pool.address,
      round,
      player: playerAddress(pool.address, o),
      owner: o,
      position: positionAddress(round, o),
    });
  return send(program, owner, builder);
}

/** Records this Player's final Weight in an ended epoch that is Registering. */
export async function register(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epochId: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const builder = method(program, "register")()
    .accounts({
      pool: pool.address,
      epoch: epochAddress(pool.address, epochId),
      player: playerAddress(pool.address, o),
    });
  return send(program, owner, builder);
}
