import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { ApiService, EPOCH_OPEN } from "./api.service";

/** production-hardening ticket 05's codes, kept identical to
 *  docs/ops/incidents.md's playbook headers. */
export type AlertCode =
  | "OPERATOR_SOL_LOW"
  | "OPERATOR_STALE"
  | "RPC_DOWN"
  | "RPC_FALLBACK_ACTIVE"
  | "INDEXER_STALE"
  | "WITHDRAW_SHORTFALL"
  | "ROUND_VOIDED_RECENTLY"
  | "EPOCH_ROLLED_OVER_RECENTLY"
  | "WITHDRAW_OWNERS_SKIPPED"
  | "REGISTRATION_INDEXER_STALE"
  | "OPERATOR_SOL_READ_FAILED"
  | "OPERATOR_FAILING"
  | "EPOCH_NO_PROGRESS"
  | "DRAWN_UNPAID"
  | "YIELD_BUDGET_LOW"
  | "SPARRING_SOL_LOW"
  | "JACKPOT_LOW_NEAR_CLOSE"
  | "PRINCIPAL_OUT_NEAR_CLOSE"
  | "WITHDRAW_FORECAST_SHORT";

export interface Alert {
  code: AlertCode;
  message: string;
}

/** Not env-tunable: spec.md's alerts decision only names `OPERATOR_SOL_WARN`,
 *  `ALERT_TICK_STALE_S` and `ALERT_INDEXER_STALE_S` as thresholds. */
export const RPC_FALLBACK_RECENT_MS = 10 * 60 * 1000;
export const VOID_OR_ROLLOVER_RECENT_S = 60 * 60;
/** Ticket 09: how long the operator's last error may persist, while ticks
 *  keep running, before OPERATOR_FAILING pages someone. Not env-tunable, for
 *  the same reason as the two constants above. */
export const OPERATOR_FAILING_SECONDS = 5 * 60;
/** Ticket 09: "inside the last hour before close" for the jackpot and
 *  principal-out conditions, straight from spec.md's own wording. */
export const NEAR_CLOSE_SECONDS = 60 * 60;

/** Everything `evaluateAlerts` needs, already resolved to plain values so it
 *  stays DB- and chain-free and is cheap to seed from a test. */
export interface AlertInputs {
  /** `/status`'s `operatorSolLow`; null (a failed chain read) never alerts,
   *  matching `operatorHealthStatus` in health.controller.ts. */
  operatorSolLow: boolean | null;
  /** Seconds since the operator's last tick, or null before its first one. */
  tickAgeSeconds: number | null;
  /** Admin-only and irreversible (ops-and-envs ticket 08): a shut-down pool
   *  stops ticking on purpose, so it never counts as stalled. */
  shutdown: boolean;
  rpcOk: boolean;
  /** Milliseconds since the last RPC failover, or null if there has never
   *  been one. */
  rpcFallbackAgeMs: number | null;
  /** Seconds since the indexer cursor last advanced, or null if it has
   *  never synced. */
  indexerAgeSeconds: number | null;
  /** OperatorState.withdrawShortfall, already 0n for "never checked" and
   *  "covered" alike (ApiService.getStatus already collapses the two). */
  withdrawShortfall: bigint;
  roundVoidedRecently: boolean;
  epochRolledOverRecently: boolean;
  /** Ticket 06: OperatorState.withdrawSkippedCount, 0 for "never checked"
   *  and "none skipped" alike. */
  withdrawSkippedCount: number;
  /** Ticket 07: OperatorState.registrationIndexerStale. */
  registrationIndexerStale: boolean;
  /** Ticket 09: seconds since the operator's last successful tick, while the
   *  current one is still failing; null when the last tick did not fail
   *  (OperatorState.lastError is null). `Infinity` stands for "never
   *  succeeded", which always trips the threshold. */
  operatorFailingSeconds: number | null;
  /** Ticket 09: OperatorState.epochNoProgress. */
  epochNoProgress: boolean;
  /** Ticket 09: OperatorState.drawnUnpaid. */
  drawnUnpaid: boolean;
  /** Ticket 09: ApiService's `yieldBudgetLow`, already computed for /status. */
  yieldBudgetLow: boolean;
  /** Ticket 09: null when the sparring player is not configured, or its
   *  balance read failed; both read as "nothing to warn about" the same way
   *  a failed operator SOL read does not itself mean the operator is low. */
  sparringSolLow: boolean | null;
  /** Ticket 09: seconds until the current epoch's `endsAt`, only while it is
   *  still Open; null once it has closed or none is indexed yet. */
  secondsToEpochClose: number | null;
  /** Ticket 09: the live jackpot vault balance for the current Open epoch;
   *  null when the read failed. */
  jackpotAmount: bigint | null;
  /** Ticket 09: `Pool.minJackpot`; 0 before a pool is indexed. */
  minJackpot: bigint;
  /** Ticket 09: `/status`'s `principalOut`; null when unknown. */
  principalOut: bigint | null;
  /** Ticket 09: `Pool.pendingWithdrawals`, the total still owed. */
  pendingWithdrawals: bigint;
  /** Ticket 09: `/status`'s `vaultLiquidity`; null when the read failed. */
  vaultLiquidity: bigint | null;
}

