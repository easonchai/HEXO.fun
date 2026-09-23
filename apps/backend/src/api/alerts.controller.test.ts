import { describe, expect, it } from "vitest";

import { evaluateAlerts, type AlertInputs, type AlertThresholds } from "./alerts.controller";

const THRESHOLDS: AlertThresholds = { tickStaleSeconds: 300, indexerStaleSeconds: 600 };

/** Every condition off: what a healthy pool reports. */
const HEALTHY: AlertInputs = {
  operatorSolLow: false,
  tickAgeSeconds: 10,
  shutdown: false,
  rpcOk: true,
  rpcFallbackAgeMs: null,
  indexerAgeSeconds: 5,
  withdrawShortfall: 0n,
  roundVoidedRecently: false,
  epochRolledOverRecently: false,
};

describe("evaluateAlerts", () => {
  it("is empty when every condition reads healthy", () => {
    expect(evaluateAlerts(HEALTHY, THRESHOLDS)).toEqual([]);
  });

  it("OPERATOR_SOL_LOW fires only on a true reading, not an unknown one", () => {
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: true }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_LOW", message: expect.any(String) },
    ]);
    // A failed chain read (null) is not evidence the operator is dry,
    // matching operatorHealthStatus in health.controller.ts.
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: null }, THRESHOLDS)).toEqual([]);
  });

  it("OPERATOR_STALE fires once the last tick is older than the threshold", () => {
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 301 }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_STALE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 300 }, THRESHOLDS)).toEqual([]);
    // Never ticked yet reads as unknown, not stale.
    expect(evaluateAlerts({ ...HEALTHY, tickAgeSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("a shutdown pool suppresses OPERATOR_STALE, because it stopped ticking on purpose", () => {
    expect(
      evaluateAlerts({ ...HEALTHY, tickAgeSeconds: 10_000, shutdown: true }, THRESHOLDS),
    ).toEqual([]);
  });

  it("RPC_DOWN fires when the primary probe fails", () => {
    expect(evaluateAlerts({ ...HEALTHY, rpcOk: false }, THRESHOLDS)).toEqual([
      { code: "RPC_DOWN", message: expect.any(String) },
    ]);
  });

  it("RPC_FALLBACK_ACTIVE fires only within the 10-minute window", () => {
    expect(evaluateAlerts({ ...HEALTHY, rpcFallbackAgeMs: 5 * 60 * 1000 }, THRESHOLDS)).toEqual([
      { code: "RPC_FALLBACK_ACTIVE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, rpcFallbackAgeMs: 11 * 60 * 1000 }, THRESHOLDS)).toEqual(
      [],
    );
  });

  it("INDEXER_STALE fires once the cursor is older than the threshold", () => {
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: 601 }, THRESHOLDS)).toEqual([
      { code: "INDEXER_STALE", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: 600 }, THRESHOLDS)).toEqual([]);
    // Never synced yet reads as unknown, not stale.
    expect(evaluateAlerts({ ...HEALTHY, indexerAgeSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("WITHDRAW_SHORTFALL fires once the last tick found the vault short", () => {
    expect(evaluateAlerts({ ...HEALTHY, withdrawShortfall: 1n }, THRESHOLDS)).toEqual([
      { code: "WITHDRAW_SHORTFALL", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, withdrawShortfall: 0n }, THRESHOLDS)).toEqual([]);
  });

  it("ROUND_VOIDED_RECENTLY and EPOCH_ROLLED_OVER_RECENTLY fire independently", () => {
    expect(evaluateAlerts({ ...HEALTHY, roundVoidedRecently: true }, THRESHOLDS)).toEqual([
      { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, epochRolledOverRecently: true }, THRESHOLDS)).toEqual([
      { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
    ]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, roundVoidedRecently: true, epochRolledOverRecently: true },
        THRESHOLDS,
      ),
    ).toEqual([
      { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
      { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
    ]);
  });

  it("stacks every active condition at once", () => {
    const codes = evaluateAlerts(
      {
        operatorSolLow: true,
        tickAgeSeconds: 301,
        shutdown: false,
        rpcOk: false,
        rpcFallbackAgeMs: 0,
        indexerAgeSeconds: 601,
        withdrawShortfall: 1n,
        roundVoidedRecently: true,
        epochRolledOverRecently: true,
      },
      THRESHOLDS,
    ).map((alert) => alert.code);
    expect(codes).toEqual([
      "OPERATOR_SOL_LOW",
      "OPERATOR_STALE",
      "RPC_DOWN",
      "RPC_FALLBACK_ACTIVE",
      "INDEXER_STALE",
      "WITHDRAW_SHORTFALL",
      "ROUND_VOIDED_RECENTLY",
      "EPOCH_ROLLED_OVER_RECENTLY",
    ]);
  });
});
