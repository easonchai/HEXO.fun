import { PublicKey, type Connection } from "@solana/web3.js";
import type { Pool as PgPool } from "pg";
import type { SnapshotService } from "./snapshot.ts";

export interface ReconcileOutcome {
  readonly pool: string;
  readonly check: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

export interface ReconcileDeps {
  readonly connection: Connection;
  readonly pg: PgPool;
  readonly snapshots: SnapshotService;
  readonly log: (obj: Record<string, unknown>, msg: string) => void;
}

export class Reconciler {
  private readonly deps: ReconcileDeps;

  constructor(deps: ReconcileDeps) {
    this.deps = deps;
  }

  /**
   * Runs every check for every indexed pool and persists one row per check.
   * Balances are read straight from the RPC so a drifted projection is caught.
   */
  async runAll(): Promise<ReconcileOutcome[]> {
    const { rows: poolRows } = await this.deps.pg.query<{ address: string }>(
      "SELECT address FROM pools ORDER BY address",
    );
    const results: ReconcileOutcome[] = [];
    for (const row of poolRows) {
      const address = row.address;
      // One unreachable account must not silently drop the other checks.
      for (const [name, check] of [
        ["principal_backing", () => this.principalBacked(address)],
        ["prize_covered", () => this.prizeCovered(address)],
        ["jackpot_covered", () => this.jackpotCovered(address)],
        ["canonical_root", () => this.canonicalRoot(address)],
      ] as const) {
        results.push(await this.guard(name, address, check));
      }
    }
    results.push(
      await this.guard("cursor_freshness", "*", () => this.cursorFreshness()),
    );
    await this.record(results);
    return results;
  }

  /** (1) PT mint supply must equal the principal vault token balance. */
  async principalBacked(pool: string): Promise<ReconcileOutcome> {
    const cfg = await this.poolConfig(pool);
    if (!cfg?.principal_mint || !cfg.principal_vault)
      return skipped(pool, "principal_backing");
    const [supply, vault] = await Promise.all([
      this.deps.connection.getTokenSupply(new PublicKey(cfg.principal_mint)),
      this.deps.connection.getTokenAccountBalance(
        new PublicKey(cfg.principal_vault),
      ),
    ]);
    const minted = BigInt(supply.value.amount);
    const held = BigInt(vault.value.amount);
    return finish(pool, "principal_backing", minted === held, {
      principal_mint_supply: minted.toString(),
      principal_vault_balance: held.toString(),
    });
  }

  /** (2) Prize vault must cover the committed prize of every unresolved epoch. */
  async prizeCovered(pool: string): Promise<ReconcileOutcome> {
    const cfg = await this.poolConfig(pool);
    if (!cfg?.prize_vault) return skipped(pool, "prize_covered");
    const required = await this.unresolvedTotal(
      "SELECT COALESCE(SUM(prize_amount),0)::text AS total FROM epochs WHERE pool = $1 AND status IN (1,2,3)",
      pool,
    );
    if (required === 0n)
      return finish(pool, "prize_covered", true, { required: "0" });
    const held = await this.vaultBalance(cfg.prize_vault);
    return finish(pool, "prize_covered", held >= required, {
      required: required.toString(),
      prize_vault_balance: held.toString(),
    });
  }

  /** (3) Jackpot vault must cover the committed jackpot of unresolved epochs. */
  async jackpotCovered(pool: string): Promise<ReconcileOutcome> {
    const cfg = await this.poolConfig(pool);
    if (!cfg?.jackpot_vault) return skipped(pool, "jackpot_covered");
    const required = await this.unresolvedTotal(
      "SELECT COALESCE(SUM(jackpot_amount),0)::text AS total FROM epochs WHERE pool = $1 AND jackpot_status IN (1,2)",
      pool,
    );
    if (required === 0n)
      return finish(pool, "jackpot_covered", true, { required: "0" });
    const held = await this.vaultBalance(cfg.jackpot_vault);
    return finish(pool, "jackpot_covered", held >= required, {
      required: required.toString(),
      jackpot_vault_balance: held.toString(),
    });
  }

