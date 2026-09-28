/**
 * `VITE_CLUSTER`, on its own so both ends can read it: `chain.ts` derives the
 * signing chain and the RPC default from it at startup, and `vite.config.ts`
 * validates it at build time. Nothing is imported here on purpose — the Vite
 * config runs in Node, where the Solana packages and `import.meta.env` are
 * not what this module would find.
 */

/** Which Solana cluster a bundle is built for. */
export type Cluster = "devnet" | "mainnet-beta";

const CLUSTERS: readonly string[] = ["devnet", "mainnet-beta"];

/**
 * Devnet when unset. Anything else throws: at build time from the Vite
 * config, and at module load in the browser for a bundle built some other
 * way. A typo must not quietly ship a mainnet page that signs on devnet.
 */
export function clusterFrom(
  vars: Record<string, string | undefined>,
): Cluster {
  const raw = vars.VITE_CLUSTER?.trim() || "devnet";
  if (!CLUSTERS.includes(raw)) {
    throw new Error(
      `VITE_CLUSTER must be "devnet" or "mainnet-beta", got "${raw}"`,
    );
  }
  return raw as Cluster;
}

/** The faucet mints a test mint the operator owns. Mainnet has no such mint. */
export const faucetEnabled = (cluster: Cluster): boolean =>
  cluster === "devnet";

/**
 * Ticket 01 (feature-gates): the game gate. `off` covers the PLAY tab and
 * board with a same-sized "Coming soon" card; unset or any other value
 * means shown. Exact and case-sensitive, so a typo fails open (shown)
 * rather than silently hiding a live feature.
 */
export const gameGated = (raw: string | undefined): boolean => raw === "off";

/** The jackpot gate; same rule as `gameGated`, its own variable. */
export const jackpotGated = (raw: string | undefined): boolean => raw === "off";

/**
 * Ticket 14: each cluster's own genesis block hash, checked against the
 * configured RPC at load so a `VITE_PUBLIC_RPC_URL` pointed at the wrong
 * cluster is caught before anything signs against it. Fixed values (Solana
 * cluster genesis hashes never change), so no import needed here either.
 */
const GENESIS_HASHES: Record<Cluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

/** True when `genesisHash` (from the RPC's `getGenesisHash`) is the one this
 *  `cluster` is supposed to answer to. */
export function genesisMatchesCluster(
  genesisHash: string,
  cluster: Cluster,
): boolean {
  return GENESIS_HASHES[cluster] === genesisHash;
}
