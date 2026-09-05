/**
 * Dev-only in-memory burner wallet for automated browser testing of the
 * localnet app. NOT a custodial path for users: it is opt-in via
 * VITE_BURNER_WALLET=1, refuses any RPC endpoint that is not a local
 * validator, and its keypair lives only in page memory for the session.
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
 * Deterministic dev seed so an external test harness can pre-fund the burner
 * before the browser connects. Not used outside the VITE_BURNER_WALLET=1
 * local-validator path.
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

  /** Fund with `solana airdrop` externally before connecting. */
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

/** True when the RPC endpoint is a local validator, not devnet or mainnet. */
export const isLocalRpc = (url: string | undefined): boolean => {
  try {
    const { hostname } = new URL(url ?? "");
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    // No VITE_RPC_URL set: chain.ts defaults to the local validator.
    return url === undefined || url.trim() === "";
  }
};

/**
 * Gate: explicit env flag AND a local RPC endpoint. There is no cluster
 * variable any more, so the endpoint is what says "this is localnet".
 */
export const burnerEnabled = (
  environment: Record<string, string | undefined>,
): boolean =>
  environment.VITE_BURNER_WALLET?.trim() === "1" &&
  isLocalRpc(environment.VITE_RPC_URL);
