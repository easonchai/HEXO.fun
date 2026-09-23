import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { heliusPriorityFeeEstimate, p75PriorityFeeMicroLamports, type RpcRequester } from "./priority-fee";

describe("p75PriorityFeeMicroLamports", () => {
  it("takes the 75th percentile of the samples", () => {
    // Nearest-rank on 4 sorted samples: ceil(0.75 * 4) - 1 = 2, the 3rd value.
    expect(p75PriorityFeeMicroLamports([100, 400, 200, 300], 1_000_000)).toBe(300);
  });

  it("drops zero samples before taking the percentile", () => {
    // Without the zeros this is the same [100, 200, 300, 400] as above.
    expect(p75PriorityFeeMicroLamports([0, 100, 0, 400, 200, 0, 300], 1_000_000)).toBe(300);
  });

  it("caps the result at maxMicroLamports", () => {
    expect(p75PriorityFeeMicroLamports([100, 400, 200, 300], 250)).toBe(250);
  });

  it("is 0 for an empty sample set", () => {
    expect(p75PriorityFeeMicroLamports([], 50_000)).toBe(0);
  });

  it("is 0 when every sample is zero", () => {
    expect(p75PriorityFeeMicroLamports([0, 0, 0], 50_000)).toBe(0);
  });

  it("takes the single sample for a one-element set", () => {
    expect(p75PriorityFeeMicroLamports([777], 50_000)).toBe(777);
  });
});

// Ticket 04: `send`'s fee estimate prefers Helius's own percentile estimator
// over the writable-account set, falling back to the p75 method above.
describe("heliusPriorityFeeEstimate", () => {
  const writable = [new PublicKey("11111111111111111111111111111111")];

  it("returns the Medium-level estimate, scoped to the writable accounts", async () => {
    let seenMethod: string | undefined;
    let seenParams: unknown;
    const rpc: RpcRequester = {
      _rpcRequest: (method, params) => {
        seenMethod = method;
        seenParams = params;
        return Promise.resolve({ result: { priorityFeeEstimate: 1234.7 } });
      },
    };

    await expect(heliusPriorityFeeEstimate(rpc, writable, 1_000_000)).resolves.toBe(1235);
    expect(seenMethod).toBe("getPriorityFeeEstimate");
    expect(seenParams).toEqual([
      { accountKeys: writable.map((pk) => pk.toBase58()), options: { priorityLevel: "Medium" } },
    ]);
  });

  it("caps the estimate at maxMicroLamports", async () => {
    const rpc: RpcRequester = {
      _rpcRequest: () => Promise.resolve({ result: { priorityFeeEstimate: 999_999 } }),
    };
    await expect(heliusPriorityFeeEstimate(rpc, writable, 500)).resolves.toBe(500);
  });

  it("is undefined on a JSON-RPC error (a non-Helius endpoint)", async () => {
    const rpc: RpcRequester = {
      _rpcRequest: () =>
        Promise.resolve({ error: { code: -32601, message: "Method not found" } }),
    };
    await expect(heliusPriorityFeeEstimate(rpc, writable, 1_000_000)).resolves.toBeUndefined();
  });

  it("is undefined when the call itself fails", async () => {
    const rpc: RpcRequester = {
      _rpcRequest: () => Promise.reject(new Error("network error")),
    };
    await expect(heliusPriorityFeeEstimate(rpc, writable, 1_000_000)).resolves.toBeUndefined();
  });

  it("is undefined on a malformed response", async () => {
    const rpc: RpcRequester = {
      _rpcRequest: () => Promise.resolve({ result: { somethingElse: 1 } }),
    };
    await expect(heliusPriorityFeeEstimate(rpc, writable, 1_000_000)).resolves.toBeUndefined();
  });
});
