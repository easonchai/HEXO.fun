export type WalletMode = 'privy' | 'standard-solana';

export interface WalletConfiguration {
  readonly mode: WalletMode;
  readonly privyAppId?: string;
}

/**
 * Privy is opt-in until the project supplies an App ID. This ensures a missing
 * environment variable never falls back to a custodial key path; users can
 * always connect a standard Solana wallet.
 */
export const walletConfiguration = (
  environment: Record<string, string | undefined>,
): WalletConfiguration => {
  const appId = environment.VITE_PRIVY_APP_ID?.trim();
  return appId ? { mode: 'privy', privyAppId: appId } : { mode: 'standard-solana' };
};

export const assertSupportedWallet = (cluster: string): void => {
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error(`Refusing wallet connection for unsupported cluster: ${cluster}`);
  }
};
