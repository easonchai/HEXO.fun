import { describe, expect, it } from "vitest";

import {
  assertSupportedWallet,
  clusterEndpoint,
  clusterFromEnv,
  walletConfiguration,
} from "./wallet.js";

describe("wallet configuration", () => {
  it("uses an external-wallet-safe default without a Privy credential", () => {
    expect(walletConfiguration({})).toEqual({ mode: "standard-solana" });
  });

  it("enables Privy only with a non-empty app ID", () => {
    expect(walletConfiguration({ VITE_PRIVY_APP_ID: "  app-id  " })).toEqual({
      mode: "privy",
      privyAppId: "app-id",
    });
  });

  it("refuses any cluster outside localnet/devnet", () => {
    expect(() => assertSupportedWallet("localhost")).toThrow(
      "unsupported cluster",
    );
    expect(() => assertSupportedWallet("mainnet-beta")).toThrow(
      "unsupported cluster",
    );
    expect(() => assertSupportedWallet("")).toThrow("unsupported cluster");
    expect(() => assertSupportedWallet("localnet")).not.toThrow();
    expect(() => assertSupportedWallet("devnet")).not.toThrow();
  });

  it("defaults the cluster to localnet and maps it to an RPC endpoint", () => {
    expect(clusterFromEnv({})).toBe("localnet");
    expect(clusterFromEnv({ VITE_CLUSTER: " devnet " })).toBe("devnet");
    expect(() => clusterFromEnv({ VITE_CLUSTER: "mainnet-beta" })).toThrow(
      "unsupported cluster",
    );
    expect(clusterEndpoint("localnet")).toBe("http://127.0.0.1:8899");
    expect(clusterEndpoint("devnet")).toContain("devnet");
  });
});
