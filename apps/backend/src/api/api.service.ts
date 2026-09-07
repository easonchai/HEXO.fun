import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type Epoch, type Player, type Pool, type Round } from "@prisma/client";
import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import { clockUnixTimestamp } from "../operator/chain-state";
import { PrismaService } from "../prisma/prisma.service";

/** Mirrors programs/hex_vault/src/constants.rs `epoch_status`. */
export const EPOCH_OPEN = 0;
export const EPOCH_REGISTERING = 1;
export const EPOCH_DRAWING = 2;

/** Mirrors programs/hex_vault/src/constants.rs `round_status`. */
export const ROUND_OPEN = 0;
export const ROUND_REQUESTED = 1;

/** Events the frontend feed shows. Anything else is operator noise. */
const FEED_NAMES = [
  "Deposited",
  "Withdrawn",
  "PositionBought",
  "RoundSettled",
  "JackpotPaid",
  "EpochRolledOver",
] as const;

/** How long a `getSlot` probe answers for. `rpcOk` only needs to be roughly right. */
const RPC_PROBE_TTL_MS = 300_000;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const toBigInt = (value: Prisma.Decimal): bigint => BigInt(value.toFixed());

/**
 * A player's Weight for one epoch at instant `at`, following the touch rule in
 * spec.md §2.2 without needing the player to have been touched. Four cases:
 * the epoch is already frozen, the player is accruing in it, the player last
 * acted before it (so Entries equalled Principal throughout), or the player
 * has already moved past it without freezing it, which is zero.
 */
export function weightAt(
  player: Player,
  epochId: bigint,
  epochStart: bigint,
  at: bigint,
): bigint {
  if (player.frozenEpoch === epochId) return toBigInt(player.frozenWeight);
  if (player.epochId === epochId) {
    const elapsed = at - player.lastUpdate;
    if (elapsed <= 0n) return toBigInt(player.weightAcc);
    return toBigInt(player.weightAcc) + player.entries * elapsed;
  }
  if (player.epochId < epochId) {
    const elapsed = at - epochStart;
    return elapsed <= 0n ? 0n : player.principal * elapsed;
  }
  return 0n;
}

