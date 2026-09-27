// beta-launch-fixes ticket 10: a mainnet stack must never crank the wrong
// network, Pool or mint because an env var was missing or mistyped.
// validateEnv (config/env.ts) already refuses to boot without PROGRAM_ID,
// POOL_ID and CLUSTER; the checks here need the chain and the database, so
// they run once from main.ts's bootstrap() instead, before the server starts
// accepting requests. Pure and dependency-light on purpose (a duck-typed
// connection and coder) so every guard is unit tested without a live RPC or
// Postgres.
import type { PublicKey } from "@solana/web3.js";

import type { Cluster } from "./config/env";

/** Mainnet-beta's and devnet's genesis hashes never change; a mismatch means
 *  CLUSTER and RPC_URL point at different networks. */
export const CLUSTER_GENESIS_HASHES: Record<Cluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

export function assertClusterMatchesGenesis(cluster: Cluster, genesisHash: string): void {
  const expected = CLUSTER_GENESIS_HASHES[cluster];
  if (genesisHash !== expected) {
    throw new Error(
      `CLUSTER=${cluster} does not match RPC_URL's genesis hash ${genesisHash} ` +
        `(expected ${expected} for ${cluster}); check RPC_URL`,
    );
  }
}

export function assertAcceptedMintMatchesPool(configuredMint: string, poolMint: string): void {
  if (configuredMint !== poolMint) {
    throw new Error(
      `ACCEPTED_MINT ${configuredMint} does not match the Pool's mint ${poolMint}`,
    );
  }
}

/** "Mirrored" means the indexer's own Postgres copy of the Pool table, not
 *  the on-chain account: a row here for any address other than the
 *  configured Pool means this database was populated against a different
 *  program id or pool id than the one this process is about to crank. */
export function assertNoForeignPoolRows(
  configuredPoolAddress: string,
  mirroredAddresses: readonly string[],
): void {
  const foreign = mirroredAddresses.filter((address) => address !== configuredPoolAddress);
  if (foreign.length > 0) {
    throw new Error(
      `Postgres has Pool row(s) for a different pool than the configured ${configuredPoolAddress}: ` +
        `${foreign.join(", ")}; wrong DATABASE_URL for this deployment`,
    );
  }
}

/** Just enough of `Program<Idl>.coder.accounts` to read the Pool's mint, so
 *  tests can fake it without a real Anchor coder or IDL. */
export interface PoolMintDecoder {
  readonly coder: {
    readonly accounts: {
      decode(name: "pool", data: Buffer): { acceptedMint: PublicKey };
    };
  };
}

/** Just enough of `Connection` for the guards below. */
export interface BootGuardConnection {
  getGenesisHash(): Promise<string>;
  getAccountInfo(address: PublicKey): Promise<{ data: Buffer } | null>;
}

export interface BootGuardDeps {
  readonly connection: BootGuardConnection;
  readonly program: PoolMintDecoder;
  readonly poolAddress: PublicKey;
  readonly acceptedMint: string;
  readonly cluster: Cluster;
  /** Every address currently in Postgres's Pool table. */
  readonly mirroredPoolAddresses: () => Promise<string[]>;
}

/**
 * Runs every boot guard ticket 10 asks for beyond validateEnv's required-var
 * check: CLUSTER against the RPC's genesis hash, ACCEPTED_MINT against the
 * on-chain Pool's mint (skipped when the Pool does not exist yet — bootstrap
 * has not run), and every mirrored Postgres Pool row against the configured
 * Pool address. Throws on the first failing guard; main.ts lets that fail
 * `bootstrap()` rather than starting the server.
 */
export async function runBootGuards(deps: BootGuardDeps): Promise<void> {
  const genesisHash = await deps.connection.getGenesisHash();
  assertClusterMatchesGenesis(deps.cluster, genesisHash);

  const poolInfo = await deps.connection.getAccountInfo(deps.poolAddress);
  if (poolInfo) {
    const raw = deps.program.coder.accounts.decode("pool", poolInfo.data);
    assertAcceptedMintMatchesPool(deps.acceptedMint, raw.acceptedMint.toBase58());
  }

  const mirrored = await deps.mirroredPoolAddresses();
  assertNoForeignPoolRows(deps.poolAddress.toBase58(), mirrored);
}
