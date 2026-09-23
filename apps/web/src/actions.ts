/**
 * The six instructions this app sends. Each builds from the IDL by name and
 * goes through `sendMany` (ticket 08, production-hardening): a compute
 * budget sized from a public-RPC simulation, signed through the wallet
 * adapter or Privy, confirmed with the blockhash strategy at `confirmed`.
 * The caller gets a `SendResult` — `landed`, `expired` or `failed(code,
 * message)` — instead of a bare signature or a thrown error, and triggers
 * the chain re-read only on `landed`.
 *
 * `settlePosition`, `register` and `processWithdraw` are permissionless: the
 * program takes no signer for them, so the connected wallet is only the fee
 * payer.
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
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
   * Privy's sponsored path: signs and broadcasts, returning the base58
   * signature straight away — it does not itself wait for the transaction to
   * land (research/notes/frontend_and_wallets.md). `sendMany` confirms it the
   * same way as every other path (ticket 08), so a dropped sponsored send
   * still resolves to `expired`/`failed` instead of hanging. Unset for the
   * ordinary wallet-adapter path, which signs through `program.provider`.
   */
  readonly sendTransaction?:
    | ((transaction: Transaction) => Promise<string>)
    | undefined;
}

/** One player transaction's outcome (ticket 08): `sendMany` always resolves
 *  to one of these once a transaction has actually reached the network —
 *  never a hang, and never a raw thrown RPC error for these three cases. A
 *  rejected signature or a failed blockhash fetch, which never reach the
 *  network, still throw; callers keep their existing catch block for those. */
export type SendResult =
  | { readonly kind: "landed"; readonly signature: string }
  /** The blockhash expired before the transaction confirmed: dropped, not
   *  failed. The UI's answer is "try again", not the decoded program error. */
  | { readonly kind: "expired" }
  /** `code` is the on-chain `Custom` program error number when the failure
   *  carries one (`playerErrors.ts`'s `decodeErrorCode` turns it into player
   *  copy), null otherwise. `message` is the raw diagnostic for `console.error`. */
  | { readonly kind: "failed"; readonly code: number | null; readonly message: string };

const CONFIRMED = "confirmed" as const;

/** Solana's hard compute-unit ceiling per transaction, the generous limit
 *  the simulation probe below runs under before pricing the real one. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Margin over a simulation's `unitsConsumed`, same as the backend's
 *  (chain.service.ts `COMPUTE_UNIT_MARGIN`): rounded up, so a transaction
 *  never lands one unit short of what it measured. */
const COMPUTE_UNIT_MARGIN = 1.1;

/** `setComputeUnitLimit` when the public RPC's simulation fails: the
 *  runtime's own per-instruction default (solana.com's Compute Budget doc),
 *  so a struggling simulation still gets a transaction sent instead of
 *  blocking the send on it. */
const FALLBACK_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

/** The slice of `program.provider` this file signs and reads a blockhash
 *  through — narrower than Anchor's own `Provider` type so a test stub needs
 *  no more than this to stand in for one. */
interface SendProvider {
  connection: Connection;
  wallet?: { signTransaction<T>(tx: T): Promise<T> } | undefined;
}

function providerOf(program: HexVaultProgram): SendProvider {
  // SAFETY: every Program this app builds (App.tsx) carries an
  // AnchorProvider, whose `connection` and `wallet` are always set; the
  // SDK's `Provider` type only marks `wallet` optional for providers that
  // never sign.
  return program.provider as unknown as SendProvider;
}

/** The on-chain `Custom` program error code inside a landed transaction's
 *  failure, the same `{InstructionError: [index, {Custom: N}]}` shape
 *  `confirmTransaction`/`getSignatureStatuses` report; null for a failure
 *  with no such code (an account-level error, not a program `require`). */
function customErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const detail = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return null;
  const kind = detail[1] as unknown;
  if (typeof kind !== "object" || kind === null || !("Custom" in kind)) return null;
  const code = (kind as { Custom: unknown }).Custom;
  return typeof code === "number" ? code : null;
}

