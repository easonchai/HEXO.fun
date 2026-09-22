/**
 * The six instructions this app sends. Each builds from the IDL by name,
 * signs with the connected wallet, confirms at `confirmed` and returns the
 * signature; the caller triggers the chain re-read.
 *
 * `settlePosition`, `register` and `processWithdraw` are permissionless: the
 * program takes no signer for them, so the connected wallet is only the fee
 * payer.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  acceptedAta,
  bn,
  epochAddress,
  jackpotVaultAddress,
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
import { shutdownWithdrawStep } from "./shutdown.js";

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

/**
 * Sends more than one instruction in one transaction (ticket 11's one-step
 * shutdown withdraw): there is no single `TxBuilder` to call `.rpc()` on, so
 * a wallet with no sponsored `sendTransaction` signs and submits the way
 * `.rpc()` does under the hood (`@anchor-lang/core`'s `RpcFactory`).
 */
async function sendMany(
  program: HexVaultProgram,
  owner: TxSigner,
  instructions: TransactionInstruction[],
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = owner.publicKey;
  const { blockhash } =
    await program.provider.connection.getLatestBlockhash(CONFIRMED);
  transaction.recentBlockhash = blockhash;
  if (owner.sendTransaction) return owner.sendTransaction(transaction);
  // SAFETY: App.tsx only ever builds this Program from an AnchorProvider,
  // whose `sendAndConfirm` is always implemented; the SDK's `Provider` type
  // just marks it optional for providers that never sign.
  const provider = program.provider as unknown as {
    sendAndConfirm(tx: Transaction, signers: never[], opts: typeof CONFIRMED): Promise<string>;
  };
  return provider.sendAndConfirm(transaction, [], CONFIRMED);
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

/**
 * Spends `amount` USDC into the jackpot vault for `amount × ticketsPerUsdc`
 * Tickets (ticket 10). Per Player per day the program caps total spend at
 * Principal, checked live: fails with `DailyBuyCapExceeded` over the cap,
 * `HouseCannotBuyTickets` for the House Player.
 */
export async function buyTickets(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const builder = method(
    program,
    "buyTickets",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
      acceptedMint: pool.acceptedMint,
      ownerToken: acceptedAta(pool.acceptedMint, o),
      jackpotVault: jackpotVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM,
    });
  return send(program, owner, builder);
}

/**
 * Books the withdrawal. No USDC moves here: `process_withdraw` pays it out
 * once the epoch this lands in has ended (ADR 0009). Ticket 05 builds the UI
 * around the wait; this is the same button pointed at the new instruction.
 */
export async function requestWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const builder = method(
    program,
    "requestWithdraw",
  )(bn(amount))
    .accounts({
      owner: o,
      pool: pool.address,
      player: playerAddress(pool.address, o),
    });
  return send(program, owner, builder);
}

/**
 * Pays out the whole pending amount. The program takes no signer, so this is
 * the depositor's own escape hatch when the operator has not pushed it yet:
 * the wallet only pays the fee. Fails with `WithdrawalNotDue` before the
 * requesting epoch has ended and `InsufficientVaultLiquidity` while the
 * vault is short, so the caller gates it on the pending row's `due` state.
 */
export async function processWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
): Promise<string> {
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const builder = method(program, "processWithdraw")()
    .accounts({
      pool: pool.address,
      player: playerAddress(pool.address, o),
      acceptedMint: pool.acceptedMint,
      ownerToken,
      principalVault: principalVaultAddress(pool.address),
      tokenProgram: TOKEN_PROGRAM,
    })
    // A mainnet depositor may have closed the ATA since depositing; the
    // transfer needs it back, and this costs nothing when it is already there.
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

/**
 * Ticket 11: `process_withdraw` skips the epoch lock while the pool is shut
 * down (custody.rs), so a fresh request and its payout collapse into one
 * transaction instead of the ordinary two. `shutdownWithdrawStep` decides
 * which instructions that needs; a Player with only an earlier pending
 * amount and nothing new to request sends `process_withdraw` alone.
 */
export async function shutdownWithdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  requestAmount: bigint,
  pendingWithdraw: bigint,
): Promise<string> {
  const step = shutdownWithdrawStep(requestAmount, pendingWithdraw);
  if (step.kind === "none") throw new Error("nothing to withdraw");
  const o = owner.publicKey;
  const ownerToken = acceptedAta(pool.acceptedMint, o);
  const instructions: TransactionInstruction[] = [];
  if (step.kind === "request-and-process") {
    instructions.push(
      await method(
        program,
        "requestWithdraw",
      )(bn(step.amount))
        .accounts({
          owner: o,
          pool: pool.address,
          player: playerAddress(pool.address, o),
        })
        .instruction(),
    );
  }
  instructions.push(
    // A mainnet depositor may have closed the ATA since depositing; the
    // transfer needs it back, and this costs nothing when it is already there.
    createAssociatedTokenAccountIdempotentInstruction(
      o,
      ownerToken,
      o,
      pool.acceptedMint,
      TOKEN_PROGRAM,
    ),
    await method(program, "processWithdraw")()
      .accounts({
        pool: pool.address,
        player: playerAddress(pool.address, o),
        acceptedMint: pool.acceptedMint,
        ownerToken,
        principalVault: principalVaultAddress(pool.address),
        tokenProgram: TOKEN_PROGRAM,
      })
      .instruction(),
  );
  return sendMany(program, owner, instructions);
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
