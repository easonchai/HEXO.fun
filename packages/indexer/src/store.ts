import { readFileSync } from "node:fs";
import type { Pool as PgPool, PoolClient } from "pg";
import {
  compareCursor,
  cursorKey,
  type Cursor,
  type EventRow,
} from "./events.ts";

export const big = (value: bigint): string => value.toString();

/** Payloads arrive from the decoder as strings, but accept bigints defensively. */
const stringifyPayload = (payload: Record<string, unknown>): string =>
  JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

const epochIdOf = (payload: Record<string, unknown>): string =>
  big(BigInt(String(payload.epoch_id)));

/** Revives decimal-string integers stored in jsonb payloads back into bigints. */
export function revive(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = revive(entry);
    }
    return out;
  }
  return value;
}

export class Store {
  private readonly pool: PgPool;
  private readonly log: (obj: Record<string, unknown>, msg: string) => void;

  constructor(
    pool: PgPool,
    log: (obj: Record<string, unknown>, msg: string) => void = () => {},
  ) {
    this.pool = pool;
    this.log = log;
  }

  /** Runs every migration file in ascending filename order; fully idempotent. */
  async migrate(files: readonly string[]): Promise<void> {
    for (const file of files) {
      await this.pool.query(readFileSync(file, "utf8"));
    }
  }

  async getCursor(): Promise<Cursor | null> {
    const { rows } = await this.pool.query<{
      slot: string;
      signature: string;
      event_index: number;
    }>("SELECT slot, signature, event_index FROM cursor WHERE id = 1");
    const row = rows[0];
    return row
      ? {
          slot: BigInt(row.slot),
          signature: row.signature,
          eventIndex: row.event_index,
        }
      : null;
  }