/** Share of the total as a percentage with two decimals, e.g. "12.34". */
export function oddsPercent(weight: bigint, total: bigint): string {
  if (total <= 0n || weight <= 0n) return "0.00";
  const basisPoints = (weight * 10_000n) / total;
  const whole = basisPoints / 100n;
  const fraction = basisPoints % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

interface LiveWeight {
  player: Player;
  liveWeight: bigint;
}

interface RpcHealth {
  rpcOk: boolean;
  slot: number | null;
}

/** Reads for every route in spec.md §3.5 except the faucet, all from Postgres. */
@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private probe: { at: number; result: Promise<RpcHealth> } | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
  ) {}

  async getPool() {
    const pool = await this.requirePool();
    const [currentEpoch, openRound] = await Promise.all([
      this.prisma.epoch.findUnique({ where: { id: pool.currentEpochId } }),
      this.prisma.round.findFirst({
        where: { status: { in: [ROUND_OPEN, ROUND_REQUESTED] } },
        orderBy: { id: "desc" },
      }),
    ]);
    return {
      pool,
      currentEpoch,
      openRound: openRound === null ? null : summarizeRound(openRound),
    };
  }

  getEpochs(limit: number): Promise<Epoch[]> {
    return this.prisma.epoch.findMany({ orderBy: { id: "desc" }, take: limit });
  }

  async getCurrentEpoch() {
    const pool = await this.requirePool();
    const epoch = await this.prisma.epoch.findUnique({
      where: { id: pool.currentEpochId },
    });
    if (epoch === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }
    return {
      ...epoch,
      jackpotAmount: await this.liveJackpot(epoch),
      drawing: await this.drawingProgress(pool),
    };
  }

  /**
   * `Epoch.jackpot_amount` is a snapshot the program takes once, at
   * `close_registration`. While the epoch is still open it is 0 on chain no
   * matter what `fund_jackpot` has moved into the vault, so the open epoch
   * reports the vault's token balance instead. From REGISTERING on the chain
   * value is authoritative (the vault drains to the winner at payout).
   */
  private async liveJackpot(epoch: Epoch): Promise<bigint> {
    if (epoch.status !== EPOCH_OPEN) return epoch.jackpotAmount;
    try {
      const { value } = await this.chain.connection.getTokenAccountBalance(
        this.chain.jackpotVaultAddress(),
      );
      return BigInt(value.amount);
    } catch (error: unknown) {
      this.logger.warn(
        `jackpot vault balance read failed, serving the indexed snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return epoch.jackpotAmount;
    }
  }

  getRounds(limit: number): Promise<Round[]> {
    return this.prisma.round.findMany({ orderBy: { id: "desc" }, take: limit });
  }

  async getRound(id: bigint): Promise<Round> {
    const round = await this.prisma.round.findUnique({ where: { id } });
    if (round === null) {
      throw new NotFoundException(`No round ${id}. Check the round id and retry.`);
    }
    return round;
  }

  async getPlayer(owner: string) {
    const { weights, total } = await this.liveWeights();
    const mine = weights.find((entry) => entry.player.owner === owner);
    if (mine === undefined) {
      throw new NotFoundException(
        "No Player account for that wallet yet. Deposit to open one.",
      );
    }
    return {
      ...mine.player,
      liveWeight: mine.liveWeight,
      odds: oddsPercent(mine.liveWeight, total),
    };
  }

  async getLeaderboard(limit: number) {
    const { weights, total } = await this.liveWeights();
    return weights
      .slice()
      .sort((a, b) => (b.liveWeight === a.liveWeight ? 0 : b.liveWeight > a.liveWeight ? 1 : -1))
      .slice(0, limit)
      .map(({ player, liveWeight }) => ({
        owner: player.owner,
        principal: player.principal,
        entries: player.entries,
        isHouse: player.isHouse,
        liveWeight,
        odds: oddsPercent(liveWeight, total),
      }));
  }

  /**
   * Newest first. A settled Position that won nothing is not news, so the
   * reward filter runs in Postgres: filtering it in JS would silently return
   * fewer than `limit` rows on a board where most positions lose.
   */
  getFeed(limit: number): Promise<FeedRow[]> {
    return this.prisma.$queryRaw<FeedRow[]>`
      SELECT slot, signature, "index", name, data, "blockTime"
      FROM "Event"
      WHERE name IN (${Prisma.join(FEED_NAMES)})
         OR (name = 'PositionSettled' AND data->>'reward' ~ '^[1-9][0-9]*$')
      ORDER BY slot DESC, "index" DESC
      LIMIT ${limit}
    `;
  }

  async getStatus() {
    const [operator, cursor, rpc] = await Promise.all([
      this.prisma.operatorState.findUnique({ where: { id: 1 } }),
      this.prisma.cursor.findUnique({ where: { id: 1 } }),
      this.rpcHealth(),
    ]);
    const now = nowSeconds();
    return {
      // The row keeps unix seconds; the frontend `Date.parse`s this field,
      // which reads a bare digit string as NaN and shows "STALLED" forever.
      operator: operator && {
        ...operator,
        lastTickAt:
          operator.lastTickAt == null
            ? null
            : new Date(Number(operator.lastTickAt) * 1000),
      },
      cursor: {
        lastSlot: cursor?.lastSlot ?? null,
        lastSignature: cursor?.lastSignature ?? null,
        // Null rather than 0 when the indexer has never synced, so the
        // frontend can tell "fresh" from "never ran".
        ageSeconds:
          cursor?.updatedAt == null ? null : Number(now - cursor.updatedAt),
      },
      ...rpc,
    };
  }

  private async requirePool(): Promise<Pool> {
    const pool = await this.prisma.pool.findFirst();
    if (pool === null) {
      throw new NotFoundException(
        "The pool is not indexed yet. Try again in a few seconds.",
      );
    }
    return pool;
  }

  /**
   * Registration and draw progress for the epoch that just ended, so the
   * Jackpot screen can show a bar instead of a spinner.
   */
  private async drawingProgress(pool: Pool) {
    if (pool.currentEpochId <= 0n) return null;
    const previous = await this.prisma.epoch.findUnique({
      where: { id: pool.currentEpochId - 1n },
    });
    if (
      previous === null ||
      (previous.status !== EPOCH_REGISTERING && previous.status !== EPOCH_DRAWING)
    ) {
      return null;
    }
    const players = await this.prisma.player.findMany();
    const eligible = players.filter(
      (player) =>
        weightAt(player, previous.id, previous.startsAt, previous.endsAt) > 0n,
    ).length;
    return {
      epochId: previous.id,
      registeredCount: previous.registeredCount,
      eligible,
      status: previous.status,
    };
  }

  /**
   * ponytail: scans every Player row per request to get the odds denominator.
   * Fine for one demo pool; cache the total per epoch tick if it grows.
   */
  private async liveWeights(): Promise<{ weights: LiveWeight[]; total: bigint }> {
    const pool = await this.requirePool();
    const epoch = await this.prisma.epoch.findUnique({
      where: { id: pool.currentEpochId },
    });
    if (epoch === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }
    const at = await this.chainNow();
    const players = await this.prisma.player.findMany();
    const weights = players.map((player) => ({
      player,
      liveWeight: weightAt(player, epoch.id, epoch.startsAt, at),
    }));
    const total = weights.reduce((sum, entry) => sum + entry.liveWeight, 0n);
    return { weights, total };
  }

  /**
   * The Clock sysvar's `unix_timestamp`, read the same way the operator reads
   * it (see `operator/chain-state.ts`), so Weight and odds here agree with
   * what the draw uses instead of drifting from wall time.
   * ponytail: no caching, unlike rpcHealth below; add the same TTL cache here
   * if /players and /leaderboard polling starts hammering the RPC.
   */
  private async chainNow(): Promise<bigint> {
    const info = await this.chain.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    return clockUnixTimestamp(info?.data);
  }

  /** Cached so /status polling at 2 s does not turn into a getSlot per client. */
  private rpcHealth(): Promise<RpcHealth> {
    if (this.probe === undefined || Date.now() - this.probe.at > RPC_PROBE_TTL_MS) {
      this.probe = { at: Date.now(), result: this.probeRpc() };
    }
    return this.probe.result;
  }

  private async probeRpc(): Promise<RpcHealth> {
    try {
      return { rpcOk: true, slot: await this.chain.connection.getSlot() };
    } catch (cause) {
      // The RPC url carries the provider api key, and web3.js puts the whole
      // url in its error text, so scrub it before it reaches a log line.
      const endpoint = this.chain.connection.rpcEndpoint;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(`getSlot failed: ${detail.split(endpoint).join("<rpc-url>")}`);
      return { rpcOk: false, slot: null };
    }
  }
}

export interface FeedRow {
  slot: bigint;
  signature: string;
  index: number;
  name: string;
  data: Prisma.JsonValue;
  blockTime: bigint | null;
}

const summarizeRound = (round: Round) => ({
  id: round.id,
  epochId: round.epochId,
  startsAt: round.startsAt,
  endsAt: round.endsAt,
  status: round.status,
  pot: round.pot,
});
