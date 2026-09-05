// Must be the first import: it installs the Node `Buffer` global that the
// Solana packages read while their modules evaluate.
import "./shims/buffer.js";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { BurnerWalletAdapter, burnerEnabled } from "./dev-burner.js";
import {
  GameSignerProvider,
  WalletLayer,
  WalletModeProvider,
  walletModeFor,
} from "./wallets.js";
import { clusterEndpoint, clusterFromEnv } from "./wallet.js";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

const ENV: Record<string, string | undefined> = {
  VITE_CLUSTER: import.meta.env.VITE_CLUSTER as string | undefined,
  VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID as string | undefined,
  VITE_PRIVY_CLIENT_ID: import.meta.env.VITE_PRIVY_CLIENT_ID as
    | string
    | undefined,
  VITE_BURNER_WALLET: import.meta.env.VITE_BURNER_WALLET as string | undefined,
  VITE_RPC_URL: import.meta.env.VITE_RPC_URL as string | undefined,
};

// Cluster guard: refuse to boot anywhere but localnet/devnet.
const cluster = clusterFromEnv(ENV);
const endpoint = clusterEndpoint(cluster, ENV);
const mode = walletModeFor(ENV);

// Dev-only burner wallet: opt-in via env, localnet only (see dev-burner.ts).
// It augments (never replaces) the standard wallets in the fallback path.
const wallets = burnerEnabled(ENV, cluster) ? [new BurnerWalletAdapter()] : [];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletLayer env={ENV}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <WalletModeProvider mode={mode}>
              <GameSignerProvider env={ENV}>
                <App />
              </GameSignerProvider>
            </WalletModeProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </WalletLayer>
  </StrictMode>,
);