  /**
   * Persists a batch and its cursor in ONE transaction. Rows already present
   * (primary key) are skipped, so a replay after a crash is a no-op, and a batch
   * whose first event is older than the stored cursor is rejected instead of
   * silently rewinding the money math.
   */
  async applyBatch(events: readonly EventRow[]): Promise<number> {
    if (events.length === 0) return 0;
    // Slot ascending only: the sort is stable, so a batch's own within-slot
    // arrival order survives. catchUp builds that order canonically (reversed
    // getSignaturesForAddress is execution order within a slot); the live
    // subscription delivers one transaction per batch. ponytail: same-slot
    // display order across SEPARATE batches can still invert — the reconciler
    // is the correctness backstop, chain state stays authoritative.
    const sorted = [...events].sort((a, b) =>
      a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0,
    );

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const applied = await this.writeBatch(client, sorted);
      await client.query("COMMIT");
      return applied;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeBatch(
    client: PoolClient,
    sorted: readonly EventRow[],
  ): Promise<number> {
    const stored = await this.lockCursor(client);
    const first = sorted[0];
    const firstCursor = cursor(first);
    if (stored && compareCursor(firstCursor, stored) < 0) {
      throw new Error(
        `out-of-order batch starting at ${cursorKey(firstCursor)} behind cursor ${cursorKey(stored)}`,
      );
    }

    const inserted = await client.query<{
      slot: string;
      signature: string;
      event_index: number;
    }>(
      `INSERT INTO events (slot, signature, event_index, name, pool, payload, block_time)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[], $5::text[], $6::jsonb[], $7::bigint[])
       ON CONFLICT DO NOTHING RETURNING slot, signature, event_index`,
      [
        sorted.map((event) => big(event.slot)),
        sorted.map((event) => event.signature),
        sorted.map((event) => event.eventIndex),
        sorted.map((event) => event.name),
        sorted.map((event) => event.pool),
        sorted.map((event) => stringifyPayload(event.payload)),
        sorted.map((event) =>
          event.blockTime === null ? null : big(BigInt(event.blockTime)),
        ),
      ],
    );

    const fresh = new Set(
      inserted.rows.map(
        (row) => `${row.slot}:${row.signature}:${row.event_index}`,
      ),
    );
    const applied = sorted.filter((event) =>
      fresh.has(`${big(event.slot)}:${event.signature}:${event.eventIndex}`),
    );

    for (const event of applied) await this.project(client, event);

    const lastCursor = cursor(sorted[sorted.length - 1]);
    if (!stored || compareCursor(lastCursor, stored) > 0) {
      await client.query(
        `INSERT INTO cursor (id, slot, signature, event_index) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET slot = EXCLUDED.slot, signature = EXCLUDED.signature,
           event_index = EXCLUDED.event_index, updated_at = now()`,
        [big(lastCursor.slot), lastCursor.signature, lastCursor.eventIndex],
      );
    }
    return applied.length;
  }

  /**
   * Drops all derived state. Only legitimate use: the chain itself was reset
   * (a test validator restarted from genesis), which is the one situation where
   * a stored cursor can be ahead of the finalized tip. Re-indexing from scratch
   * is the correct response — the alternative, silently accepting a rewind,
   * would double-count balances.
   */
  async resetChain(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of [
        "positions",
        "rounds",
        "players",
        "epochs",
        "snapshots",
        "events",
        "pools",
        "reconciliation_runs",
      ]) {
        await client.query(`TRUNCATE ${table}`);
      }
      await client.query("DELETE FROM cursor");
      await client.query("COMMIT");
      this.log({}, "derived state cleared for a chain reset");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockCursor(client: PoolClient): Promise<Cursor | null> {
    const { rows } = await client.query<{
      slot: string;
      signature: string;
      event_index: number;
    }>(
      "SELECT slot, signature, event_index FROM cursor WHERE id = 1 FOR UPDATE",
    );
    const row = rows[0];
    return row
      ? {
          slot: BigInt(row.slot),
          signature: row.signature,
          eventIndex: row.event_index,
        }
      : null;
  }

  /** Per-event projection into pools / epochs / rounds / positions / players. */
  private async project(client: PoolClient, event: EventRow): Promise<void> {
    const p = revive(event.payload) as Record<
      string,
      string | number | boolean
    >;
    const pool = event.pool;
    const amount = () => big(BigInt(String(p.amount)));
    const reward = () => big(BigInt(String(p.reward)));
    const owner = () => String(p.owner);
    // Claim events name the recipient `winner`, not `owner`.
    const winner = () => String(p.winner ?? p.owner);
    const epochId = () => epochIdOf(p);

    switch (event.name) {
      case "PoolCreated":
        await client.query(
          `INSERT INTO pools (address, pool_id, accepted_mint) VALUES ($1, $2, $3)
           ON CONFLICT (address) DO NOTHING`,
          [pool, big(BigInt(String(p.pool_id))), String(p.accepted_mint)],
        );
        return;
      case "ProtocolPauseChanged":
        await client.query(
          "UPDATE pools SET paused = $2, updated_at = now() WHERE address = $1",
          [pool, Boolean(p.paused)],
        );
        return;
      case "EpochCreated":
        await client.query(
          `INSERT INTO epochs (pool, epoch_id, starts_at, entry_cutoff_at, ends_at, prize_snapshot_at, claim_deadline)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (pool, epoch_id) DO NOTHING`,
          [
            pool,
            epochId(),
            num(p.starts_at),
            num(p.entry_cutoff_at),
            num(p.ends_at),
            num(p.prize_snapshot_at),
            num(p.claim_deadline),
          ],
        );
        await client.query(
          `UPDATE pools SET latest_epoch_id = GREATEST(latest_epoch_id, $2), updated_at = now() WHERE address = $1`,
          [pool, epochId()],
        );
        return;
      case "DepositRecorded":
        await this.touchPlayer(client, pool, owner());
        await client.query(
          "UPDATE players SET principal = principal + $3 WHERE pool = $1 AND owner = $2",
          [pool, owner(), amount()],
        );
        await client.query(
          "UPDATE pools SET principal_minted = principal_minted + $2 WHERE address = $1",
          [pool, amount()],
        );
        return;
      case "WithdrawalRecorded":
        await this.touchPlayer(client, pool, owner());
        await client.query(
          "UPDATE players SET principal = principal - $3 WHERE pool = $1 AND owner = $2",
          [pool, owner(), amount()],
        );
        await client.query(
          "UPDATE pools SET principal_withdrawn = principal_withdrawn + $2 WHERE address = $1",
          [pool, amount()],
        );
        return;
      case "EntriesRefreshed":
        await this.touchPlayer(client, pool, owner());
        await client.query(
          `UPDATE players SET entries_spent_since_refresh = 0, entries_rewarded_since_refresh = 0,
             last_refresh_epoch = $3 WHERE pool = $1 AND owner = $2`,
          [pool, owner(), epochId()],
        );
        return;
      case "PositionPurchased": {
        await this.touchPlayer(client, pool, owner());
        const roundId = big(BigInt(String(p.round_id)));
        const tiles = BigInt(String(p.tiles));
        const totalStake = BigInt(String(p.total_stake));
        const perTile = totalStake / countTiles(tiles);
        const round = String(p.round);

        await client.query(
          `UPDATE players SET entries_spent_since_refresh = entries_spent_since_refresh + $3
           WHERE pool = $1 AND owner = $2`,
          [pool, owner(), big(totalStake)],
        );
        await client.query(
          `INSERT INTO positions (pool, round_id, epoch_id, owner, round, tiles, stake_per_tile, total_stake)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (pool, epoch_id, round_id, owner) DO UPDATE SET tiles = EXCLUDED.tiles,
             stake_per_tile = EXCLUDED.stake_per_tile, total_stake = EXCLUDED.total_stake`,
          [
            pool,
            roundId,
            epochId(),
            owner(),
            round,
            big(tiles),
            big(perTile),
            big(totalStake),
          ],
        );
        await client.query(
          `INSERT INTO rounds (pool, epoch_id, round_id, address, starts_at, ends_at, total_stake)
           VALUES ($1,$2,$3,$4,0,0,$5)
           ON CONFLICT (pool, epoch_id, round_id)
             DO UPDATE SET total_stake = rounds.total_stake + EXCLUDED.total_stake`,
          [pool, epochId(), roundId, round, big(totalStake)],
        );
        return;
      }
      case "RoundRewardClaimed": {
        await this.touchPlayer(client, pool, owner());
        const round = String(p.round);
        await client.query(
          `UPDATE players SET entries_rewarded_since_refresh = entries_rewarded_since_refresh + $3
           WHERE pool = $1 AND owner = $2`,
          [pool, owner(), reward()],
        );
        await client.query(
          "UPDATE positions SET reward_claimed = true WHERE pool = $1 AND owner = $2 AND round = $3",
          [pool, owner(), round],
        );
        return;
      }
      case "RoundRandomnessRequested":
        await client.query(
          `INSERT INTO rounds (pool, epoch_id, round_id, address, starts_at, ends_at) VALUES ($1,$2,$3,$4,0,0)
           ON CONFLICT (pool, epoch_id, round_id) DO NOTHING`,
          [pool, epochId(), big(BigInt(String(p.round_id))), String(p.round)],
        );
        return;
      case "RoundSettled":
        await client.query(
          "UPDATE rounds SET status = 2, winning_tile = $4 WHERE pool = $1 AND epoch_id = $2 AND round_id = $3",
          [
            pool,
            epochId(),
            big(BigInt(String(p.round_id))),
            Number(p.winning_tile),
          ],
        );
        return;
      case "PrizeFunded":
        await client.query(
          "UPDATE pools SET prize_funded = prize_funded + $2 WHERE address = $1",
          [pool, amount()],
        );
        return;
      case "JackpotFunded":
        await client.query(
          "UPDATE pools SET jackpot_funded = jackpot_funded + $2 WHERE address = $1",
          [pool, amount()],
        );
        return;
      case "PrizeSnapshotCommitted":
        await client.query(
          `UPDATE epochs SET status = 1, prize_snapshot_root = $3, total_entry_weight = $4, prize_amount = $5
           WHERE pool = $1 AND epoch_id = $2`,
          [
            pool,
            epochId(),
            Buffer.from(p.root as unknown as number[]),
            big(BigInt(String(p.total_entry_weight))),
            big(BigInt(String(p.prize_amount))),
          ],
        );
        return;
      case "JackpotCommitted":
        await client.query(
          "UPDATE epochs SET jackpot_status = 1, jackpot_amount = $3 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId(), big(BigInt(String(p.jackpot_amount)))],
        );
        return;
      case "PrizeRandomnessRequested":
        await client.query(
          "UPDATE epochs SET status = 2 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId()],
        );
        return;
      case "PrizeDrawn":
        await client.query(
          "UPDATE epochs SET status = 3, prize_target = $3 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId(), big(BigInt(String(p.target)))],
        );
        return;
      case "PrizeClaimed":
        await client.query(
          "UPDATE epochs SET status = 4, prize_claimed_by = $3 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId(), winner()],
        );
        return;
      case "PrizeExpired":
        await client.query(
          "UPDATE epochs SET status = 5 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId()],
        );
        return;
      case "JackpotRandomnessRequested":
        // No dedicated jackpot status for a pending request; commit already set 1.
        return;
      case "JackpotDrawn":
        await client.query(
          "UPDATE epochs SET jackpot_status = 2, jackpot_target = $3 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId(), big(BigInt(String(p.target)))],
        );
        return;
      case "JackpotClaimed":
        await client.query(
          "UPDATE epochs SET jackpot_status = 3, jackpot_claimed_by = $3 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId(), winner()],
        );
        return;
      case "JackpotExpired":
        await client.query(
          "UPDATE epochs SET jackpot_status = 4 WHERE pool = $1 AND epoch_id = $2",
          [pool, epochId()],
        );
        return;
      default:
        throw new Error(`no projection for ${event.name}`);
    }
  }

  private async touchPlayer(
    client: PoolClient,
    pool: string,
    owner: string,
  ): Promise<void> {
    await client.query(
      "INSERT INTO players (pool, owner) VALUES ($1, $2) ON CONFLICT (pool, owner) DO NOTHING",
      [pool, owner],
    );
  }
}

const cursor = (event: EventRow): Cursor => ({
  slot: event.slot,
  signature: event.signature,
  eventIndex: event.eventIndex,
});

const num = (value: unknown): string => big(BigInt(String(value)));

const countTiles = (mask: bigint): bigint => {
  let count = 0n;
  for (let tile = 0n; tile < 36n; tile += 1n) count += (mask >> tile) & 1n;
  return count;
};
