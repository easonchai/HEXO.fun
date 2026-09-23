/**
 * Ticket 08 (production-hardening): `sendMany`'s own behavior, stubbed at
 * `program.provider.connection` and `.wallet` — no network, no real Program.
 * The exported action functions (`deposit`, `buyPosition`, ...) are thin
 * builders on top of this and stay untested here; `sendMany` is where the
 * compute-budget, signing and confirmation logic actually lives.
 */
import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { sendMany, type SendResult } from "./actions.js";
import type { HexVaultProgram } from "./chain.js";

const BLOCKHASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LAST_VALID_BLOCK_HEIGHT = 1_000;
const FEE_MICROLAMPORTS = 4_242;

/** One real, harmless instruction: a zero-lamport self-transfer. What it does
 *  never matters here — only that `sendMany` carries it through unmodified. */
function realInstruction(payer: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 });
}

interface FakeConnectionOptions {
  simulate?: () => Promise<{ value: { err: unknown; unitsConsumed?: number } }>;
  confirm?: () => Promise<{ value: { err: unknown } }>;
  sendRawTransaction?: () => Promise<string>;
}

/** The four `Connection` methods `sendMany` calls, nothing else — see
 *  `SendProvider` in actions.ts for why a stub needs no more than this. */
function fakeConnection(options: FakeConnectionOptions = {}): Connection {
  return {
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    }),
    simulateTransaction:
      options.simulate ?? (async () => ({ value: { err: null, unitsConsumed: 100_000 } })),
    sendRawTransaction: options.sendRawTransaction ?? (async () => "fake-signature"),
    confirmTransaction: options.confirm ?? (async () => ({ value: { err: null } })),
  } as unknown as Connection;
}

/** Signs with a real `Keypair` (so `.serialize()` after it succeeds, the same
 *  as a real wallet's `signTransaction`) and records the built transaction
 *  for the caller to inspect. */
function fakeWallet(signer: Keypair, captured: { tx: Transaction | null }) {
  return {
    signTransaction: async <T,>(tx: T): Promise<T> => {
      captured.tx = tx as unknown as Transaction;
      (tx as unknown as Transaction).sign(signer);
      return tx;
    },
  };
}

function fakeProgram(
  connection: Connection,
  wallet: ReturnType<typeof fakeWallet>,
): HexVaultProgram {
  return { provider: { connection, wallet } } as unknown as HexVaultProgram;
}

describe("sendMany", () => {
  it("prepends a priced compute-unit-price and a simulation-sized compute-unit-limit instruction", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({
      simulate: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
    });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "fake-signature" });
    const instructions = captured.tx?.instructions ?? [];
    expect(instructions).toHaveLength(3);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[0]!)).toEqual({
      microLamports: BigInt(FEE_MICROLAMPORTS),
    });
    // Math.ceil(100_000 × 1.1) — the simulation's unitsConsumed times the
    // margin (chain.service.ts's backend counterpart uses the same 1.1).
    // 110_001, not 110_000: 100_000 × 1.1 lands a hair over in floating
    // point, and ceil takes the hair with it — same as the backend's.
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[1]!)).toEqual({
      units: 110_001,
    });
  });

  it("falls back to a per-instruction compute limit when simulation throws", async () => {
    const signer = Keypair.generate();
    const captured: { tx: Transaction | null } = { tx: null };
    const connection = fakeConnection({
      simulate: async () => {
        throw new Error("simulated RPC hiccup");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, captured));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey), realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result.kind).toBe("landed");
    const instructions = captured.tx?.instructions ?? [];
    // Two real instructions: 200_000 CUs each (solana.com's per-instruction
    // runtime default), the fallback when a simulation can't be trusted.
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[1]!)).toEqual({
      units: 400_000,
    });
  });

  it("maps a clean confirmation to landed", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({ confirm: async () => ({ value: { err: null } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "fake-signature" });
  });

  it("maps a blockhash-expiry confirm error to expired", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({ kind: "expired" });
  });

  it("maps a landed-but-failed confirmation to failed with the decoded Custom code", async () => {
    const signer = Keypair.generate();
    const err = { InstructionError: [0, { Custom: 6012 }] };
    const connection = fakeConnection({ confirm: async () => ({ value: { err } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "failed",
      code: 6012,
      message: JSON.stringify(err),
    });
  });

  it("maps a failure with no Custom code to failed with a null code", async () => {
    const signer = Keypair.generate();
    const err = "AccountInUse";
    const connection = fakeConnection({ confirm: async () => ({ value: { err } }) });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      { publicKey: signer.publicKey },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    expect(result).toEqual<SendResult>({
      kind: "failed",
      code: null,
      message: JSON.stringify(err),
    });
  });

  it("confirms the Privy sponsored path's signature instead of returning as soon as it sends", async () => {
    // No `provider.wallet` needed on this path — `owner.sendTransaction`
    // stands in for Privy's own sign-and-broadcast.
    const signer = Keypair.generate();
    const connection = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("privy-signature");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(
      program,
      {
        publicKey: signer.publicKey,
        sendTransaction: async () => "privy-signature",
      },
      [realInstruction(signer.publicKey)],
      FEE_MICROLAMPORTS,
    );

    // Had this path returned the moment `sendTransaction` resolved, the
    // result would be `landed`; it is `expired` because confirm ran too.
    expect(result).toEqual<SendResult>({ kind: "expired" });
  });
});
