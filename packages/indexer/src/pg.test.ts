import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { Pool } from "pg";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { Reconciler } from "./reconcile.ts";
import { SnapshotService } from "./snapshot.ts";
import type { EventName, EventRow } from "./events.ts";

/**
 * Needs a real Postgres. The compose `db` service provides one:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/hexvault
 * Without it the suite is skipped so `pnpm test` stays hermetic.
 */
const DB = process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

// Route/column values must be real base58, so derive the fixtures from hashes.
const key58 = (seed: string): string =>
  new PublicKey(createHash("sha256").update(seed).digest()).toBase58();

const POOL_A = key58("pool-a");
const OWNER_1 = key58("owner-1");
const OWNER_2 = key58("owner-2");
const ROUND_1 = key58("round-1");
const ROUND_2 = key58("round-2");
const MINT = key58("accepted-mint");

// A second pool, scoped to the epoch-keying test below so its events don't
// leak into the snapshot/reconciliation tests, which replay every event
// stored for POOL_A.
const POOL_B = key58("pool-b");
const OWNER_3 = key58("owner-3");
// Round PDAs are seeded by [pool, epoch_id, round_id], so round id 1 of
// epoch 2 is a distinct on-chain address from round id 1 of epoch 1.
const ROUND_1_EPOCH_2 = key58("round-1-epoch-2");

const migrationDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

let slot = 100;
const row = (
  name: EventName,
  pool: string,
  payload: Record<string, unknown>,
  signature = `SIG${++slot}`,
): EventRow => ({
  slot: BigInt(slot),
  signature,
  eventIndex: 0,
  name,
  pool,
  payload,
  blockTime: 1_700_000_000,
});

