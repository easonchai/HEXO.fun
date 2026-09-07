/**
 * Wallet layer: Privy is the primary connection path (VITE_PRIVY_APP_ID);
 * standard injected Solana wallets are the fallback when no App ID is
 * configured. Both modes reduce to one interface the app consumes:
 * publicKey + signTransaction, which is all AnchorProvider needs.
 */
import { PrivyProvider, useLogin, useLogout } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useSignAndSendTransaction,
  useSignTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import { utils as anchorUtils } from "@anchor-lang/core";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type PublicKey as PubkeyType,
} from "@solana/web3.js";

export type WalletMode = "privy" | "standard";

export interface GameSigner {
  mode: WalletMode;
  publicKey: PubkeyType | undefined;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  signTransaction:
    | (<T extends Transaction | VersionedTransaction>(
        transaction: T,
      ) => Promise<T>)
    | undefined;
  /**
   * Signs, sends and confirms in one step, returning the base58 signature.
   * Set only for the Privy embedded wallet, where Privy's own send path is
   * the one that applies dashboard gas sponsorship: a signed-then-broadcast
   * transaction keeps the user as fee payer and fails on an empty wallet.
   * External wallets and the dev burner leave it unset and go through
   * Anchor's sign-and-broadcast, which pays fees from the user's SOL.
   */
  sendTransaction?: ((transaction: Transaction) => Promise<string>) | undefined;
}

/**
 * Public Privy application id. Privy app ids are publishable client
 * identifiers (they ship in the bundle by design), so this fallback is safe
 * to keep in source. Set VITE_PRIVY_APP_ID="" (or "off") to explicitly
 * disable Privy — the localnet e2e does exactly that so the funded dev
 * burner is the one-click connection.
 */
const PRIVY_APP_ID_FALLBACK = "cmtlbhuh402u30cjv957bvump";

const privyAppIdFrom = (
  env: Record<string, string | undefined>,
): string | undefined => {
  const raw = env.VITE_PRIVY_APP_ID?.trim();
  if (raw === "" || raw?.toLowerCase() === "off") return undefined;
  return raw || PRIVY_APP_ID_FALLBACK;
};

export interface WalletEnvironment extends Record<string, string | undefined> {
  VITE_PRIVY_APP_ID?: string;
  VITE_PRIVY_CLIENT_ID?: string;
  VITE_RPC_URL?: string;
}

/** Privy boots only when an App ID is configured; otherwise standard wallets. */
export const walletModeFor = (env: WalletEnvironment): WalletMode =>
  privyAppIdFrom(env) ? "privy" : "standard";

// Built once: connectors register wallet-standard listeners, and a fresh set
// per render (or per StrictMode double-mount) can miss Phantom's injection.
const SOLANA_CONNECTORS = toSolanaWalletConnectors({ shouldAutoConnect: true });

const DEFAULT_RPC_URL = "http://127.0.0.1:8899";

/**
 * WebSocket endpoint for an HTTP RPC URL. The local validator serves
 * subscriptions one port up (8899 -> 8900); hosted RPCs use the same host.
 */
export const rpcSubscriptionsUrlFor = (rpcUrl: string): string => {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.port === "8899") url.port = "8900";
  return url.toString();
};

/**
 * Privy's transaction UI (simulation, sign-and-send) reads the chain RPC
 * from `config.solana.rpcs`; without a `solana:devnet` entry it throws
 * "No RPC configuration found for chain solana:devnet". Every environment
 * here answers to the devnet genesis (see SIGNING_CHAIN), so the app's own
 * RPC is registered under that id.
 */
const solanaRpcsFor = (rpcUrl: string) => ({
  [SIGNING_CHAIN]: {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(
      rpcSubscriptionsUrlFor(rpcUrl),
    ),
    blockExplorerUrl: "https://explorer.solana.com",
  },
});

/** App root: wraps children in PrivyProvider only when Privy is configured. */
export function WalletLayer({
  env,
  children,
}: {
  env: WalletEnvironment;
  children: ReactNode;
}) {
  const appId = privyAppIdFrom(env);
  const clientId = env.VITE_PRIVY_CLIENT_ID?.trim() || undefined;
  const rpcUrl = env.VITE_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const rpcs = useMemo(() => solanaRpcsFor(rpcUrl), [rpcUrl]);
  if (appId) {
    return (
      <PrivyProvider
        appId={appId}
        {...(clientId ? { clientId } : {})}
        config={{
          appearance: {
            theme: "#0E1B2B",
            accentColor: "#B6FF3B",
            // Privy defaults to ethereum-only, which connects Phantom's EVM side.
            // walletChainType: "solana-only",
          },
          externalWallets: {
            solana: { connectors: SOLANA_CONNECTORS },
          },
          embeddedWallets: {
            showWalletUIs: false,
            solana: {
              createOnLogin: "users-without-wallets",
            },
          },
          solana: { rpcs },
        }}
      >
        {children}
      </PrivyProvider>
    );
  }
  return <>{children}</>;
}

const WalletModeContext = createContext<WalletMode>("standard");
export const useWalletMode = (): WalletMode => useContext(WalletModeContext);