/**
 * `setComputeUnitLimit`'s value: `unitsConsumed × COMPUTE_UNIT_MARGIN` from a
 * simulation on `connection` (ticket 08, research/notes/transactions_and_rpc.md
 * "Simulate every transaction to measure real compute-unit usage"), or the
 * per-instruction fallback when simulation throws — a stuttering public RPC,
 * or an instruction set the simulator rejects for an unrelated reason.
 */
async function computeUnitLimit(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
): Promise<number> {
  try {
    const probe = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
      ...instructions,
    );
    probe.feePayer = payer;
    const { value } = await connection.simulateTransaction(probe);
    if (value.err || value.unitsConsumed === undefined) {
      throw new Error(
        value.err ? JSON.stringify(value.err) : "simulation reported no unitsConsumed",
      );
    }
    return Math.ceil(value.unitsConsumed * COMPUTE_UNIT_MARGIN);
  } catch {
    return Math.min(
      MAX_COMPUTE_UNIT_LIMIT,
      FALLBACK_COMPUTE_UNITS_PER_INSTRUCTION * instructions.length,
    );
  }
}

/**
 * The one send helper every player transaction goes through (ticket 08,
 * production-hardening): fetches the blockhash and `lastValidBlockHeight`,
 * prepends compute-budget instructions (the capped priority fee from
 * `/state`, and a compute-unit limit sized above), signs through the wallet
 * adapter or Privy's own `sendTransaction`, then confirms with the blockhash
 * strategy at `confirmed` — never the deprecated signature-only confirm, and
 * never left to Anchor's `.rpc()`/`sendAndConfirm`, so an expired or
 * on-chain-failed send always resolves to a `SendResult` instead of hanging.
 */
export async function sendMany(
  program: HexVaultProgram,
  owner: TxSigner,
  instructions: TransactionInstruction[],
  priorityFeeMicroLamports: number,
): Promise<SendResult> {
  const provider = providerOf(program);
  const connection = provider.connection;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(CONFIRMED);
  const computeUnits = await computeUnitLimit(connection, instructions, owner.publicKey);
  const transaction = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: owner.publicKey,
  }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ...instructions,
  );

  let signature: string;
  if (owner.sendTransaction) {
    signature = await owner.sendTransaction(transaction);
  } else {
    if (!provider.wallet) throw new Error("wallet cannot sign transactions");
    const signed = await provider.wallet.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize());
  }

  try {
    const { value } = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      CONFIRMED,
    );
    if (value.err) {
      return { kind: "failed", code: customErrorCode(value.err), message: JSON.stringify(value.err) };
    }
    return { kind: "landed", signature };
  } catch (error) {
    if (error instanceof TransactionExpiredBlockheightExceededError) return { kind: "expired" };
    return {
      kind: "failed",
      code: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Sends `builder`'s instructions through `sendMany` above. */
async function send(
  program: HexVaultProgram,
  owner: TxSigner,
  builder: TxBuilder,
  priorityFeeMicroLamports: number,
): Promise<SendResult> {
  const unsigned = await builder.transaction();
  return sendMany(program, owner, unsigned.instructions, priorityFeeMicroLamports);
}

export async function deposit(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
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
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
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
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
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
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
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
): Promise<SendResult> {
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
  return sendMany(program, owner, instructions, pool.priorityFeeMicroLamports);
}

/** Stakes `stakePerTile` Entries on every tile set in `tilesMask`. */
export async function buyPosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
  tilesMask: bigint,
  stakePerTile: bigint,
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/** Credits the round reward as Entries and closes the Position (rent back). */
export async function settlePosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  roundId: bigint,
): Promise<SendResult> {
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
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}

/** Records this Player's final Weight in an ended epoch that is Registering. */
export async function register(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epochId: bigint,
): Promise<SendResult> {
  const o = owner.publicKey;
  const builder = method(program, "register")()
    .accounts({
      pool: pool.address,
      epoch: epochAddress(pool.address, epochId),
      player: playerAddress(pool.address, o),
    });
  return send(program, owner, builder, pool.priorityFeeMicroLamports);
}