d("postgres projection", () => {
  let pool: Pool;
  let store: Store;
  let snapshots: SnapshotService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB });
    store = new Store(pool, () => {});
    snapshots = new SnapshotService(pool, () => {});
    const files = readdirSync(migrationDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => resolve(migrationDir, file));
    await store.migrate(files);
    await pool.query(
      "TRUNCATE events, pools, epochs, rounds, positions, players, snapshots, cursor, reconciliation_runs",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("applies a batch atomically and advances the cursor", async () => {
    const applied = await store.applyBatch([
      row("PoolCreated", POOL_A, { pool_id: 1n, accepted_mint: MINT }),
      row("EpochCreated", POOL_A, {
        epoch_id: 1n,
        starts_at: 0n,
        entry_cutoff_at: 10n,
        ends_at: 20n,
        prize_snapshot_at: 25n,
        claim_deadline: 30n,
      }),
      row("DepositRecorded", POOL_A, {
        owner: OWNER_1,
        epoch_id: 1n,
        amount: 1_000n,
      }),
      row("DepositRecorded", POOL_A, {
        owner: OWNER_2,
        epoch_id: 1n,
        amount: 500n,
      }),
      row("PositionPurchased", POOL_A, {
        owner: OWNER_1,
        round: ROUND_1,
        epoch_id: 1n,
        round_id: 1n,
        tiles: 0b11n,
        total_stake: 600n,
      }),
    ]);
    expect(applied).toBe(5);

    const cursor = await store.getCursor();
    expect(cursor).not.toBeNull();
    expect(Number(cursor!.slot)).toBeGreaterThan(100);

    const { rows: players } = await pool.query<{
      owner: string;
      principal: string;
      spent: string;
    }>(
      "SELECT owner, principal, entries_spent_since_refresh AS spent FROM players WHERE pool = $1 ORDER BY owner",
      [POOL_A],
    );
    expect(Object.fromEntries(players.map((row) => [row.owner, row]))).toEqual({
      [OWNER_1]: { owner: OWNER_1, principal: "1000", spent: "600" },
      [OWNER_2]: { owner: OWNER_2, principal: "500", spent: "0" },
    });

    const { rows: rounds } = await pool.query<{
      total_stake: string;
      status: string;
    }>("SELECT total_stake, status FROM rounds WHERE pool = $1", [POOL_A]);
    expect(rounds).toEqual([{ total_stake: "600", status: 0 }]);
  });

  it("marks only the claimed owner's position in the claimed round", async () => {
    await store.applyBatch([
      row("PositionPurchased", POOL_A, {
        owner: OWNER_2,
        round: ROUND_1,
        epoch_id: 1n,
        round_id: 1n,
        tiles: 1n,
        total_stake: 10n,
      }),
      row("PositionPurchased", POOL_A, {
        owner: OWNER_2,
        round: ROUND_2,
        epoch_id: 1n,
        round_id: 2n,
        tiles: 1n,
        total_stake: 20n,
      }),
      row("RoundRewardClaimed", POOL_A, {
        owner: OWNER_2,
        round: ROUND_1,
        reward: 5n,
      }),
    ]);

    const { rows } = await pool.query<{ round: string; claimed: boolean }>(
      "SELECT round, reward_claimed AS claimed FROM positions WHERE pool = $1 AND owner = $2 ORDER BY round_id",
      [POOL_A, OWNER_2],
    );
    expect(rows).toEqual([
      { round: ROUND_1, claimed: true },
      { round: ROUND_2, claimed: false },
    ]);
  });

  it("keeps positions separate across epochs even with the same round id", async () => {
    await store.applyBatch([
      row("PositionPurchased", POOL_B, {
        owner: OWNER_3,
        round: ROUND_1,
        epoch_id: 1n,
        round_id: 1n,
        tiles: 0b1n,
        total_stake: 100n,
      }),
      row("PositionPurchased", POOL_B, {
        owner: OWNER_3,
        round: ROUND_1_EPOCH_2,
        epoch_id: 2n,
        round_id: 1n,
        tiles: 0b11n,
        total_stake: 300n,
      }),
    ]);

    const { rows } = await pool.query<{
      epoch_id: string;
      round_id: string;
      tiles: string;
      total_stake: string;
    }>(
      "SELECT epoch_id, round_id, tiles, total_stake FROM positions WHERE pool = $1 AND owner = $2 ORDER BY epoch_id",
      [POOL_B, OWNER_3],
    );
    expect(rows).toEqual([
      { epoch_id: "1", round_id: "1", tiles: "1", total_stake: "100" },
      { epoch_id: "2", round_id: "1", tiles: "3", total_stake: "300" },
    ]);
  });

  it("replays a duplicate batch without double-counting", async () => {
    const cursorBefore = await store.getCursor();
    const batch = [
      row("DepositRecorded", POOL_A, {
        owner: OWNER_1,
        epoch_id: 1n,
        amount: 1n,
      }),
    ];
    await store.applyBatch(batch);
    const afterFirst = await store.getCursor();
    await store.applyBatch(batch);
    expect(await store.getCursor()).toEqual(afterFirst);
    expect(cursorBefore).not.toBeNull();

    const { rows } = await pool.query<{ principal: string }>(
      "SELECT principal FROM players WHERE pool = $1 AND owner = $2",
      [POOL_A, OWNER_1],
    );
    expect(rows[0]!.principal).toBe("1001");
  });

  it("rejects a batch that would rewind the cursor", async () => {
    const stale: EventRow = {
      slot: 1n,
      signature: "VERY_OLD",
      eventIndex: 0,
      name: "DepositRecorded",
      pool: POOL_A,
      payload: { owner: OWNER_1, epoch_id: 1n, amount: 7n },
      blockTime: null,
    };
    await expect(store.applyBatch([stale])).rejects.toThrow(/out-of-order/);
    const { rows } = await pool.query<{ principal: string }>(
      "SELECT principal FROM players WHERE pool = $1 AND owner = $2",
      [POOL_A, OWNER_1],
    );
    expect(rows[0]!.principal).toBe("1001");
  });

  it("maintains epoch, jackpot and prize state from events", async () => {
    const root = Buffer.alloc(32, 9);
    await store.applyBatch([
      row("PrizeFunded", POOL_A, { funder: OWNER_1, amount: 400n }),
      row("JackpotFunded", POOL_A, { funder: OWNER_1, amount: 90n }),
      row("PrizeSnapshotCommitted", POOL_A, {
        epoch_id: 1n,
        prize_amount: 350n,
        total_entry_weight: 900n,
        root: [...root],
      }),
      row("JackpotCommitted", POOL_A, { epoch_id: 1n, jackpot_amount: 80n }),
      row("PrizeDrawn", POOL_A, { epoch_id: 1n, target: 250n }),
      row("JackpotDrawn", POOL_A, { epoch_id: 1n, target: 60n }),
      row("PrizeClaimed", POOL_A, {
        epoch_id: 1n,
        winner: OWNER_2,
        amount: 350n,
      }),
      row("JackpotClaimed", POOL_A, {
        epoch_id: 1n,
        winner: OWNER_2,
        amount: 80n,
      }),
    ]);

    const { rows } = await pool.query<Record<string, string>>(
      "SELECT status, jackpot_status, prize_target, jackpot_target, prize_claimed_by, jackpot_claimed_by, prize_amount, jackpot_amount FROM epochs WHERE pool = $1 AND epoch_id = 1",
      [POOL_A],
    );
    expect(rows[0]).toEqual({
      status: 4,
      jackpot_status: 3,
      prize_target: "250",
      jackpot_target: "60",
      prize_claimed_by: OWNER_2,
      jackpot_claimed_by: OWNER_2,
      prize_amount: "350",
      jackpot_amount: "80",
    });
  });

  it("refresh resets both accumulators", async () => {
    await store.applyBatch([
      row("RoundRewardClaimed", POOL_A, {
        owner: OWNER_2,
        round: ROUND_1,
        reward: 25n,
      }),
      row("EntriesRefreshed", POOL_A, {
        owner: OWNER_2,
        epoch_id: 2n,
        principal_entries: 525n,
      }),
    ]);
    const { rows } = await pool.query<{
      spent: string;
      rewarded: string;
      last: string;
      principal: string;
    }>(
      "SELECT entries_spent_since_refresh AS spent, entries_rewarded_since_refresh AS rewarded, last_refresh_epoch AS last, principal FROM players WHERE pool = $1 AND owner = $2",
      [POOL_A, OWNER_2],
    );
    expect(rows[0]).toEqual({
      spent: "0",
      rewarded: "0",
      last: "2",
      principal: "500",
    });
  });

  it("builds a canonical snapshot whose total matches the indexed entries", async () => {
    const snapshot = await snapshots.build(POOL_A, "1");
    // OWNER_1: 1001 principal - 600 spent; OWNER_2: 500 principal.
    expect(snapshot.totalWeight).toBe("901");
    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.tree.levels.at(-1)).toHaveLength(1);

    await snapshots.save(snapshot);
    const stored = await snapshots.latest(POOL_A, "1");
    expect(stored?.root).toBe(snapshot.root);
    expect(stored?.playerCount).toBe(2);
  });

  it("compares the canonical root against a committed root", async () => {
    const snapshot = await snapshots.build(POOL_A, "1");
    const matching = await snapshots.compareWithCommitted(
      POOL_A,
      "1",
      snapshot.tree.root,
    );
    expect(matching.ok).toBe(true);

    const wrong = Buffer.alloc(32, 1);
    const mismatched = await snapshots.compareWithCommitted(POOL_A, "1", wrong);
    expect(mismatched.ok).toBe(false);
  });

  it("records reconciliation runs", async () => {
    // Commit the root the replay actually produces so the canonical-root check
    // has something to agree with (disagreement is covered by the test above).
    const canonical = await snapshots.build(POOL_A, "1");
    await pool.query(
      "UPDATE epochs SET prize_snapshot_root = $3 WHERE pool = $1 AND epoch_id = $2",
      [POOL_A, "1", canonical.tree.root],
    );

    const reconciler = new Reconciler({
      connection: {
        getTokenSupply: async () => ({ value: { amount: "1500" } }),
        getTokenAccountBalance: async () => ({ value: { amount: "1500" } }),
      } as never,
      pg: pool,
      snapshots,
      log: () => {},
    });
    const outcomes = await reconciler.runAll();
    // canonical_root must hold for the snapshot built two tests above.
    const rootCheck = outcomes.find(
      (outcome) => outcome.check === "canonical_root",
    );
    expect(rootCheck?.ok).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reconciliation_runs",
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(outcomes.length);
  });

  it("keeps the cursor row locked to id = 1", async () => {
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM cursor");
    expect(rows).toEqual([{ id: 1 }]);
  });
});