export interface AlertThresholds {
  tickStaleSeconds: number;
  indexerStaleSeconds: number;
}

/**
 * The active conditions for `inputs`, in the fixed order spec.md §5 lists
 * them. Pure and DB-free, like `operatorHealthStatus`, so every condition is
 * a direct unit test instead of a seeded round trip through Postgres.
 */
export function evaluateAlerts(inputs: AlertInputs, thresholds: AlertThresholds): Alert[] {
  const alerts: Alert[] = [];
  if (inputs.operatorSolLow === true) {
    alerts.push({
      code: "OPERATOR_SOL_LOW",
      message: "The operator's SOL balance is below OPERATOR_SOL_WARN.",
    });
  }
  if (inputs.operatorSolLow === null) {
    // Ticket 09: a failed read is not evidence the operator still has fees,
    // and it must not silently read as healthy either.
    alerts.push({
      code: "OPERATOR_SOL_READ_FAILED",
      message: "The operator's SOL balance could not be read.",
    });
  }
  if (
    !inputs.shutdown &&
    inputs.tickAgeSeconds !== null &&
    inputs.tickAgeSeconds > thresholds.tickStaleSeconds
  ) {
    alerts.push({
      code: "OPERATOR_STALE",
      message: `The operator has not ticked in over ${thresholds.tickStaleSeconds}s.`,
    });
  }
  if (
    inputs.operatorFailingSeconds !== null &&
    inputs.operatorFailingSeconds > OPERATOR_FAILING_SECONDS
  ) {
    // Distinct from OPERATOR_STALE: ticks are running (a fresh lastTickAt),
    // but every one of them has been failing for a while.
    alerts.push({
      code: "OPERATOR_FAILING",
      message: `The operator has not completed a tick without error in over ${OPERATOR_FAILING_SECONDS}s.`,
    });
  }
  if (!inputs.rpcOk) {
    alerts.push({ code: "RPC_DOWN", message: "The primary RPC is not responding." });
  }
  if (inputs.rpcFallbackAgeMs !== null && inputs.rpcFallbackAgeMs < RPC_FALLBACK_RECENT_MS) {
    alerts.push({
      code: "RPC_FALLBACK_ACTIVE",
      message: "The backend failed over to the fallback RPC in the last 10 minutes.",
    });
  }
  if (
    inputs.indexerAgeSeconds !== null &&
    inputs.indexerAgeSeconds > thresholds.indexerStaleSeconds
  ) {
    alerts.push({
      code: "INDEXER_STALE",
      message: `The indexer cursor has not advanced in over ${thresholds.indexerStaleSeconds}s.`,
    });
  }
  if (inputs.withdrawShortfall > 0n) {
    alerts.push({
      code: "WITHDRAW_SHORTFALL",
      message: "The principal vault fell short of a pending withdrawal on the last tick.",
    });
  }
  if (inputs.roundVoidedRecently) {
    alerts.push({ code: "ROUND_VOIDED_RECENTLY", message: "A round voided in the last hour." });
  }
  if (inputs.epochRolledOverRecently) {
    alerts.push({
      code: "EPOCH_ROLLED_OVER_RECENTLY",
      message: "An epoch rolled over without paying out in the last hour.",
    });
  }
  if (inputs.withdrawSkippedCount > 0) {
    alerts.push({
      code: "WITHDRAW_OWNERS_SKIPPED",
      message: `${inputs.withdrawSkippedCount} owner(s) skipped after repeated withdrawal failures this epoch.`,
    });
  }
  if (inputs.registrationIndexerStale) {
    alerts.push({
      code: "REGISTRATION_INDEXER_STALE",
      message: "close_registration is withheld: the indexer cursor is stale or behind the epoch's end.",
    });
  }
  if (inputs.epochNoProgress) {
    alerts.push({
      code: "EPOCH_NO_PROGRESS",
      message: "The epoch has not reached a terminal status within its expected deadline.",
    });
  }
  if (inputs.drawnUnpaid) {
    alerts.push({
      code: "DRAWN_UNPAID",
      message: "The epoch drew a winner more than a few minutes ago and it is still unpaid.",
    });
  }
  if (inputs.yieldBudgetLow) {
    alerts.push({
      code: "YIELD_BUDGET_LOW",
      message: "The yield budget is below the cost of one epoch's Base yield.",
    });
  }
  if (inputs.sparringSolLow === true) {
    alerts.push({
      code: "SPARRING_SOL_LOW",
      message: "The sparring player's SOL balance is below OPERATOR_SOL_WARN.",
    });
  }
  const nearClose =
    inputs.secondsToEpochClose !== null &&
    inputs.secondsToEpochClose >= 0 &&
    inputs.secondsToEpochClose <= NEAR_CLOSE_SECONDS;
  if (nearClose && inputs.jackpotAmount !== null && inputs.jackpotAmount < inputs.minJackpot) {
    alerts.push({
      code: "JACKPOT_LOW_NEAR_CLOSE",
      message: "The jackpot vault is below min_jackpot inside the last hour before close.",
    });
  }
  if (nearClose && inputs.principalOut !== null && inputs.principalOut > 0n) {
    alerts.push({
      code: "PRINCIPAL_OUT_NEAR_CLOSE",
      message: "Principal is still out of the vault inside the last hour before close.",
    });
  }
  if (inputs.vaultLiquidity !== null && inputs.pendingWithdrawals > inputs.vaultLiquidity) {
    alerts.push({
      code: "WITHDRAW_FORECAST_SHORT",
      message: "Due pending withdrawals are forecast to exceed vault liquidity.",
    });
  }
  return alerts;
}

