/**
 * Wallet layer: Privy is the primary connection path (VITE_PRIVY_APP_ID);
 * standard injected Solana wallets are the fallback when no App ID is
 * configured. Both modes reduce to one interface the app consumes:
 * publicKey + signTransaction, which is all AnchorProvider needs.
 */
import { PrivyProvider, useLogin, useLogout } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useStandardWallets,
} from "@privy-io/react-auth/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useContext, useCallback, type ReactNode } from "react";
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
}

const privyAppIdFrom = (
  env: Record<string, string | undefined>,
): string | undefined => env.VITE_PRIVY_APP_ID?.trim() || undefined;

export interface WalletEnvironment extends Record<string, string | undefined> {
  VITE_PRIVY_APP_ID?: string;
  VITE_PRIVY_CLIENT_ID?: string;
  VITE_CLUSTER?: string;
}

/** Privy boots only when an App ID is configured; otherwise standard wallets. */
export const walletModeFor = (env: WalletEnvironment): WalletMode =>
  privyAppIdFrom(env) ? "privy" : "standard";

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
  if (appId) {
    return (
      <PrivyProvider
        appId={appId}
        {...(clientId ? { clientId } : {})}
        config={{
          appearance: { theme: "light", accentColor: "#0022ff" },
          externalWallets: {
            solana: {
              connectors: toSolanaWalletConnectors({ shouldAutoConnect: true }),
            },
          },
          embeddedWallets: {
            solana: { createOnLogin: "users-without-wallets" },
          },
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
export function GameSignerProvider({
  env,
  children,
}: {
  env: WalletEnvironment;
  children: ReactNode;
}) {
  const mode = useWalletMode();
  return mode === "privy" ? (
    <PrivySignerSource env={env} mode={mode}>
      {children}
    </PrivySignerSource>
  ) : (
    <StandardSignerSource mode={mode}>{children}</StandardSignerSource>
  );
}

function PrivySignerSource({
  env,
  mode,
  children,
}: {
  env: WalletEnvironment;
  mode: WalletMode;
  children: ReactNode;
}) {
  const signer = usePrivySigner(env);
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

function usePrivySigner(env: WalletEnvironment): GameSigner {
  const { login } = useLogin();
  const { logout } = useLogout();
  const { wallets, ready } = useStandardWallets();
  const wallet = wallets[0];
  const account = wallet?.accounts[0];

  const signTransaction = useCallback(
    async <T extends Transaction | VersionedTransaction>(transaction: T) => {
      if (!wallet || !account)
        throw new Error("no Privy Solana wallet connected");
      const feature = wallet.features["solana:signTransaction"];
      if (!feature) throw new Error("wallet cannot sign Solana transactions");
      const chain =
        env.VITE_CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";
      // Wallet-standard methods are variadic: one input in, one output out.
      const [output] = await feature.signTransaction({
        transaction: transaction.serialize(),
        account,
        chain,
      });
      const signed = Uint8Array.from(output!.signedTransaction);
      if (transaction instanceof Transaction) {
        return Transaction.from(Buffer.from(signed)) as T;
      }
      return VersionedTransaction.deserialize(signed) as T;
    },
    [wallet, account, env.VITE_CLUSTER],
  );

  return {
    mode: "privy",
    publicKey: account ? safePubkey(account.address) : undefined,
    connected: ready && Boolean(account),
    connect: () => login(),
    disconnect: () => void logout(),
    signTransaction,
  };
}

function useStandardSigner(): GameSigner {
  const { publicKey, wallet, connected, connect, disconnect, select } =
    useWallet();
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

/** AnchorProvider-compatible wallet view of a GameSigner. */
export const anchorWalletOf = (
  signer: GameSigner,
): {
  publicKey: PubkeyType;
  signTransaction: <T extends Transaction | VersionedTransaction>(
    tx: T,
  ) => Promise<T>;
} | null =>
  signer.publicKey && signer.signTransaction
    ? { publicKey: signer.publicKey, signTransaction: signer.signTransaction }
    : null;

/** Convenience: `useConnection` re-export so App imports one wallet module. */
