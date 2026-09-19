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
