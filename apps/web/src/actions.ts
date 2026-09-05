/**
 * The five instructions this app sends. Each builds from the IDL by name,
 * signs with the connected wallet, confirms at `confirmed` and returns the
 * signature; the caller triggers the chain re-read.
 *
 * `settlePosition` and `register` are permissionless: the program takes no
 * signer for them, so the connected wallet is only the fee payer.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

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
} from "./chain.js";
import type { PoolLike } from "./read.js";

export type { PoolLike };

export interface TxSigner {
  readonly publicKey: PublicKey;
}

const CONFIRMED = { commitment: "confirmed" } as const;

export async function deposit(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  return method(
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
    ])
    .rpc(CONFIRMED);
}

export async function withdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  return method(
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
    })
    .rpc(CONFIRMED);
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
  return method(program, "buyPosition")(bn(tilesMask), bn(stakePerTile))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      round,
      position: positionAddress(round, o),
      systemProgram: SystemProgram.programId,
    })
    .rpc(CONFIRMED);
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
  return method(program, "settlePosition")()
    .accounts({
      pool: pool.address,
      round,
      player: playerAddress(pool.address, o),
      owner: o,
      position: positionAddress(round, o),
    })
    .rpc(CONFIRMED);
}

/** Records this Player's final Weight in an ended epoch that is Registering. */
export async function register(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epochId: bigint,
): Promise<string> {
  const o = owner.publicKey;
  return method(program, "register")()
    .accounts({
      pool: pool.address,
      epoch: epochAddress(pool.address, epochId),
      player: playerAddress(pool.address, o),
    })
    .rpc(CONFIRMED);
}
