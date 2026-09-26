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

import { isBlockhashExpiryError, resolveExpired, sendMany, type SendResult } from "./actions.js";
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
  /** One answer for the one signature `sendMany` asks about; `null` is the
   *  chain never having seen it. */
  signatureStatus?: () => Promise<{ err: unknown } | null>;
  /** Records the order `sendMany` calls the stub's methods in. */
  calls?: string[];
}

/** The five `Connection` methods `sendMany` calls, nothing else — see
 *  `SendProvider` in actions.ts for why a stub needs no more than this. */
function fakeConnection(options: FakeConnectionOptions = {}): Connection {
  const calls = options.calls ?? [];
  const simulate =
    options.simulate ?? (async () => ({ value: { err: null, unitsConsumed: 100_000 } }));
  const send = options.sendRawTransaction ?? (async () => "fake-signature");
  const confirm = options.confirm ?? (async () => ({ value: { err: null } }));
  const status = options.signatureStatus ?? (async () => null);
  return {
    getLatestBlockhash: async () => {
      calls.push("getLatestBlockhash");
      return { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT };
    },
    simulateTransaction: async () => {
      calls.push("simulateTransaction");
      return simulate();
    },
    sendRawTransaction: async () => {
      calls.push("sendRawTransaction");
      return send();
    },
    confirmTransaction: async () => {
      calls.push("confirmTransaction");
      return confirm();
    },
    getSignatureStatuses: async () => {
      calls.push("getSignatureStatuses");
      return { context: { slot: 1 }, value: [await status()] };
    },
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

  // Pre-mainnet review: the blockhash is fetched after the simulation, right
  // before the wallet prompt, so a slow public-RPC simulation never eats
  // into the hash's life.
  it("fetches the blockhash after simulating, right before signing", async () => {
    const signer = Keypair.generate();
    const calls: string[] = [];
    const connection = fakeConnection({ calls });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    await sendMany(program, { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS);

    expect(calls).toEqual([
      "simulateTransaction",
      "getLatestBlockhash",
      "sendRawTransaction",
      "confirmTransaction",
    ]);
  });

  it("maps a 'Blockhash not found' send rejection to expired, not a generic failure", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({
      sendRawTransaction: async () => {
        throw new Error(
          "failed to send transaction: Transaction simulation failed: Blockhash not found",
        );
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(program, { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS);

    expect(result).toEqual<SendResult>({ kind: "expired" });
  });

  it("still throws a send rejection that is not a blockhash expiry", async () => {
    const signer = Keypair.generate();
    const connection = fakeConnection({
      sendRawTransaction: async () => {
        throw new Error("User rejected the request.");
      },
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    await expect(
      sendMany(program, { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS),
    ).rejects.toThrow("User rejected the request.");
  });

  // Pre-mainnet review: a missed websocket notification looks exactly like
  // an expiry to `confirmTransaction`; one `getSignatureStatuses` call
  // tells a landed deposit apart from a dropped one before the UI says
  // "try again".
  it("reports landed when the chain already knows an 'expired' signature", async () => {
    const signer = Keypair.generate();
    const calls: string[] = [];
    const connection = fakeConnection({
      calls,
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
      signatureStatus: async () => ({ err: null }),
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(program, { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS);

    expect(result).toEqual<SendResult>({ kind: "landed", signature: "fake-signature" });
    expect(calls.filter((c) => c === "getSignatureStatuses")).toHaveLength(1);
  });

  it("reports failed with the Custom code when the chain knows the signature failed", async () => {
    const signer = Keypair.generate();
    const err = { InstructionError: [0, { Custom: 6012 }] };
    const connection = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
      signatureStatus: async () => ({ err }),
    });
    const program = fakeProgram(connection, fakeWallet(signer, { tx: null }));

    const result = await sendMany(program, { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS);

    expect(result).toEqual<SendResult>({ kind: "failed", code: 6012, message: JSON.stringify(err) });
  });

  it("keeps expired when the chain has never seen the signature, or the lookup itself fails", async () => {
    const signer = Keypair.generate();
    const unseen = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
      signatureStatus: async () => null,
    });
    expect(
      await sendMany(fakeProgram(unseen, fakeWallet(signer, { tx: null })), { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS),
    ).toEqual<SendResult>({ kind: "expired" });

    const broken = fakeConnection({
      confirm: async () => {
        throw new TransactionExpiredBlockheightExceededError("fake-signature");
      },
      signatureStatus: async () => {
        throw new Error("RPC hiccup");
      },
    });
    expect(
      await sendMany(fakeProgram(broken, fakeWallet(signer, { tx: null })), { publicKey: signer.publicKey }, [realInstruction(signer.publicKey)], FEE_MICROLAMPORTS),
    ).toEqual<SendResult>({ kind: "expired" });
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

describe("isBlockhashExpiryError", () => {
  it("recognises web3.js's expiry class and the RPC's preflight message", () => {
    expect(isBlockhashExpiryError(new TransactionExpiredBlockheightExceededError("sig"))).toBe(true);
    expect(isBlockhashExpiryError(new Error("Transaction simulation failed: Blockhash not found"))).toBe(true);
    expect(isBlockhashExpiryError("blockhash not found")).toBe(true);
  });

  it("leaves every other error alone", () => {
    expect(isBlockhashExpiryError(new Error("User rejected the request."))).toBe(false);
    expect(isBlockhashExpiryError(null)).toBe(false);
    expect(isBlockhashExpiryError({ code: 4001 })).toBe(false);
  });
});

describe("resolveExpired", () => {
  it("is the chain's verdict when it has one, expired otherwise", () => {
    expect(resolveExpired("sig", null)).toEqual<SendResult>({ kind: "expired" });
    expect(resolveExpired("sig", undefined)).toEqual<SendResult>({ kind: "expired" });
    expect(resolveExpired("sig", { err: null })).toEqual<SendResult>({ kind: "landed", signature: "sig" });
    expect(resolveExpired("sig", { err: { InstructionError: [0, { Custom: 7 }] } })).toEqual<SendResult>({
      kind: "failed",
      code: 7,
      message: JSON.stringify({ InstructionError: [0, { Custom: 7 }] }),
    });
  });
});