  /** (4) Canonical Merkle root must equal the on-chain committed root. */
  async canonicalRoot(pool: string): Promise<ReconcileOutcome> {
    const { rows } = await this.deps.pg.query<{
      epoch_id: string;
      root: Buffer;
    }>(
      `SELECT epoch_id, prize_snapshot_root AS root FROM epochs
       WHERE pool = $1 AND status >= 1 AND prize_snapshot_root IS NOT NULL
       ORDER BY epoch_id DESC LIMIT 1`,
      [pool],
    );
    const row = rows[0];
    if (!row) return skipped(pool, "canonical_root");
    const comparison = await this.deps.snapshots.compareWithCommitted(
      pool,
      row.epoch_id,
      Buffer.from(row.root),
    );
    return finish(pool, "canonical_root", comparison.ok, comparison);
  }

  /** (5) The cursor must have advanced recently enough to be useful. */
  async cursorFreshness(): Promise<ReconcileOutcome> {
    const { rows } = await this.deps.pg.query<{
      slot: string;
      updated_at: Date;
    }>("SELECT slot, updated_at FROM cursor WHERE id = 1");
    const row = rows[0];
    if (!row) return finish("*", "cursor_freshness", false, { cursor: null });
    const ageSeconds = Math.round(
      (Date.now() - row.updated_at.getTime()) / 1000,
    );
    // A quiet devnet/localnet chain is healthy; what matters is that the ingest
    // loop is alive, so the ceiling is deliberately generous.
    return finish("*", "cursor_freshness", ageSeconds < 3600, {
      age_seconds: ageSeconds,
      slot: row.slot,
    });
  }

  private async guard(
    check: string,
    pool: string,
    run: () => Promise<ReconcileOutcome>,
  ): Promise<ReconcileOutcome> {
    try {
      return await run();
    } catch (error) {
      // An unreachable account is itself a finding, not a reason to skip.
      return finish(pool, check, false, { error: String(error) });
    }
  }

  private async unresolvedTotal(sql: string, pool: string): Promise<bigint> {
    const { rows } = await this.deps.pg.query<{ total: string }>(sql, [pool]);
    return BigInt(rows[0]?.total ?? "0");
  }

  private async vaultBalance(vault: string): Promise<bigint> {
    const balance = await this.deps.connection.getTokenAccountBalance(
      new PublicKey(vault),
    );
    return BigInt(balance.value.amount);
  }

  private async poolConfig(
    pool: string,
  ): Promise<Record<string, string | null> | null> {
    const { rows } = await this.deps.pg.query<{
      principal_mint: string;
      principal_vault: string;
      prize_vault: string;
      jackpot_vault: string;
    }>(
      "SELECT principal_mint, principal_vault, prize_vault, jackpot_vault FROM pools WHERE address = $1",
      [pool],
    );
    return rows[0] ?? null;
  }

  private async record(outcomes: readonly ReconcileOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      await this.deps.pg.query(
        "INSERT INTO reconciliation_runs (pool, check_name, ok, detail) VALUES ($1,$2,$3,$4)",
        [
          outcome.pool,
          outcome.check,
          outcome.ok,
          JSON.stringify(outcome.detail),
        ],
      );
    }
    const failed = outcomes.filter((outcome) => !outcome.ok).length;
    this.deps.log(
      { count: outcomes.length, failed },
      "reconciliation finished",
    );
  }
}

const finish = (
  pool: string,
  check: string,
  ok: boolean,
  detail: Record<string, unknown>,
): ReconcileOutcome => ({ pool, check, ok, detail });

const skipped = (pool: string, check: string): ReconcileOutcome =>
  finish(pool, check, true, { skipped: true });
