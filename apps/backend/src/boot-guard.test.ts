// ticket 10: boot-guard tests with a stubbed connection for each mismatch.
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  assertAcceptedMintMatchesPool,
  assertClusterMatchesGenesis,
  assertNoForeignPoolRows,
  CLUSTER_GENESIS_HASHES,
  runBootGuards,
  type BootGuardDeps,
} from "./boot-guard";

const POOL_ADDRESS = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;

function deps(overrides: Partial<BootGuardDeps> = {}): BootGuardDeps {
  return {
    connection: {
      getGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet,
      getAccountInfo: async () => ({
        data: Buffer.alloc(0),
      }),
    },
    program: {
      coder: {
        accounts: {
          decode: () => ({ acceptedMint: MINT }),
        },
      },
    },
    poolAddress: POOL_ADDRESS,
    acceptedMint: MINT.toBase58(),
    cluster: "devnet",
    mirroredPoolAddresses: async () => [POOL_ADDRESS.toBase58()],
    ...overrides,
  };
}

describe("assertClusterMatchesGenesis", () => {
  it("passes when CLUSTER's genesis hash matches the RPC's", () => {
    expect(() =>
      assertClusterMatchesGenesis("devnet", CLUSTER_GENESIS_HASHES.devnet),
    ).not.toThrow();
  });

  it("throws when the RPC's genesis hash is a different cluster's", () => {
    expect(() =>
      assertClusterMatchesGenesis("devnet", CLUSTER_GENESIS_HASHES["mainnet-beta"]),
    ).toThrow(/CLUSTER=devnet/);
  });
});

describe("assertAcceptedMintMatchesPool", () => {
  it("passes when ACCEPTED_MINT matches the Pool's mint", () => {
    expect(() => assertAcceptedMintMatchesPool(MINT.toBase58(), MINT.toBase58())).not.toThrow();
  });

  it("throws when ACCEPTED_MINT does not match the Pool's mint", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => assertAcceptedMintMatchesPool(MINT.toBase58(), other)).toThrow(/ACCEPTED_MINT/);
  });
});

describe("assertNoForeignPoolRows", () => {
  it("passes when every mirrored row is the configured Pool", () => {
    expect(() =>
      assertNoForeignPoolRows(POOL_ADDRESS.toBase58(), [POOL_ADDRESS.toBase58()]),
    ).not.toThrow();
  });

  it("passes with no mirrored rows yet (a fresh database)", () => {
    expect(() => assertNoForeignPoolRows(POOL_ADDRESS.toBase58(), [])).not.toThrow();
  });

  it("throws when a mirrored row is for a different pool", () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    expect(() =>
      assertNoForeignPoolRows(POOL_ADDRESS.toBase58(), [POOL_ADDRESS.toBase58(), foreign]),
    ).toThrow(new RegExp(foreign));
  });
});

describe("runBootGuards", () => {
  it("passes when cluster, mint and every mirrored row all agree", async () => {
    await expect(runBootGuards(deps())).resolves.toBeUndefined();
  });

  it("throws on a cluster/genesis mismatch before checking anything else", async () => {
    await expect(
      runBootGuards(
        deps({
          connection: {
            getGenesisHash: async () => CLUSTER_GENESIS_HASHES["mainnet-beta"],
            getAccountInfo: async () => {
              throw new Error("must not be called: the cluster check should fail first");
            },
          },
        }),
      ),
    ).rejects.toThrow(/CLUSTER=devnet/);
  });

  it("throws on a mint mismatch when the Pool already exists on chain", async () => {
    await expect(
      runBootGuards(deps({ acceptedMint: Keypair.generate().publicKey.toBase58() })),
    ).rejects.toThrow(/ACCEPTED_MINT/);
  });

  it("skips the mint check when the Pool does not exist yet (bootstrap has not run)", async () => {
    await expect(
      runBootGuards(
        deps({
          connection: {
            getGenesisHash: async () => CLUSTER_GENESIS_HASHES.devnet,
            getAccountInfo: async () => null,
          },
          acceptedMint: Keypair.generate().publicKey.toBase58(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws when Postgres mirrors a Pool row for a different pool", async () => {
    await expect(
      runBootGuards(
        deps({ mirroredPoolAddresses: async () => [Keypair.generate().publicKey.toBase58()] }),
      ),
    ).rejects.toThrow(/wrong DATABASE_URL/);
  });
});
