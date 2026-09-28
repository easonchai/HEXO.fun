import { describe, expect, it } from "vitest";

import {
  evaluateAlerts,
  NEAR_CLOSE_SECONDS,
  OPERATOR_FAILING_SECONDS,
  type AlertInputs,
  type AlertThresholds,
} from "./alerts.controller";

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
  withdrawSkippedCount: 0,
  registrationIndexerStale: false,
  operatorFailingSeconds: null,
  epochNoProgress: false,
  drawnUnpaid: false,
  yieldBudgetLow: false,
  sparringSolLow: false,
  secondsToEpochClose: 7 * 24 * 60 * 60,
  jackpotAmount: 5_000_000n,
  minJackpot: 1_000_000n,
  principalOut: 0n,
  pendingWithdrawals: 0n,
  vaultLiquidity: 10_000_000n,
};

describe("evaluateAlerts", () => {
  it("is empty when every condition reads healthy", () => {
    expect(evaluateAlerts(HEALTHY, THRESHOLDS)).toEqual([]);
  });

  it("OPERATOR_SOL_LOW fires only on a true reading, not an unknown one", () => {
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: true }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_LOW", message: expect.any(String) },
    ]);
    // A failed chain read (null) is not evidence the operator is dry, matching
    // operatorHealthStatus in health.controller.ts, but it is its own
    // OPERATOR_SOL_READ_FAILED condition rather than reading as healthy
    // (ticket 09; see the dedicated test below).
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: null }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_READ_FAILED", message: expect.any(String) },
    ]);
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

  it("WITHDRAW_OWNERS_SKIPPED fires once at least one owner has been skipped", () => {
    expect(evaluateAlerts({ ...HEALTHY, withdrawSkippedCount: 2 }, THRESHOLDS)).toEqual([
      { code: "WITHDRAW_OWNERS_SKIPPED", message: expect.stringContaining("2") },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, withdrawSkippedCount: 0 }, THRESHOLDS)).toEqual([]);
  });

  it("REGISTRATION_INDEXER_STALE fires while close_registration is withheld", () => {
    expect(evaluateAlerts({ ...HEALTHY, registrationIndexerStale: true }, THRESHOLDS)).toEqual([
      { code: "REGISTRATION_INDEXER_STALE", message: expect.any(String) },
    ]);
  });

  it("OPERATOR_SOL_READ_FAILED fires on a failed read rather than reading as healthy", () => {
    expect(evaluateAlerts({ ...HEALTHY, operatorSolLow: null }, THRESHOLDS)).toEqual([
      { code: "OPERATOR_SOL_READ_FAILED", message: expect.any(String) },
    ]);
  });

  it("OPERATOR_FAILING fires once the last success is older than the threshold, while ticks run", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: OPERATOR_FAILING_SECONDS + 1 },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "OPERATOR_FAILING", message: expect.any(String) }]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: OPERATOR_FAILING_SECONDS },
        THRESHOLDS,
      ),
    ).toEqual([]);
    // Never succeeded: always trips the threshold.
    expect(
      evaluateAlerts(
        { ...HEALTHY, operatorFailingSeconds: Number.POSITIVE_INFINITY },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "OPERATOR_FAILING", message: expect.any(String) }]);
    // A tick that is not currently failing reads null, not zero.
    expect(evaluateAlerts({ ...HEALTHY, operatorFailingSeconds: null }, THRESHOLDS)).toEqual([]);
  });

  it("EPOCH_NO_PROGRESS and DRAWN_UNPAID fire independently off the operator's own read", () => {
    expect(evaluateAlerts({ ...HEALTHY, epochNoProgress: true }, THRESHOLDS)).toEqual([
      { code: "EPOCH_NO_PROGRESS", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, drawnUnpaid: true }, THRESHOLDS)).toEqual([
      { code: "DRAWN_UNPAID", message: expect.any(String) },
    ]);
  });

  it("YIELD_BUDGET_LOW mirrors /status's own yieldBudgetLow figure", () => {
    expect(evaluateAlerts({ ...HEALTHY, yieldBudgetLow: true }, THRESHOLDS)).toEqual([
      { code: "YIELD_BUDGET_LOW", message: expect.any(String) },
    ]);
  });

  it("SPARRING_SOL_LOW fires only on a true reading, not an unknown or disabled one", () => {
    expect(evaluateAlerts({ ...HEALTHY, sparringSolLow: true }, THRESHOLDS)).toEqual([
      { code: "SPARRING_SOL_LOW", message: expect.any(String) },
    ]);
    expect(evaluateAlerts({ ...HEALTHY, sparringSolLow: null }, THRESHOLDS)).toEqual([]);
  });

  it("JACKPOT_LOW_NEAR_CLOSE fires only inside the last hour before close", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, jackpotAmount: 0n },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "JACKPOT_LOW_NEAR_CLOSE", message: expect.any(String) }]);
    // Same shortfall, well outside the window: no page yet.
    expect(evaluateAlerts({ ...HEALTHY, jackpotAmount: 0n }, THRESHOLDS)).toEqual([]);
    // Inside the window but funded: no page.
    expect(
      evaluateAlerts({ ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS }, THRESHOLDS),
    ).toEqual([]);
    // A failed jackpot read is not evidence it is low.
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, jackpotAmount: null },
        THRESHOLDS,
      ),
    ).toEqual([]);
  });

  it("PRINCIPAL_OUT_NEAR_CLOSE fires only inside the last hour before close", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, principalOut: 1n },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "PRINCIPAL_OUT_NEAR_CLOSE", message: expect.any(String) }]);
    expect(evaluateAlerts({ ...HEALTHY, principalOut: 1n }, THRESHOLDS)).toEqual([]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, secondsToEpochClose: NEAR_CLOSE_SECONDS, principalOut: null },
        THRESHOLDS,
      ),
    ).toEqual([]);
  });

  it("WITHDRAW_FORECAST_SHORT fires when the total owed outruns vault liquidity", () => {
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 2n, vaultLiquidity: 1n },
        THRESHOLDS,
      ),
    ).toEqual([{ code: "WITHDRAW_FORECAST_SHORT", message: expect.any(String) }]);
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 1n, vaultLiquidity: 1n },
        THRESHOLDS,
      ),
    ).toEqual([]);
    // A failed vault read is not evidence of a shortfall.
    expect(
      evaluateAlerts(
        { ...HEALTHY, pendingWithdrawals: 2n, vaultLiquidity: null },
        THRESHOLDS,
      ),
    ).toEqual([]);
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
        withdrawSkippedCount: 1,
        registrationIndexerStale: true,
        operatorFailingSeconds: null,
        epochNoProgress: true,
        drawnUnpaid: true,
        yieldBudgetLow: true,
        sparringSolLow: true,
        secondsToEpochClose: NEAR_CLOSE_SECONDS,
        jackpotAmount: 0n,
        minJackpot: 1_000_000n,
        principalOut: 1n,
        pendingWithdrawals: 2n,
        vaultLiquidity: 1n,
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
      "WITHDRAW_OWNERS_SKIPPED",
      "REGISTRATION_INDEXER_STALE",
      "EPOCH_NO_PROGRESS",
      "DRAWN_UNPAID",
      "YIELD_BUDGET_LOW",
      "SPARRING_SOL_LOW",
      "JACKPOT_LOW_NEAR_CLOSE",
      "PRINCIPAL_OUT_NEAR_CLOSE",
      "WITHDRAW_FORECAST_SHORT",
    ]);
  });
});
