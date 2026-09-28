// ticket 10: boot-guard tests with a stubbed connection for each mismatch.
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  assertAcceptedMintMatchesPool,
  assertClusterMatchesGenesis,
  assertPoolRowsBelongToProgram,
  CLUSTER_GENESIS_HASHES,
  runBootGuards,
  type BootGuardDeps,
} from "./boot-guard";
import { poolAddress } from "./chain/pda";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL_ADDRESS = poolAddress(PROGRAM_ID, 2n);
const ACTIVE = { address: POOL_ADDRESS.toBase58(), poolId: 2n };
const RETIRED = { address: poolAddress(PROGRAM_ID, 1n).toBase58(), poolId: 1n };
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
    programId: PROGRAM_ID,
    poolAddress: POOL_ADDRESS,
    acceptedMint: MINT.toBase58(),
    cluster: "devnet",
    mirroredPoolRows: async () => [ACTIVE],
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

describe("assertPoolRowsBelongToProgram", () => {
  it("passes with a retired pool beside the Active one on the same program", () => {
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [RETIRED, ACTIVE])).not.toThrow();
  });

  it("passes with no mirrored rows yet (a fresh database)", () => {
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [])).not.toThrow();
  });

  it("throws, naming the row, when an address is not its poolId's PDA under PROGRAM_ID", () => {
    const otherProgram = Keypair.generate().publicKey;
    const foreign = { address: poolAddress(otherProgram, 1n).toBase58(), poolId: 1n };
    expect(() => assertPoolRowsBelongToProgram(PROGRAM_ID, [ACTIVE, foreign])).toThrow(
      new RegExp(`${foreign.address}.*wrong DATABASE_URL or PROGRAM_ID`),
    );
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

  it("throws when Postgres mirrors a Pool row from another program", async () => {
    await expect(
      runBootGuards(
        deps({
          mirroredPoolRows: async () => [
            { address: Keypair.generate().publicKey.toBase58(), poolId: 2n },
          ],
        }),
      ),
    ).rejects.toThrow(/wrong DATABASE_URL or PROGRAM_ID/);
  });
});
