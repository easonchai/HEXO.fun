import { describe, expect, it } from "vitest";

import {
  clusterFrom,
  faucetEnabled,
  gameGated,
  genesisMatchesCluster,
  jackpotGated,
} from "./cluster.js";

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

describe("gameGated", () => {
  it("gates only on the exact string \"off\"", () => {
    expect(gameGated("off")).toBe(true);
  });

  it("shows when unset", () => {
    expect(gameGated(undefined)).toBe(false);
  });

  it("shows on a stray value", () => {
    expect(gameGated("on")).toBe(false);
    expect(gameGated("OFF")).toBe(false);
  });
});

describe("jackpotGated", () => {
  it("gates only on the exact string \"off\"", () => {
    expect(jackpotGated("off")).toBe(true);
  });

  it("shows when unset", () => {
    expect(jackpotGated(undefined)).toBe(false);
  });

  it("shows on a stray value", () => {
    expect(jackpotGated("on")).toBe(false);
    expect(jackpotGated("OFF")).toBe(false);
  });
});

describe("genesisMatchesCluster", () => {
  it("matches devnet's own genesis hash", () => {
    expect(
      genesisMatchesCluster("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "devnet"),
    ).toBe(true);
  });

  it("matches mainnet-beta's own genesis hash", () => {
    expect(
      genesisMatchesCluster("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "mainnet-beta"),
    ).toBe(true);
  });

  it("refuses a devnet RPC on a mainnet build, and vice versa", () => {
    expect(
      genesisMatchesCluster("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "mainnet-beta"),
    ).toBe(false);
    expect(
      genesisMatchesCluster("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "devnet"),
    ).toBe(false);
  });
});