/** Publishes the active wallet mode; mount above <GameSignerProvider>. */
export function WalletModeProvider({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  return (
    <WalletModeContext.Provider value={mode}>
      {children}
    </WalletModeContext.Provider>
  );
}

const GameSignerContext = createContext<GameSigner | null>(null);

/**
 * The one hook the app uses. Only valid below <GameSignerProvider>.
 */
export function useGameSigner(): GameSigner {
  const signer = useContext(GameSignerContext);
  if (!signer) throw new Error("GameSignerProvider is not mounted");
  return signer;
}

/**
 * Mounts exactly one signer implementation: Privy's hooks require its
 * provider, so the mode decides which subtree renders — no conditional hook
 * calls anywhere.
 */
export function GameSignerProvider({ children }: { children: ReactNode }) {
  const mode = useWalletMode();
  return mode === "privy" ? (
    <PrivySignerSource mode={mode}>{children}</PrivySignerSource>
  ) : (
    <StandardSignerSource mode={mode}>{children}</StandardSignerSource>
  );
}

function PrivySignerSource({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  const signer = usePrivySigner();
  return (
    <GameSignerContext.Provider value={{ ...signer, mode }}>
      {children}
    </GameSignerContext.Provider>
  );
}

function StandardSignerSource({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  const signer = useStandardSigner();
  return (
    <GameSignerContext.Provider value={{ ...signer, mode }}>
      {children}
    </GameSignerContext.Provider>
  );
}

/**
 * Wallet-standard chain id. Nothing but devnet and a local validator is in
 * scope, and the local validator answers to the devnet genesis in every
 * wallet that supports it, so this is a constant.
 */
const SIGNING_CHAIN = "solana:devnet";

function usePrivySigner(): GameSigner {
  const { login } = useLogin();
  const { logout } = useLogout();
  // `useWallets` is the wallet Privy actually connected for this session
  // (embedded or external). `useStandardWallets` lists every Solana wallet
  // Privy knows about, connected or not, so its first entry can be a wallet
  // that cannot sign for the address the app then uses as fee payer.
  const { wallets, ready } = useWallets();
  const { signTransaction: privySign } = useSignTransaction();
  const { signAndSendTransaction: privySend } = useSignAndSendTransaction();
  const wallet = wallets[0];
  // Privy's own wallet-standard implementation flags itself; Phantom and
  // friends connected through Privy do not, and keep paying their own fees.
  const embedded = Boolean(
    wallet &&
      (wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet,
  );

  const sendTransaction = useCallback(
    async (transaction: Transaction) => {
      if (!wallet) throw new Error("no Privy Solana wallet connected");
      const bytes = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const { signature } = await privySend({
        transaction: bytes,
        wallet,
        chain: SIGNING_CHAIN,
        options: { sponsor: true },
      });
      return anchorUtils.bytes.bs58.encode(signature);
    },
    [wallet, privySend],
  );

  const signTransaction = useCallback(
    async <T extends Transaction | VersionedTransaction>(transaction: T) => {
      if (!wallet) throw new Error("no Privy Solana wallet connected");
      // Anchor builds the tx with its own copy of web3.js (pnpm keeps two,
      // split on a peer dep), so `instanceof Transaction` is false for a
      // legacy tx. Anchor's own check: only VersionedTransaction has `version`.
      const versioned = "version" in transaction;
      // A legacy Transaction verifies signatures on serialize() by default,
      // which throws "Missing signature" on the unsigned tx we hand to Privy.
      const bytes = versioned
        ? (transaction as VersionedTransaction).serialize()
        : (transaction as Transaction).serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          });
      const { signedTransaction } = await privySign({
        transaction: bytes,
        wallet,
        chain: SIGNING_CHAIN,
      });
      const signed = Uint8Array.from(signedTransaction);
      return (
        versioned
          ? VersionedTransaction.deserialize(signed)
          : Transaction.from(Buffer.from(signed))
      ) as T;
    },
    [wallet, privySign],
  );

  return {
    mode: "privy",
    publicKey: wallet ? safePubkey(wallet.address) : undefined,
    connected: ready && Boolean(wallet),
    connect: () => login(),
    // `logout()` only ends the Privy session. An external wallet Privy
    // auto-connected through wallet-standard stays in `useWallets`, so the
    // pill kept showing its address after the X. Drop the wallet too, and
    // don't let one failing (a 400 on an already-dead session) skip the other.
    disconnect: () => {
      void Promise.allSettled([wallet?.disconnect(), logout()]);
    },
    signTransaction,
    ...(embedded ? { sendTransaction } : {}),
  };
}

function useStandardSigner(): GameSigner {
  const { publicKey, wallet, connected, select } = useWallet();
  const { setVisible } = useWalletModal();

  const adapter = wallet?.adapter as unknown as
    | {
        signTransaction?: <T extends Transaction | VersionedTransaction>(
          tx: T,
        ) => Promise<T>;
        disconnect?: () => Promise<void>;
      }
    | undefined;

  return {
    mode: "standard",
    publicKey: publicKey ?? undefined,
    connected,
    connect: () => setVisible(true),
    disconnect: () => {
      void adapter?.disconnect?.();
      select(null as never);
    },
    signTransaction: adapter?.signTransaction?.bind(wallet!.adapter),
  };
}

const safePubkey = (address: string): PubkeyType | undefined => {
  try {
    return new PublicKey(address);
  } catch {
    return undefined;
  }
};

/** Convenience: `useConnection` re-export so App imports one wallet module. */
