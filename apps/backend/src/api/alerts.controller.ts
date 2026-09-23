import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { ApiService } from "./api.service";

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
  | "EPOCH_ROLLED_OVER_RECENTLY";

export interface Alert {
  code: AlertCode;
  message: string;
}

/** Not env-tunable: spec.md's alerts decision only names `OPERATOR_SOL_WARN`,
 *  `ALERT_TICK_STALE_S` and `ALERT_INDEXER_STALE_S` as thresholds. */
export const RPC_FALLBACK_RECENT_MS = 10 * 60 * 1000;
export const VOID_OR_ROLLOVER_RECENT_S = 60 * 60;

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
