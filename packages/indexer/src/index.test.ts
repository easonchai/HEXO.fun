import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Connection, ConfirmedSignatureInfo } from "@solana/web3.js";
import type { Pool as PgPool } from "pg";
import {
  hasTransactionError,
  Indexer,
  PROGRAM_ID,
  type IndexerConfig,
} from "./index.ts";

describe("transaction filtering", () => {
  it("recognizes failed and successful transaction metadata", () => {
    expect(
      hasTransactionError({
        meta: { err: { InstructionError: [0, "Custom"] } },
      }),
    ).toBe(true);
    expect(hasTransactionError({ meta: { err: null } })).toBe(false);
    expect(hasTransactionError({ meta: { err: undefined } })).toBe(false);
    expect(hasTransactionError(null)).toBe(false);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_IDL = resolve(HERE, "../../../target/idl/hex_vault.json");
const FALLBACK_IDL = resolve(
  HERE,
  "../../../apps/web/src/idl/hex_vault.json",
);
const IDL_PATH = existsSync(BUILD_IDL) ? BUILD_IDL : FALLBACK_IDL;

const config: IndexerConfig = {
  rpcUrl: "http://127.0.0.1:8899",
  databaseUrl: "postgres://unused/unused",
  programId: PROGRAM_ID,
  idlPath: IDL_PATH,
  migrationsDir: "migrations",
  reconcileIntervalMs: 60_000,
};

/** No SQL query is issued during catchUp() beyond the cursor lookup. */
const fakePg = (cursorRow: Record<string, unknown> | null): PgPool =>
  ({
    query: async () => ({ rows: cursorRow ? [cursorRow] : [] }),
  }) as unknown as PgPool;

const sigInfo = (
  signature: string,
  overrides: Partial<ConfirmedSignatureInfo> = {},
): ConfirmedSignatureInfo => ({
  signature,
  slot: 0,
  err: null,
  memo: null,
  confirmationStatus: "finalized",
  ...overrides,
});

/** Replaces `ingest` with a spy and returns the signature order of each call. */
const stubIngest = (indexer: Indexer): string[][] => {
  const ingested: string[][] = [];
  (
    indexer as unknown as {
      ingest: (raw: { signature: string }[]) => Promise<number>;
    }
  ).ingest = vi.fn(async (raw: { signature: string }[]) => {
    ingested.push(raw.map((entry) => entry.signature));
    return raw.length;
  });
  return ingested;
};

/** A minimal fake serving canned signature pages and transactions by signature. */
const fakeConnection = (
  pages: readonly ConfirmedSignatureInfo[][],
  transactionsBySignature: ReadonlyMap<
    string,
    { slot: number; logs: string[] }
  >,
): Connection => {
  let call = 0;
  return {
    getSignaturesForAddress: async () => {
      const page = pages[call] ?? [];
      call += 1;
      return page;
    },
    getTransaction: async (signature: string) => {
      const tx = transactionsBySignature.get(signature);
      if (!tx) return null;
      return {
        slot: tx.slot,
        blockTime: 1_700_000_000,
        meta: { err: null, logMessages: tx.logs },
      };
    },
  } as unknown as Connection;
};

describe("catchUp paging", () => {
  it("pages until it reaches the stored cursor, ingesting oldest-first", async () => {
    // Newest-first pages, as getSignaturesForAddress returns them. The cursor
    // (sig5) sits partway through the third page.
    const pages: ConfirmedSignatureInfo[][] = [
      [sigInfo("sig10"), sigInfo("sig9")],
      [sigInfo("sig8"), sigInfo("sig7")],
      [sigInfo("sig6"), sigInfo("sig5"), sigInfo("sig4")],
    ];
    const transactions = new Map(
      ["sig10", "sig9", "sig8", "sig7", "sig6"].map((sig, i) => [
        sig,
        { slot: 100 + i, logs: [`Program data: ${sig}`] },
      ]),
    );
    const connection = fakeConnection(pages, transactions);
    const pg = fakePg({ slot: "1", signature: "sig5", event_index: 0 });
    const indexer = new Indexer(config, pg, connection);
    const ingested = stubIngest(indexer);

    await indexer.catchUp();

    expect(ingested).toHaveLength(1);
    // Ascending order (oldest first): sig6 is newer than the cursor sig5 and
    // older than sig7/sig8/sig9/sig10.
    expect(ingested[0]).toEqual(["sig6", "sig7", "sig8", "sig9", "sig10"]);
  });

  it("stops when a page comes back empty with no stored cursor", async () => {
    const pages: ConfirmedSignatureInfo[][] = [
      [sigInfo("sig3"), sigInfo("sig2")],
      [sigInfo("sig1")],
      [],
    ];
    const transactions = new Map(
      ["sig1", "sig2", "sig3"].map((sig, i) => [
        sig,
        { slot: 100 + i, logs: [`Program data: ${sig}`] },
      ]),
    );
    const connection = fakeConnection(pages, transactions);
    const pg = fakePg(null);
    const indexer = new Indexer(config, pg, connection);
    const ingested = stubIngest(indexer);

    await indexer.catchUp();

    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toEqual(["sig1", "sig2", "sig3"]);
  });
});
