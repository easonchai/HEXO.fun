import { describe, expect, it } from "vitest";

import { shutdownWithdrawStep } from "./shutdown.js";

describe("shutdownWithdrawStep", () => {
  it("requests then processes when there is a fresh amount to withdraw", () => {
    expect(shutdownWithdrawStep(5_000_000n, 0n)).toEqual({
      kind: "request-and-process",
      amount: 5_000_000n,
    });
  });

  it("still requests then processes when a pending amount already exists", () => {
    // request_withdraw merges into the existing pending row (custody.rs), so
    // the fresh amount always wins the decision.
    expect(shutdownWithdrawStep(5_000_000n, 2_000_000n)).toEqual({
      kind: "request-and-process",
      amount: 5_000_000n,
    });
  });

  it("processes alone with nothing new to request", () => {
    expect(shutdownWithdrawStep(0n, 2_000_000n)).toEqual({ kind: "process-only" });
  });

  it("has nothing to send with neither", () => {
    expect(shutdownWithdrawStep(0n, 0n)).toEqual({ kind: "none" });
  });
});
