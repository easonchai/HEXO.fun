import type { Pool as PgPool } from "pg";

/**
 * Read-side SQL. Bigint columns come back as strings from node-postgres, so
 * every amount is re-materialized as a bigint and serialized as a string —
 * the same shape the indexer stores.
 */

export interface Row {
  [key: string]: unknown;
}

export interface Client {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export const fromPg = (pool: PgPool): Client => pool;

const big = (value: unknown): string => String(value ?? "0");
const optBig = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const num = (value: unknown): number => Number(value ?? 0);

export const listPools = async (client: Client) => {
  const { rows } = await client.query("SELECT * FROM pools ORDER BY pool_id");
  return rows.map((row) => ({
    address: row.address,
    poolId: big(row.pool_id),
    acceptedMint: row.accepted_mint,
    acceptedTokenProgram: row.accepted_token_program,
    acceptedDecimals: num(row.accepted_decimals),
    principalMint: row.principal_mint,
    entryMint: row.entry_mint,
    principalVault: row.principal_vault,
    prizeVault: row.prize_vault,
    jackpotVault: row.jackpot_vault,
    limits: {
      minDeposit: big(row.min_deposit),
      maxStakePerTile: big(row.max_stake_per_tile),
      maxRoundBonusEntries: big(row.max_round_bonus_entries),
      minEpochSeconds: big(row.min_epoch_seconds),
      maxEpochSeconds: big(row.max_epoch_seconds),
      roundCloseBufferSeconds: big(row.round_close_buffer_seconds),
    },
    latestEpochId: big(row.latest_epoch_id),
    paused: Boolean(row.paused),
    totals: {
      principalMinted: big(row.principal_minted),
      principalWithdrawn: big(row.principal_withdrawn),
      prizeFunded: big(row.prize_funded),
      jackpotFunded: big(row.jackpot_funded),
    },
  }));
};

export const getPool = async (client: Client, address: string) => {
  const pools = await listPools(client);
  return pools.find((pool) => pool.address === address) ?? null;
};

export const listEpochs = async (client: Client, address: string) => {
  const { rows } = await client.query(
    `SELECT * FROM epochs WHERE pool = $1 ORDER BY epoch_id DESC`,
    [address],
  );
  return rows.map((row) => ({
    epochId: big(row.epoch_id),
    timing: {
      startsAt: big(row.starts_at),
      entryCutoffAt: big(row.entry_cutoff_at),
      endsAt: big(row.ends_at),
      prizeSnapshotAt: big(row.prize_snapshot_at),
      claimDeadline: big(row.claim_deadline),
    },
    status: num(row.status),
    prize: {
      root: row.prize_snapshot_root
        ? Buffer.from(row.prize_snapshot_root as Buffer).toString("hex")
        : null,
      totalEntryWeight: big(row.total_entry_weight),
      amount: big(row.prize_amount),
      target: optBig(row.prize_target),
      claimedBy: row.prize_claimed_by ?? null,
    },
    jackpot: {
      status: num(row.jackpot_status),
      amount: big(row.jackpot_amount),
      target: optBig(row.jackpot_target),
      claimedBy: row.jackpot_claimed_by ?? null,
    },
  }));
};

export const listRounds = async (
  client: Client,
  address: string,
  epochId?: string,
) => {
  const { rows } = await client.query(
    `SELECT * FROM rounds WHERE pool = $1 AND ($2::bigint IS NULL OR epoch_id = $2::bigint)
     ORDER BY epoch_id DESC, round_id DESC`,
    [address, epochId ?? null],
  );
  return rows.map((row) => ({
    address: row.address,
    epochId: big(row.epoch_id),
    roundId: big(row.round_id),
    startsAt: big(row.starts_at),
    endsAt: big(row.ends_at),
    status: num(row.status),
    winningTile: row.winning_tile === null ? null : num(row.winning_tile),
    bonusEntries: big(row.bonus_entries),
    totalStake: big(row.total_stake),
  }));
};

export const getPlayer = async (
  client: Client,
  pool: string,
  owner: string,
) => {
  const { rows } = await client.query(
    "SELECT * FROM players WHERE pool = $1 AND owner = $2",
    [pool, owner],
  );
  const row = rows[0];
  if (!row) return null;
  const principal = BigInt(big(row.principal));
  const spent = BigInt(big(row.entries_spent_since_refresh));
  const rewarded = BigInt(big(row.entries_rewarded_since_refresh));
  const entries = principal - spent + rewarded;
  return {
    pool,
    owner,
    principal: principal.toString(),
    entriesSpentSinceRefresh: spent.toString(),
    entriesRewardedSinceRefresh: rewarded.toString(),
    lastRefreshEpoch: big(row.last_refresh_epoch),
    entriesBalance: entries.toString(),
    // ET is not withdrawable on its own: principal is the real cap.
    withdrawable: (principal < entries ? principal : entries).toString(),
  };
};

export const listPrizes = async (client: Client, address: string) => {
  const { rows } = await client.query(
    `SELECT epoch_id, prize_amount, total_entry_weight, prize_target, status, prize_claimed_by, prize_snapshot_at
     FROM epochs WHERE pool = $1 AND status > 0 ORDER BY epoch_id DESC`,
    [address],
  );
  return rows.map((row) => ({
    epochId: big(row.epoch_id),
    amount: big(row.prize_amount),
    totalEntryWeight: big(row.total_entry_weight),
    target: optBig(row.prize_target),
    status: num(row.status),
    claimedBy: row.prize_claimed_by ?? null,
    snapshotAt: big(row.prize_snapshot_at),
  }));
};

export const listJackpots = async (client: Client, address: string) => {
  const { rows } = await client.query(
    `SELECT epoch_id, jackpot_amount, jackpot_target, jackpot_status, jackpot_claimed_by
     FROM epochs WHERE pool = $1 AND jackpot_status > 0 ORDER BY epoch_id DESC`,
    [address],
  );
  return rows.map((row) => ({
    epochId: big(row.epoch_id),
    amount: big(row.jackpot_amount),
    target: optBig(row.jackpot_target),
    status: num(row.jackpot_status),
    claimedBy: row.jackpot_claimed_by ?? null,
  }));
};

export const getSnapshot = async (
  client: Client,
  pool: string,
  epochId: string,
) => {
  const { rows } = await client.query(
    `SELECT root, total_weight, player_count, leaves, cutoff_slot FROM snapshots
     WHERE pool = $1 AND epoch_id = $2 ORDER BY cutoff_slot DESC LIMIT 1`,
    [pool, epochId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    pool,
    epochId,
    root: Buffer.from(row.root as Buffer).toString("hex"),
    totalWeight: big(row.total_weight),
    playerCount: num(row.player_count),
    cutoffSlot: big(row.cutoff_slot),
    players: row.leaves as { owner: string; weight: string }[],
  };
};

/** Recent raw events, newest first — the UI activity feed's source. */
export const listEvents = async (
  client: Client,
  limit: number,
  pool?: string,
) => {
  const { rows } = await client.query(
    `SELECT slot, signature, event_index, name, pool, payload, block_time
     FROM events
     WHERE ($1::text IS NULL OR pool = $1)
     ORDER BY slot DESC, signature DESC, event_index DESC
     LIMIT $2`,
    [pool ?? null, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    slot: big(row.slot),
    signature: row.signature,
    eventIndex: num(row.event_index),
    name: row.name,
    pool: row.pool,
    payload: row.payload,
    blockTime: optBig(row.block_time),
  }));
};

export const listReconciliations = async (client: Client, limit: number) => {
  const { rows } = await client.query(
    `SELECT checked_at, pool, check_name, ok, detail FROM reconciliation_runs
     ORDER BY checked_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((row) => ({
    checkedAt: (row.checked_at as Date).toISOString(),
    pool: row.pool,
    check: row.check_name,
    ok: Boolean(row.ok),
    detail: row.detail,
  }));
};

export const healthCheck = async (client: Client) => {
  const { rows } = await client.query(
    `SELECT (SELECT slot::text FROM cursor WHERE id = 1) AS cursor,
            (SELECT updated_at FROM cursor WHERE id = 1) AS updated_at,
            (SELECT COUNT(*)::text FROM events) AS events`,
  );
  const row = rows[0]!;
  const updatedAt = row.updated_at as Date | null;
  const ageSeconds = updatedAt
    ? Math.round((Date.now() - updatedAt.getTime()) / 1000)
    : null;
  return {
    cursor: row.cursor,
    cursorAgeSeconds: ageSeconds,
    events: Number(row.events),
  };
};
