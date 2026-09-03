import {
  asAtomicAmount,
  asPublicKey,
  compareCursor,
  cursorKey,
  type Cursor,
  type EventEnvelope,
} from "./events.ts";

export interface PlayerView {
  readonly pool: string;
  readonly owner: string;
  principal: bigint;
  entriesSpentSinceRefresh: bigint;
  entriesRewardedSinceRefresh: bigint;
  lastRefreshEpoch: bigint;
}

/**
 * Canonical entries accounting.
 *
 *   ET = principal - entriesSpentSinceRefresh + entriesRewardedSinceRefresh
 *
 * A deposit mints principal and ET one-for-one; buying a position burns ET, so
 * `spent` rises; a round reward mints ET, so `rewarded` rises; a refresh burns
 * and remints the whole balance, which zeroes both accumulators.
 */
export const entriesBalance = (player: PlayerView): bigint =>
  player.principal -
  player.entriesSpentSinceRefresh +
  player.entriesRewardedSinceRefresh;

/** Withdrawable = what can actually leave the principal vault: min(principal, ET). */
export const withdrawable = (player: PlayerView): bigint => {
  const et = entriesBalance(player);
  return player.principal < et ? player.principal : et;
};

export class HexVaultProjection {
  readonly players = new Map<string, PlayerView>();
  readonly processed = new Set<string>();
  private checkpoint?: Cursor;

  getCheckpoint(): Cursor | undefined {
    return this.checkpoint;
  }

  player(pool: string, owner: string): PlayerView {
    const key = `${pool}:${owner}`;
    const existing = this.players.get(key);
    if (existing) return existing;
    const created: PlayerView = {
      pool,
      owner,
      principal: 0n,
      entriesSpentSinceRefresh: 0n,
      entriesRewardedSinceRefresh: 0n,
      lastRefreshEpoch: 0n,
    };
    this.players.set(key, created);
    return created;
  }

  /**
   * Applies one event. Returns false for a duplicate cursor (idempotent replay),
   * throws on a rewind — a re-applied event would double-count money. Callers
   * must hand events over in ascending (slot, signature, eventIndex) order;
   * equal slots are fine as long as the tuple increases.
   */
  apply(event: EventEnvelope): boolean {
    const key = cursorKey(event.cursor);
    if (this.processed.has(key)) return false;
    if (this.checkpoint && compareCursor(event.cursor, this.checkpoint) < 0) {
      throw new Error(
        `out-of-order finalized event ${key}; durable checkpoint ${cursorKey(this.checkpoint)}`,
      );
    }
    this.reduce(event);
    this.processed.add(key);
    if (!this.checkpoint || compareCursor(event.cursor, this.checkpoint) > 0) {
      this.checkpoint = event.cursor;
    }
    return true;
  }

  private reduce(event: EventEnvelope): void {
    const data = event.data;
    const pool = event.pool;
    const owner = () => asPublicKey(data.owner, "owner");

    switch (event.name) {
      case "DepositRecorded":
        this.player(pool, owner()).principal += asAtomicAmount(
          data.amount,
          "amount",
        );
        return;
      case "WithdrawalRecorded":
        this.player(pool, owner()).principal -= asAtomicAmount(
          data.amount,
          "amount",
        );
        return;
      case "EntriesRefreshed": {
        const player = this.player(pool, owner());
        player.entriesSpentSinceRefresh = 0n;
        player.entriesRewardedSinceRefresh = 0n;
        player.lastRefreshEpoch = asAtomicAmount(data.epoch_id, "epoch_id");
        return;
      }
      case "PositionPurchased":
        this.player(pool, owner()).entriesSpentSinceRefresh += asAtomicAmount(
          data.total_stake,
          "total_stake",
        );
        return;
      case "RoundRewardClaimed":
        this.player(pool, owner()).entriesRewardedSinceRefresh +=
          asAtomicAmount(data.reward, "reward");
        return;
      case "PoolCreated":
      case "ProtocolPauseChanged":
      case "EpochCreated":
      case "PrizeFunded":
      case "JackpotFunded":
      case "PrizeSnapshotCommitted":
      case "JackpotCommitted":
      case "PrizeRandomnessRequested":
      case "JackpotRandomnessRequested":
      case "PrizeDrawn":
      case "JackpotDrawn":
      case "PrizeClaimed":
      case "JackpotClaimed":
      case "PrizeExpired":
      case "JackpotExpired":
      case "RoundRandomnessRequested":
      case "RoundSettled":
        return;
      default: {
        const exhaustive: never = event.name;
        throw new Error(`unhandled event ${exhaustive}`);
      }
    }
  }
}

export { compareCursor, cursorKey };
