import { Controller, Get, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import { ChainService, RPC_READ_TIMEOUT_MS, withTimeout } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";

/** How long a `/healthz` probe's operator-SOL read is cached (ticket 10): a
 *  container or uptime probe can hit this every few seconds, and this keeps
 *  it from turning into a chain read per hit. */
export const OPERATOR_SOL_HEALTH_TTL_MS = 30_000;

/**
 * "degraded" once the operator's SOL drops under `warnBelowSol`. Unknown (a
 * failed chain read, `operatorSol` null) reads as "ok" rather than a false
 * alarm — a dead RPC already shows up elsewhere (`/status`'s `rpcOk`).
 */
export function operatorHealthStatus(
  operatorSol: number | null,
  warnBelowSol: number,
): "ok" | "degraded" {
  return operatorSol !== null && operatorSol < warnBelowSol ? "degraded" : "ok";
}

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly operatorSolWarn: number;
  private cache: { at: number; result: Promise<number> } | undefined;

  constructor(
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.operatorSolWarn = config.get("OPERATOR_SOL_WARN", { infer: true });
  }

  @Get("healthz")
  async healthz(): Promise<{
    ok: true;
    status: "ok" | "degraded";
    operatorSol: number | null;
  }> {
    const operatorSol = await this.operatorSolBalance();
    return {
      ok: true,
      status: operatorHealthStatus(operatorSol, this.operatorSolWarn),
      operatorSol,
    };
  }

  /**
   * Cached for `OPERATOR_SOL_HEALTH_TTL_MS`. Reads through
   * `getMultipleAccountsInfo`, the same call `/status` already makes, rather
   * than a dedicated `getBalance`, so this needs no new chain-service method
   * and no Helius-specific API. Null (unknown), not zero, on a failed read;
   * a failure clears the slot instead of sitting cached for the window, so
   * the next probe past this call retries the chain instead of repeating
   * the same "unknown" for the rest of it.
   */
  private operatorSolBalance(): Promise<number | null> {
    if (
      this.cache === undefined ||
      Date.now() - this.cache.at > OPERATOR_SOL_HEALTH_TTL_MS
    ) {
      const result = withTimeout(
        this.chain.connection.getMultipleAccountsInfo([this.chain.keypair.publicKey]),
        RPC_READ_TIMEOUT_MS,
        "operator SOL read",
      ).then(([account]) => (account ? account.lamports / LAMPORTS_PER_SOL : 0));
      const entry = { at: Date.now(), result };
      this.cache = entry;
      result.catch(() => {
        if (this.cache === entry) this.cache = undefined;
      });
    }
    return this.cache.result.catch((cause: unknown) => {
      this.logger.warn(
        `operator SOL read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    });
  }
}
