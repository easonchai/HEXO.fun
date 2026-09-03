import { PublicKey } from "@solana/web3.js";
import type { Pool as PgPool } from "pg";
import type { EventName, EventRow } from "./events.ts";
import { buildPrizeTree, type PrizeLeaf, type PrizeTree } from "./merkle.ts";
import { entriesBalance, HexVaultProjection } from "./projection.ts";
import { revive } from "./store.ts";

export interface SnapshotLeaf {
  readonly owner: string;
  readonly weight: string;
}

export interface SnapshotResult {
  readonly pool: string;
  readonly epochId: string;
  readonly cutoffSlot: string;
  readonly root: string;
  readonly totalWeight: string;
  readonly players: SnapshotLeaf[];
  readonly tree: PrizeTree;
}

export interface StoredSnapshot {
  readonly root: string;
  readonly totalWeight: string;
  readonly playerCount: number;
  readonly leaves: SnapshotLeaf[];
  readonly cutoffSlot: string;
}

export class SnapshotService {
  private readonly pool: PgPool;
  private readonly log: (obj: Record<string, unknown>, msg: string) => void;

  constructor(
    pool: PgPool,
    log: (obj: Record<string, unknown>, msg: string) => void = () => {},
  ) {
    this.pool = pool;
    this.log = log;
  }

  /**
   * Builds the canonical Merkle-sum tree for a pool epoch by replaying the
   * stored event log through the projection up to `cutoffSlot`. Replaying the
   * durable log (rather than reading the mutable projection tables) is what
   * makes a historical root reproducible.
   */
  async build(
    pool: string,
    epochId: string,
    cutoffSlot?: bigint,
  ): Promise<SnapshotResult> {
    const events = await this.loadEvents(pool, cutoffSlot);
    const projection = new HexVaultProjection();
    for (const event of events) {
      projection.apply({
        programId: "",
        name: event.name as EventName,
        pool: event.pool,
        data: revive(event.payload) as never,
        cursor: {
          slot: event.slot,
          signature: event.signature,
          eventIndex: event.eventIndex,
        },
        slot: event.slot,
      });
    }

    const leaves: (PrizeLeaf & { address: string })[] = [
      ...projection.players.values(),
    ]
      .filter((player) => player.pool === pool)
      .map((player) => ({
        owner: new PublicKey(player.owner).toBytes(),
        address: player.owner,
        weight: entriesBalance(player),
      }));

    const tree = buildPrizeTree(leaves);
    const resolvedCutoff = cutoffSlot ?? events.at(-1)?.slot ?? 0n;

    return {
      pool,
      epochId: epochId,
      cutoffSlot: resolvedCutoff.toString(),
      root: tree.root.toString("hex"),
      totalWeight: tree.total.toString(),
      players: leaves.map((leaf) => ({
        owner: leaf.address,
        weight: leaf.weight.toString(),
      })),
      tree,
    };
  }

  /** Persists (or refreshes) the canonical snapshot for an epoch. */
  async save(snapshot: SnapshotResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (pool, epoch_id, cutoff_slot, root, total_weight, player_count, leaves)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pool, epoch_id, cutoff_slot) DO UPDATE SET root = EXCLUDED.root,
         total_weight = EXCLUDED.total_weight, player_count = EXCLUDED.player_count,
         leaves = EXCLUDED.leaves, created_at = now()`,
      [
        snapshot.pool,
        snapshot.epochId,
        snapshot.cutoffSlot,
        Buffer.from(snapshot.root, "hex"),
        snapshot.totalWeight,
        snapshot.players.length,
        JSON.stringify(snapshot.players),
      ],
    );
  }

  async latest(pool: string, epochId: string): Promise<StoredSnapshot | null> {
    const { rows } = await this.pool.query<{
      root: Buffer;
      total_weight: string;
      player_count: string;
      leaves: SnapshotLeaf[];
      cutoff_slot: string;
    }>(
      `SELECT root, total_weight, player_count, leaves, cutoff_slot FROM snapshots
       WHERE pool = $1 AND epoch_id = $2 ORDER BY cutoff_slot DESC LIMIT 1`,
      [pool, epochId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      root: Buffer.from(row.root).toString("hex"),
      totalWeight: row.total_weight,
      playerCount: Number(row.player_count),
      leaves: row.leaves,
      cutoffSlot: row.cutoff_slot,
    };
  }

  /**
   * Compares the canonical root against the root the program committed. A
   * mismatch means the off-chain tree producer and the indexer disagree; this
   * is a runtime check that needs real indexed state, not a unit test fixture.
   */
  async compareWithCommitted(
    pool: string,
    epochId: string,
    committedRoot: Buffer,
  ): Promise<{
    ok: boolean;
    canonical: string;
    committed: string;
    cutoffSlot: string;
  }> {
    // The committed root reflects entry balances at the moment the snapshot
    // authority committed — replay events only up to that commit's slot, or
    // any later ET event (reward claim, next-epoch deposit) reads as a false
    // mismatch.
    const commitSlot = await this.commitSlot(pool, epochId);
    const snapshot = await this.build(pool, epochId, commitSlot ?? undefined);
    const canonical = Buffer.from(snapshot.root, "hex");
    return {
      ok: canonical.equals(committedRoot),
      canonical: snapshot.root,
      committed: committedRoot.toString("hex"),
      cutoffSlot: snapshot.cutoffSlot,
    };
  }

  private async commitSlot(
    pool: string,
    epochId: string,
  ): Promise<bigint | null> {
    const { rows } = await this.pool.query<{ slot: string }>(
      `SELECT slot FROM events
       WHERE pool = $1 AND name = 'PrizeSnapshotCommitted'
         AND (payload->>'epoch_id') = $2
       ORDER BY slot ASC, signature ASC, event_index ASC LIMIT 1`,
      [pool, epochId],
    );
    const row = rows[0];
    return row ? BigInt(row.slot) : null;
  }

  private async loadEvents(
    pool: string,
    cutoffSlot?: bigint,
  ): Promise<EventRow[]> {
    const { rows } = await this.pool.query<{
      slot: string;
      signature: string;
      event_index: number;
      name: string;
      pool: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT slot, signature, event_index, name, pool, payload FROM events
       WHERE pool = $1 AND ($2::bigint IS NULL OR slot <= $2::bigint)
       ORDER BY slot, signature, event_index`,
      [pool, cutoffSlot === undefined ? null : cutoffSlot.toString()],
    );
    return rows.map((row) => ({
      slot: BigInt(row.slot),
      signature: row.signature,
      eventIndex: row.event_index,
      name: row.name as EventName,
      pool: row.pool,
      payload: row.payload,
      blockTime: null,
    }));
  }
}
