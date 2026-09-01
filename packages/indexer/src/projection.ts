import {
  asAtomicAmount,
  asPublicKey,
  compareCursor,
  cursorKey,
  type AtomicAmount,
  type Cursor,
  type EventEnvelope,
} from "./events.js";

export interface PlayerView {
  owner: string;
  principalMinted: AtomicAmount;
  principalWithdrawn: AtomicAmount;
  entriesMinted: AtomicAmount;
  entriesSpent: AtomicAmount;
  lastEntryEpoch?: bigint;
}

export interface RoundView {
  address: string;
  epochId: bigint;
  roundId: bigint;
  winningTile?: number;
  totalStaked: AtomicAmount;
  settled: boolean;
}

export interface EpochView {
  epochId: bigint;
  prizeAmount?: AtomicAmount;
  totalEntryWeight?: AtomicAmount;
  prizeTarget?: AtomicAmount;
  winner?: string;
  claimed: boolean;
}

/**
 * In-memory reference reducer. The production adapter persists all maps and the
 * cursor in one database transaction; this pure implementation makes replay
 * and idempotency behavior independently testable.
 */
export class HexVaultProjection {
  readonly players = new Map<string, PlayerView>();
  readonly rounds = new Map<string, RoundView>();
  readonly epochs = new Map<bigint, EpochView>();
  private readonly processed = new Set<string>();
  private checkpoint?: Cursor;

  getCheckpoint(): Cursor | undefined {
    return this.checkpoint;
  }

  apply(event: EventEnvelope): boolean {
    if (event.finality !== "finalized") {
      throw new Error("indexer accepts finalized events only");
    }

    const key = cursorKey(event.cursor);
    if (this.processed.has(key)) return false;

    if (this.checkpoint && compareCursor(event.cursor, this.checkpoint) < 0) {
      throw new Error(
        `out-of-order finalized event ${key}; replay from a durable checkpoint`,
      );
    }

    this.reduce(event);
    this.processed.add(key);
    if (!this.checkpoint || compareCursor(event.cursor, this.checkpoint) > 0) {
      this.checkpoint = event.cursor;
    }
    return true;
  }

  private player(owner: string): PlayerView {
    const existing = this.players.get(owner);
    if (existing) return existing;

    const created: PlayerView = {
      owner,
      principalMinted: 0n,
      principalWithdrawn: 0n,
      entriesMinted: 0n,
      entriesSpent: 0n,
    };
    this.players.set(owner, created);
    return created;
  }

  private epoch(epochId: bigint): EpochView {
    const existing = this.epochs.get(epochId);
    if (existing) return existing;
    const created: EpochView = { epochId, claimed: false };
    this.epochs.set(epochId, created);
    return created;
  }

  private reduce(event: EventEnvelope): void {
    const data = event.data;
    switch (event.name) {
      case "DepositRecorded": {
        const player = this.player(asPublicKey(data.owner, "owner"));
        const amount = asAtomicAmount(data.amount, "amount");
        player.principalMinted += amount;
        player.entriesMinted += amount;
        return;
      }
      case "WithdrawalRecorded": {
        const player = this.player(asPublicKey(data.owner, "owner"));
        player.principalWithdrawn += asAtomicAmount(data.amount, "amount");
        return;
      }
      case "EntriesRefreshed": {
        const player = this.player(asPublicKey(data.owner, "owner"));
        const epochId = asAtomicAmount(data.epochId, "epochId");
        player.lastEntryEpoch = epochId;
        return;
      }
      case "PositionPurchased": {
        const owner = asPublicKey(data.owner, "owner");
        const round = asPublicKey(data.round, "round");
        const epochId = asAtomicAmount(data.epochId, "epochId");
        const roundId = asAtomicAmount(data.roundId, "roundId");
        const totalStake = asAtomicAmount(data.totalStake, "totalStake");
        const player = this.player(owner);
        player.entriesSpent += totalStake;
        const current = this.rounds.get(round) ?? {
          address: round,
          epochId,
          roundId,
          totalStaked: 0n,
          settled: false,
        };
        current.totalStaked += totalStake;
        this.rounds.set(round, current);
        return;
      }
      case "RoundSettled": {
        const round = asPublicKey(data.round, "round");
        const existing = this.rounds.get(round);
        if (!existing)
          throw new Error(`round ${round} settled before purchase projection`);
        const winningTile = Number(
          asAtomicAmount(data.winningTile, "winningTile"),
        );
        if (
          !Number.isInteger(winningTile) ||
          winningTile < 0 ||
          winningTile >= 36
        ) {
          throw new Error("winningTile must be in [0, 35]");
        }
        existing.winningTile = winningTile;
        existing.settled = true;
        return;
      }
      case "RoundRewardClaimed": {
        const player = this.player(asPublicKey(data.owner, "owner"));
        player.entriesMinted += asAtomicAmount(data.reward, "reward");
        return;
      }
      case "PrizeSnapshotCommitted": {
        const epoch = this.epoch(asAtomicAmount(data.epochId, "epochId"));
        epoch.prizeAmount = asAtomicAmount(data.prizeAmount, "prizeAmount");
        epoch.totalEntryWeight = asAtomicAmount(
          data.totalEntryWeight,
          "totalEntryWeight",
        );
        return;
      }
      case "PrizeDrawn": {
        const epoch = this.epoch(asAtomicAmount(data.epochId, "epochId"));
        epoch.prizeTarget = asAtomicAmount(data.target, "target");
        return;
      }
      case "PrizeClaimed": {
        const epoch = this.epoch(asAtomicAmount(data.epochId, "epochId"));
        if (epoch.claimed)
          throw new Error(`epoch ${epoch.epochId} prize claimed twice`);
        epoch.winner = asPublicKey(data.winner, "winner");
        epoch.claimed = true;
        return;
      }
      case "RoundRandomnessRequested":
      case "PrizeFunded":
      case "PrizeRandomnessRequested":
      case "ProtocolPauseChanged":
        return;
      default: {
        const exhaustive: never = event.name;
        throw new Error(`unhandled event ${exhaustive}`);
      }
    }
  }
}
