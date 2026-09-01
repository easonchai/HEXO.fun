import { describe, expect, it } from 'vitest';

import { assertSupportedWallet, walletConfiguration } from './wallet.js';

describe('wallet configuration', () => {
  it('uses an external-wallet-safe default without a Privy credential', () => {
    expect(walletConfiguration({})).toEqual({ mode: 'standard-solana' });
  });

  it('enables Privy only with a non-empty app ID', () => {
    expect(walletConfiguration({ VITE_PRIVY_APP_ID: '  app-id  ' })).toEqual({
      mode: 'privy',
      privyAppId: 'app-id',
    });
  });

  it('rejects accidental local or arbitrary-cluster wallet connections', () => {
    expect(() => assertSupportedWallet('localhost')).toThrow('unsupported cluster');
    expect(() => assertSupportedWallet('devnet')).not.toThrow();
  });
});