/**
 * One URL an external uptime monitor polls (spec.md item 5, ticket 05): 200
 * with an empty list when nothing needs a human, 503 with the active codes
 * otherwise. Separate from `/healthz`, which stays a pure liveness probe.
 *
 * Reads only `ApiService.getStatus()` (itself cached or DB-backed already,
 * same as `/status`) plus one extra Event query for the void/rollover
 * conditions, so a poll never costs a fresh RPC call. Not explicitly
 * throttled: api.module.ts's guard already skips every ApiController-style
 * read route, and this joins them.
 */
@Controller()
export class AlertsController {
  private readonly tickStaleSeconds: number;
  private readonly indexerStaleSeconds: number;

  constructor(
    private readonly api: ApiService,
    private readonly prisma: PrismaService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.tickStaleSeconds = config.get("ALERT_TICK_STALE_S", { infer: true });
    this.indexerStaleSeconds = config.get("ALERT_INDEXER_STALE_S", { infer: true });
  }

  @Get("alerts")
  async getAlerts(): Promise<{ alerts: Alert[] }> {
    const [status, recent] = await Promise.all([
      this.api.getStatus(),
      this.recentVoidOrRollover(),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastTickAt = status.operator?.lastTickAt;
    const lastError = status.operator?.lastError ?? null;
    const lastSuccessAt = status.operator?.lastSuccessAt ?? null;
    // Ticket 09: null when the last tick did not fail; Infinity when it
    // failed but the operator has never once succeeded, which always trips
    // the threshold rather than reading as "just started failing".
    const operatorFailingSeconds =
      lastError === null
        ? null
        : lastSuccessAt === null
          ? Number.POSITIVE_INFINITY
          : nowSeconds - Math.floor(lastSuccessAt.getTime() / 1000);
    const secondsToEpochClose =
      status.epochStatus === EPOCH_OPEN && status.epochEndsAt !== null
        ? Number(status.epochEndsAt - BigInt(nowSeconds))
        : null;
    const alerts = evaluateAlerts(
      {
        operatorSolLow: status.operatorSolLow,
        tickAgeSeconds: lastTickAt == null ? null : nowSeconds - Math.floor(lastTickAt.getTime() / 1000),
        shutdown: status.shutdown,
        rpcOk: status.rpcOk,
        rpcFallbackAgeMs:
          status.rpcFallbackAt === null ? null : Date.now() - status.rpcFallbackAt.getTime(),
        indexerAgeSeconds: status.cursor.ageSeconds,
        withdrawShortfall: status.withdrawShortfall,
        roundVoidedRecently: recent.roundVoidedRecently,
        epochRolledOverRecently: recent.epochRolledOverRecently,
        withdrawSkippedCount: status.withdrawSkippedCount,
        registrationIndexerStale: status.registrationIndexerStale,
        operatorFailingSeconds,
        epochNoProgress: status.operator?.epochNoProgress ?? false,
        drawnUnpaid: status.operator?.drawnUnpaid ?? false,
        yieldBudgetLow: status.yieldBudgetLow,
        sparringSolLow: status.sparringSolLow,
        secondsToEpochClose,
        jackpotAmount: status.jackpotAmount,
        minJackpot: status.minJackpot,
        principalOut: status.principalOut,
        pendingWithdrawals: status.pendingWithdrawals,
        vaultLiquidity: status.vaultLiquidity,
      },
      { tickStaleSeconds: this.tickStaleSeconds, indexerStaleSeconds: this.indexerStaleSeconds },
    );
    if (alerts.length > 0) {
      // Nest serializes an HttpException's first argument as the body
      // as-is (faucet.controller.ts's 429 does the same), so this is the
      // exact { alerts } shape the 200 branch below returns.
      throw new HttpException({ alerts }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { alerts };
  }

  /** `RoundVoided`/`EpochRolledOver` are two of `FEED_NAMES` in
   *  api.service.ts; `decode.ts`'s `declaredName` is what puts them in the
   *  Event table under those exact names. `distinct` caps this at two rows. */
  private async recentVoidOrRollover(): Promise<{
    roundVoidedRecently: boolean;
    epochRolledOverRecently: boolean;
  }> {
    const cutoff = BigInt(Math.floor(Date.now() / 1000) - VOID_OR_ROLLOVER_RECENT_S);
    const rows = await this.prisma.event.findMany({
      where: { name: { in: ["RoundVoided", "EpochRolledOver"] }, blockTime: { gte: cutoff } },
      select: { name: true },
      distinct: ["name"],
    });
    return {
      roundVoidedRecently: rows.some((row) => row.name === "RoundVoided"),
      epochRolledOverRecently: rows.some((row) => row.name === "EpochRolledOver"),
    };
  }
}
