import { describe, expect, it } from "vitest";
import type { Cursor, EventEnvelope, EventField, EventName } from "./events.ts";
import {
  entriesBalance,
  HexVaultProjection,
  withdrawable,
} from "./projection.ts";

const POOL = "Pool1111111111111111111111111111111111111111";
const OWNER = "Owner111111111111111111111111111111111111111";
const OTHER = "Other111111111111111111111111111111111111111";

let sequence = 0;
const cursor = (slot: number, eventIndex = 0): Cursor => ({
  slot: BigInt(slot),
  signature: `SIG${slot}_${sequence++}`,
  eventIndex,
});

const event = (
  name: EventName,
  data: Record<string, EventField>,
  slot: number,
  eventIndex = 0,
): EventEnvelope => ({
  programId: "prog",
  name,
  pool: POOL,
  data,
  cursor: cursor(slot, eventIndex),
  slot: BigInt(slot),
});

const deposit = (owner: string, amount: bigint, slot: number) =>
  event("DepositRecorded", { owner, epoch_id: 1n, amount }, slot);

describe("projection", () => {
  it("tracks principal and computes the entries balance", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 1_000n, 1));
    projection.apply(
      event(
        "PositionPurchased",
        {
          owner: OWNER,
          round: "R",
          epoch_id: 1n,
          round_id: 1n,
          tiles: 1n,
          total_stake: 300n,
        },
        2,
      ),
    );

    const player = projection.player(POOL, OWNER);
    expect(player.principal).toBe(1_000n);
    expect(player.entriesSpentSinceRefresh).toBe(300n);
    expect(entriesBalance(player)).toBe(700n);
    expect(withdrawable(player)).toBe(700n);
  });

  it("adds round rewards to the entries balance without touching principal", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 1_000n, 1));
    projection.apply(
      event(
        "PositionPurchased",
        {
          owner: OWNER,
          round: "R",
          epoch_id: 1n,
          round_id: 1n,
          tiles: 1n,
          total_stake: 1_000n,
        },
        2,
      ),
    );
    projection.apply(
      event(
        "RoundRewardClaimed",
        { owner: OWNER, round: "R", reward: 250n },
        3,
      ),
    );

    const player = projection.player(POOL, OWNER);
    expect(player.principal).toBe(1_000n);
    expect(entriesBalance(player)).toBe(250n);
    // Withdrawable is capped by principal: ET alone is not withdrawable.
    expect(withdrawable(player)).toBe(250n);
  });

  it("resets both accumulators on EntriesRefreshed", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 1_000n, 1));
    projection.apply(
      event(
        "PositionPurchased",
        {
          owner: OWNER,
          round: "R",
          epoch_id: 1n,
          round_id: 1n,
          tiles: 1n,
          total_stake: 400n,
        },
        2,
      ),
    );
    projection.apply(
      event("RoundRewardClaimed", { owner: OWNER, round: "R", reward: 50n }, 3),
    );
    projection.apply(
      event(
        "EntriesRefreshed",
        { owner: OWNER, epoch_id: 2n, principal_entries: 650n },
        4,
      ),
    );

    const player = projection.player(POOL, OWNER);
    expect(player.entriesSpentSinceRefresh).toBe(0n);
    expect(player.entriesRewardedSinceRefresh).toBe(0n);
    expect(player.lastRefreshEpoch).toBe(2n);
    expect(entriesBalance(player)).toBe(1_000n);
    expect(withdrawable(player)).toBe(1_000n);
  });

  it("subtracts withdrawals from principal", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 1_000n, 1));
    projection.apply(
      event("WithdrawalRecorded", { owner: OWNER, amount: 400n }, 2),
    );
    expect(projection.player(POOL, OWNER).principal).toBe(600n);
    expect(entriesBalance(projection.player(POOL, OWNER))).toBe(600n);
  });

  it("keeps players isolated per pool", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 100n, 1));
    projection.players.get(`${POOL}:${OTHER}`) ??
      projection.player(POOL, OTHER);
    expect(projection.player(POOL, OTHER).principal).toBe(0n);
    expect(
      [...projection.players.values()].filter((player) => player.pool === POOL),
    ).toHaveLength(2);
  });

  it("is idempotent for a replayed cursor", () => {
    const projection = new HexVaultProjection();
    const first = deposit(OWNER, 500n, 1);
    expect(projection.apply(first)).toBe(true);
    expect(projection.apply({ ...first })).toBe(false);
    expect(projection.player(POOL, OWNER).principal).toBe(500n);
  });

  it("rejects a rewind instead of double-counting", () => {
    const projection = new HexVaultProjection();
    projection.apply(deposit(OWNER, 500n, 10));
    expect(() => projection.apply(deposit(OWNER, 500n, 9))).toThrow(
      /out-of-order/,
    );
    expect(projection.player(POOL, OWNER).principal).toBe(500n);
  });

  it("accepts ascending cursors inside one slot", () => {
    const projection = new HexVaultProjection();
    projection.apply(
      event(
        "DepositRecorded",
        { owner: OWNER, epoch_id: 1n, amount: 1n },
        7,
        0,
      ),
    );
    projection.apply(
      event(
        "DepositRecorded",
        { owner: OTHER, epoch_id: 1n, amount: 2n },
        7,
        1,
      ),
    );
    expect(projection.player(POOL, OTHER).principal).toBe(2n);
  });
});
