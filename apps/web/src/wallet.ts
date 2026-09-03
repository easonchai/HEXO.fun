export type WalletMode = "privy" | "standard-solana";

export type Cluster = "localnet" | "devnet";

export interface WalletConfiguration {
  readonly mode: WalletMode;
  readonly privyAppId?: string;
}

/** Clusters this app will ever talk to. Mainnet is out of scope by policy. */
export const SUPPORTED_CLUSTERS: readonly Cluster[] = ["localnet", "devnet"];

/**
 * Privy is opt-in until the project supplies an App ID. This ensures a missing
 * environment variable never falls back to a custodial key path; users can
 * always connect a standard Solana wallet.
 */
export const walletConfiguration = (
  environment: Record<string, string | undefined>,
): WalletConfiguration => {
  const appId = environment.VITE_PRIVY_APP_ID?.trim();
  return appId
    ? { mode: "privy", privyAppId: appId }
    : { mode: "standard-solana" };
};

/**
 * Cluster guard: refuse anything but localnet/devnet. Used both for the wallet
 * connection and for the RPC endpoint chosen at boot.
 */
export const assertSupportedWallet = (cluster: string): void => {
  if (!SUPPORTED_CLUSTERS.includes(cluster as Cluster)) {
    throw new Error(
      `Refusing wallet connection for unsupported cluster: ${cluster}`,
    );
  }
};

/**
 * Pick the active cluster from the environment, defaulting to devnet (the
 * deployed product target). Local runs pass VITE_CLUSTER=localnet explicitly
 * — the demo/e2e harnesses always do.
 */
export const clusterFromEnv = (
  environment: Record<string, string | undefined>,
): Cluster => {
  const raw = environment.VITE_CLUSTER?.trim();
  if (!raw) return "devnet";
  assertSupportedWallet(raw);
  return raw as Cluster;
};

export const clusterEndpoint = (cluster: Cluster): string =>
  cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899";
