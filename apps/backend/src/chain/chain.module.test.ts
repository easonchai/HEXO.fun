import type { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../config/config.module";
import { DEFAULT_PROGRAM_ID, type HexVaultEnv } from "../config/env";
import { CountingConnection } from "../test-utils/counting-connection";
import { ChainModule } from "./chain.module";
import { CONFIRM_TIMEOUT_MS, ChainService, SOLANA_CONNECTION } from "./chain.service";
import { poolAddress } from "./pda";

describe("ChainModule", () => {
  let chain: ChainService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ChainModule],
    })
      .overrideProvider(SOLANA_CONNECTION)
      .useValue({}) // fake connection: nothing in this ticket calls it
      .compile();

    chain = moduleRef.get(ChainService);
  });

  it("derives the Pool PDA for POOL_ID", () => {
    const expected = poolAddress(new PublicKey(DEFAULT_PROGRAM_ID), 1n);
    expect(chain.poolAddress().equals(expected)).toBe(true);
  });

  it("names an Anchor error from its program logs", () => {
    const fakeSendFailure = {
      logs: [
        "Program log: AnchorError thrown in lib.rs:100. Error Code: InvalidTileSelection. Error Number: 6000. Error Message: Invalid tile selection.",
      ],
    };
    expect(chain.mapSendError(fakeSendFailure).message).toBe(
      "InvalidTileSelection",
    );
  });
});

// Ticket 04: confirmation moves from the block-height poll to a signature
// subscription, bounded so a dropped send still surfaces as an error.
describe("ChainService.send", () => {
  // A single no-op instruction: `Transaction.add()` refuses zero
  // instructions, and nothing here needs it to do anything real, since
  // `getLatestBlockhash`/`sendRawTransaction`/confirmation are all faked.
  const noop = [new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) })];

  function chainWith(connection: CountingConnection): ChainService {
    const env: Partial<HexVaultEnv> = {
      AUTHORITY_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
      POOL_ID: "1",
      PROGRAM_ID: DEFAULT_PROGRAM_ID,
    };
    // SAFETY: ChainService only reads those three keys through `get`.
    const config = {
      get: (key: keyof HexVaultEnv) => env[key],
    } as unknown as ConfigService<HexVaultEnv, true>;
    return new ChainService(connection as unknown as Connection, config);
  }

  it("confirms off the signature subscription: two RPC calls, no block-height polling", async () => {
    const connection = new CountingConnection();
    const chain = chainWith(connection);

    // The fake only notifies listeners open when the transaction lands, so
    // this resolving at all (real timers, no 30 s wait) proves the
    // subscription opened before the send.
    const signature = await chain.send(noop);

    expect(connection.lastParams("onSignature")).toEqual([signature]);
    expect(connection.callsTo("getLatestBlockhash")).toBe(1);
    expect(connection.callsTo("sendRawTransaction")).toBe(1);
    // The two calls above are the whole cost of a confirmed send; the
    // subscription notification is a push, not a poll.
    expect(connection.callsTo("getSignatureStatuses")).toBe(0);
    expect(connection.callsTo("getBlockHeight")).toBe(0);
  });

  it("a still-live blockhash after the bounded wait reads as pending, not failed", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false; // the subscription never fires
      connection.blockHeight = connection.slot; // well under lastValidBlockHeight
      const chain = chainWith(connection);

      // The assertion attaches its rejection handler before the timer fires
      // (`advanceTimersByTimeAsync` below), so the rejection is never briefly
      // unhandled between the two `await`s.
      const rejected = expect(chain.send(noop)).rejects.toThrow(/still pending/);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await rejected;

      // The bounded fallback: one status query, one block-height read.
      expect(connection.callsTo("getSignatureStatuses")).toBe(1);
      expect(connection.callsTo("getBlockHeight")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a block height past the blockhash's last valid height surfaces as expired, never a hang", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false;
      connection.blockHeight = connection.slot + 1_000; // past lastValidBlockHeight
      const chain = chainWith(connection);

      const rejected = expect(chain.send(noop)).rejects.toThrow(/expired/);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a status query that finds the transaction landed after all still succeeds", async () => {
    vi.useFakeTimers();
    try {
      const connection = new CountingConnection();
      connection.autoConfirmSignature = false; // subscription missed it
      connection.signatureStatus = { err: null }; // but it landed clean
      const chain = chainWith(connection);

      const sent = chain.send(noop);
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await expect(sent).resolves.toBe(connection.lastParams("onSignature")?.[0]);
      expect(connection.callsTo("getBlockHeight")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
