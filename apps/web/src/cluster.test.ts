import { describe, expect, it } from "vitest";

import { clusterFrom, faucetEnabled } from "./cluster.js";

describe("VITE_CLUSTER", () => {
  it("defaults to devnet when unset or blank", () => {
    expect(clusterFrom({})).toBe("devnet");
    expect(clusterFrom({ VITE_CLUSTER: "" })).toBe("devnet");
    expect(clusterFrom({ VITE_CLUSTER: "  " })).toBe("devnet");
  });

  it("accepts the two clusters this app ships to", () => {
    expect(clusterFrom({ VITE_CLUSTER: "devnet" })).toBe("devnet");
    expect(clusterFrom({ VITE_CLUSTER: " mainnet-beta " })).toBe("mainnet-beta");
  });

  it("fails loudly on anything else", () => {
    // A typo must not ship a mainnet bundle that signs on devnet.
    expect(() => clusterFrom({ VITE_CLUSTER: "mainnet" })).toThrow(
      /VITE_CLUSTER/,
    );
    expect(() => clusterFrom({ VITE_CLUSTER: "testnet" })).toThrow();
  });

  it("hides the wallet menu's faucet item off devnet", () => {
    expect(faucetEnabled(clusterFrom({ VITE_CLUSTER: "mainnet-beta" }))).toBe(
      false,
    );
    expect(faucetEnabled(clusterFrom({}))).toBe(true);
  });
});
