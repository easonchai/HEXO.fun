/**
 * Dev-only in-memory burner wallet for automated browser testing of the
 * localnet app. NOT a custodial path for users: it is opt-in via
 * VITE_BURNER_WALLET=1, refuses every cluster but localnet, and its keypair
 * lives only in page memory for the session.
 */
import {
  BaseWalletAdapter,
  WalletReadyState,
} from "@solana/wallet-adapter-base";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Deterministic dev seed so external test harnesses (scripts/e2e-web.sh) can
 * pre-fund the burner before the browser connects. Not used outside the
 * VITE_BURNER_WALLET=1 localnet path.
 */
export const burnerKeypair = (): Keypair => {
  const seed = new TextEncoder()
    .encode("hexvault-localnet-burner-v1")
    .slice(0, 32);
  const padded = new Uint8Array(32);
  padded.set(seed);
  padded.fill(7, seed.length);
  return Keypair.fromSeed(padded);
};

export class BurnerWalletAdapter extends BaseWalletAdapter {
  name = "Localnet Burner (dev)" as never;
  url = "https://solana.com/docs";
  supportedTransactionVersions = { legacy: true, 0: true } as never;
  icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDIyZmYiLz48L3N2Zz4=";

  private keypair: Keypair | null = null;
  private _connecting = false;

  get connecting(): boolean {
    return this._connecting;
  }

  get connected(): boolean {
    return this.keypair !== null;
  }

  get readyState(): WalletReadyState {
    return WalletReadyState.Installed;
  }

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  /** Fund with `solana airdrop` externally; see scripts/e2e-web.sh. */
  async connect(): Promise<void> {
    this._connecting = true;
    try {
      this.keypair ??= burnerKeypair();
      this.emit("connect", this.keypair.publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    if (!this.keypair) throw new Error("burner wallet not connected");
    if (transaction instanceof Transaction) {
      transaction.partialSign(this.keypair);
      return transaction;
    }
    transaction.sign([this.keypair]);
    return transaction;
  }

  async sendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    connection: Connection,
  ): Promise<string> {
    const signed = await this.signTransaction(transaction);
    const raw = signed.serialize();
    return connection.sendRawTransaction(raw);
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]> {
    for (const transaction of transactions)
      await this.signTransaction(transaction);
    return transactions;
  }
}

/** Gate: explicit env flag AND localnet. Anything else = disabled. */
export const burnerEnabled = (
  environment: Record<string, string | undefined>,
  cluster: string,
): boolean =>
  environment.VITE_BURNER_WALLET?.trim() === "1" && cluster === "localnet";
