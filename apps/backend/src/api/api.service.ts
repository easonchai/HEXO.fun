import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type Cursor,
  type Epoch,
  type OperatorState,
  type Player,
  type Pool,
  type Round,
} from "@prisma/client";
import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
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

/**
 * How long the chain clock read behind live weights and `/state`'s `chainTime`
 * answers for. `extrapolatedChainNow` advances a cache hit by the wall time
 * since it was observed, so the served second stays live across the whole
 * window; the read only re-grounds the value against the chain's own phase.
 * It was 2 s, which matched the browser's poll interval exactly and so cost a
 * chain read on nearly every poll — 27 calls a minute for as long as one tab
 * stayed open, the largest single item in the RPC bill. The browser anchors
 * its countdown once per round now (`useChainClock.ts`), and chain time gains
 * only 0.19% on wall time, so a longer window changes nothing it shows.
 */
export const CHAIN_CLOCK_TTL_MS = 30_000;

/**
 * How long the jackpot vault balance read behind the open epoch's amount
 * answers for. Longer than the clock's: the vault only moves when the
 * operator tops it up (once per epoch) or the payout drains it, so a 2 s
 * window bought nothing and cost 30 chain calls a minute for as long as one
 * browser tab stayed open.
 */
export const JACKPOT_BALANCE_TTL_MS = 15_000;

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
  /** Weight accrued so far this epoch. */
  liveWeight: bigint;
  /**
   * Weight the player will hold at the draw if nobody touches their account
   * again. Odds come from this share, not the live one: the live share
   * crawls every second as late depositors catch up (a 22.57% that reads
   * 22.64% a minute later), while this one only moves when someone
   * deposits, withdraws or plays.
   */
  drawWeight: bigint;
}

interface RpcHealth {
  rpcOk: boolean;
  slot: number | null;
}

/** The cached Clock sysvar value plus the wall-clock moment it was observed
 *  (when the read resolved, not when `CachedRead.at` below was stamped). */
interface ClockReading {
  value: bigint;
  observedAt: number;
}

/**
 * A TTL-cached read. `result` is the in-flight or last-settled promise
 * itself, not just its resolved value: every caller inside the `at` window
 * awaits that same promise, so a concurrent burst collapses to one chain
 * call instead of one per caller.
 */
interface CachedRead<T> {
  at: number;
  result: Promise<T>;
}

/** Reads for every route in spec.md §3.5 except the faucet, all from Postgres. */
@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);
  private probe: CachedRead<RpcHealth> | undefined;
  private clock: CachedRead<ClockReading> | undefined;
  private jackpotBalance: CachedRead<bigint> | undefined;

  /**
   * The highest chain time `getState` has served. The Clock sysvar runs a
   * little behind wall time, so `extrapolatedChainNow` overshoots inside the
   * cache window and the next fresh read can land below what the previous
   * response carried. The browser anchors its countdown on the `chainTime` it
   * receives at a round boundary, so a value that went backwards made the
   * round timer start the new round with a second it had already counted.
   *
   * ponytail: a high-water mark that never resets. A validator restart that
   * rewinds the chain clock pins it until the backend restarts; only local
   * validators do that.
   */
  private lastServedChainTime = 0n;

  /** Simulated yield rate, so the Vault's "estimated yield" row is not hardcoded. */
  private readonly aprBps: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.aprBps = Number(config.get("APR_BPS", { infer: true }));
  }

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
      return await this.cachedJackpotBalance();
    } catch (error: unknown) {
      // This fallback never enters the cache. cachedJackpotBalance clears a
      // failed read, so the next request retries the chain.
      this.logger.warn(
        `jackpot vault balance read failed, serving the indexed snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return epoch.jackpotAmount;
    }
  }

  /**
   * The chain call `liveJackpot` caches. Unlike `chainNow`/`rpcHealth`
   * below, a failed read clears the slot instead of sitting in it for the
   * rest of the window: the next call retries the chain rather than
   * repeating the same failure, and `liveJackpot`'s fallback is computed
   * above from the failed promise, so it never becomes the cached value
   * itself. A concurrent burst inside the window still shares one chain
   * call: every caller reads the same pending promise before it settles.
   */
  private cachedJackpotBalance(): Promise<bigint> {
    if (
      this.jackpotBalance === undefined ||
      Date.now() - this.jackpotBalance.at > JACKPOT_BALANCE_TTL_MS
    ) {
      const result = this.chain.connection
        .getTokenAccountBalance(this.chain.jackpotVaultAddress())
        .then(({ value }) => BigInt(value.amount));
      const entry: CachedRead<bigint> = { at: Date.now(), result };
      this.jackpotBalance = entry;
      result.catch(() => {
        if (this.jackpotBalance === entry) this.jackpotBalance = undefined;
      });
    }
    return this.jackpotBalance.result;
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
    return playerDto(mine, total);
  }

  /**
   * Ticket 06: Pool, current Epoch, open Round, Player and operator status
   * from one point-in-time snapshot. Every DB read this needs — including
   * the previous epoch and player scan that `drawingProgress`/`liveWeights`
   * would otherwise re-read on their own connections — goes through one
   * `RepeatableRead` transaction; the player scan only runs when an owner is
   * given or the previous epoch is mid-draw. The chain-cached reads (jackpot
   * balance, rpc health, clock, pool config) run after the transaction closes.
   *
   * Ticket 07: `roundId`, when given, also returns that Round's full state —
   * any status, winning tile and tile totals included — as `round`, plus
   * `owner`'s Position in it. `openRound` stays filtered to Open/Requested
   * (an existing contract other callers rely on), so it goes null the moment
   * a Round settles; `round` is how the browser keeps watching the same
   * Round through settlement without a chain read, and how it learns the
   * viewer's Position once that Round is no longer the open one. Falls back
   * to the open Round's id when `roundId` is not given, so a first load with
   * no known id yet still gets a Position for whatever Round is open.
   */
  async getState(owner?: string, roundId?: bigint) {
    const { pool, epoch, previousEpoch, openRound, operator, cursor, players, round, position } =
      await this.prisma.$transaction(
        async (tx) => {
          const pool = await tx.pool.findFirst();
          if (pool === null) {
            throw new NotFoundException(
              "The pool is not indexed yet. Try again in a few seconds.",
            );
          }
          const [epoch, previousEpoch, openRound, operator, cursor] = await Promise.all([
            tx.epoch.findUnique({ where: { id: pool.currentEpochId } }),
            pool.currentEpochId <= 0n
              ? Promise.resolve(null)
              : tx.epoch.findUnique({ where: { id: pool.currentEpochId - 1n } }),
            tx.round.findFirst({
              where: { status: { in: [ROUND_OPEN, ROUND_REQUESTED] } },
              orderBy: { id: "desc" },
            }),
            tx.operatorState.findUnique({ where: { id: 1 } }),
            tx.cursor.findUnique({ where: { id: 1 } }),
          ]);
          const needsPlayers =
            owner !== undefined ||
            (previousEpoch !== null &&
              (previousEpoch.status === EPOCH_REGISTERING ||
                previousEpoch.status === EPOCH_DRAWING));
          const trackedRoundId = roundId ?? openRound?.id;
          const [players, round, position] = await Promise.all([
            needsPlayers ? tx.player.findMany() : Promise.resolve([]),
            trackedRoundId === undefined
              ? Promise.resolve(null)
              : tx.round.findUnique({ where: { id: trackedRoundId } }),
            owner === undefined || trackedRoundId === undefined
              ? Promise.resolve(null)
              : tx.position.findFirst({ where: { owner, roundId: trackedRoundId } }),
          ]);
          return { pool, epoch, previousEpoch, openRound, operator, cursor, players, round, position };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    if (epoch === null) {
      throw new NotFoundException(
        "The current epoch is not indexed yet. Try again in a few seconds.",
      );
    }

    const [jackpotAmount, rpc, chainTime] = await Promise.all([
      this.liveJackpot(epoch),
      this.rpcHealth(),
      this.extrapolatedChainNow(),
    ]);

    // Same extrapolated instant for the response's chainTime and for the
    // Player's liveWeight, so the two never disagree by the clock's TTL.
    const { weights, total } = weightsFrom(players, epoch, chainTime);
    const mine =
      owner === undefined ? undefined : weights.find((entry) => entry.player.owner === owner);

    return {
      pool,
      currentEpoch: {
        ...epoch,
        jackpotAmount,
        drawing: drawingProgressFrom(previousEpoch, players),
      },
      openRound: openRound === null ? null : summarizeRound(openRound),
      round,
      player: mine === undefined ? null : playerDto(mine, total),
      position:
        position === null ? null : { tiles: position.tiles, stakePerTile: position.stakePerTile },
      status: statusFrom(operator, cursor, rpc, this.aprBps),
      chainTime,
    };
  }

  async getLeaderboard(limit: number) {
    const { weights, total } = await this.liveWeights();
    return weights
      .slice()
      .sort((a, b) => (b.drawWeight === a.drawWeight ? 0 : b.drawWeight > a.drawWeight ? 1 : -1))
      .slice(0, limit)
      .map(({ player, liveWeight, drawWeight }) => ({
        owner: player.owner,
        principal: player.principal,
        entries: player.entries,
        isHouse: player.isHouse,
        liveWeight,
        odds: oddsPercent(drawWeight, total),
      }));
  }

  /**
   * Newest first. A settled Position that won nothing is not news, so the
   * reward filter runs in Postgres: filtering it in JS would silently return
   * fewer than `limit` rows on a board where most positions lose.
   *
   * `owner`, when given, keeps only events about that wallet. `JackpotPaid`
   * carries `winner` rather than `owner`, so both keys are checked; dropping
   * the `winner` half would make a "Prize Win" row vanish from that wallet's
   * filtered history. No GIN index on `data`: a seq scan is fine at demo scale.
   */
  getFeed(limit: number, owner?: string): Promise<FeedRow[]> {
    const ownerFilter =
      owner === undefined
        ? Prisma.empty
        : Prisma.sql`AND (data->>'owner' = ${owner} OR data->>'winner' = ${owner})`;
    return this.prisma.$queryRaw<FeedRow[]>`
      SELECT slot, signature, "index", name, data, "blockTime"
      FROM "Event"
      WHERE (name IN (${Prisma.join(FEED_NAMES)})
         OR (name = 'PositionSettled' AND data->>'reward' ~ '^[1-9][0-9]*$'))
      ${ownerFilter}
      ORDER BY slot DESC, "index" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Distinct rounds played per owner, ever. `Position` cannot answer this:
   * `settle_position`/`void_round` close the account and the indexer drops
   * the row with it (indexer.service.ts `syncAccounts`), so a Position-backed
   * count reads 0 for exactly the settled rounds a "Past Winners" row is
   * about. `PositionBought` is append-only history instead, so this counts
   * from the Event log: `{ roundId, owner, tiles, stakePerTile, total }`,
   * both camelCase per `decode.ts`'s `jsonify` (checked against
   * `decode.test.ts`'s fixture, not assumed).
   *
   * DISTINCT on `roundId`: a player can buy more than once in the same round
   * (adding tiles to the same Position account), each a separate
   * `PositionBought` event, so counting rows would overcount rounds.
   */
  async getPositionCounts(owners: string[]): Promise<{ counts: Record<string, number> }> {
    const rows = await this.prisma.$queryRaw<{ owner: string; rounds: number }[]>`
      SELECT data->>'owner' AS owner, COUNT(DISTINCT data->>'roundId')::int AS rounds
      FROM "Event"
      WHERE name = 'PositionBought' AND data->>'owner' IN (${Prisma.join(owners)})
      GROUP BY data->>'owner'
    `;
    const byOwner = new Map(rows.map((row) => [row.owner, row.rounds]));
    const counts = Object.fromEntries(owners.map((owner) => [owner, byOwner.get(owner) ?? 0]));
    return { counts };
  }

  async getStatus() {
    const [operator, cursor, rpc] = await Promise.all([
      this.prisma.operatorState.findUnique({ where: { id: 1 } }),
      this.prisma.cursor.findUnique({ where: { id: 1 } }),
      this.rpcHealth(),
    ]);
    return statusFrom(operator, cursor, rpc, this.aprBps);
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
    const needsPlayers =
      previous !== null &&
      (previous.status === EPOCH_REGISTERING || previous.status === EPOCH_DRAWING);
    const players = needsPlayers ? await this.prisma.player.findMany() : [];
    return drawingProgressFrom(previous, players);
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
    return weightsFrom(players, epoch, at);
  }

  /**
   * The Clock sysvar's `unix_timestamp`, read the same way the operator reads
   * it (see `operator/chain-state.ts`), so Weight and odds here agree with
   * what the draw uses instead of drifting from wall time. Cached for
   * `CHAIN_CLOCK_TTL_MS` so /players and /leaderboard polling does not turn
   * into a chain read per viewer.
   */
  private async chainNow(): Promise<bigint> {
    return (await this.chainClock()).value;
  }

  /**
   * Chain time as of right now: the cached Clock sysvar value (shared with
   * `chainNow` above, so this spends no extra call) advanced by the wall
   * time elapsed since it was observed, so a cache hit never serves a
   * second that is already stale. Used only by `getState` (ticket 06).
   *
   * Clamped to `lastServedChainTime`: the advance is wall time but the chain
   * clock is not, so the two drift apart inside the window and an
   * unclamped value walks backwards across the refresh.
   */
  private async extrapolatedChainNow(): Promise<bigint> {
    const { value, observedAt } = await this.chainClock();
    const elapsedSeconds = BigInt(Math.max(0, Math.floor((Date.now() - observedAt) / 1000)));
    const extrapolated = value + elapsedSeconds;
    if (extrapolated > this.lastServedChainTime) this.lastServedChainTime = extrapolated;
    return this.lastServedChainTime;
  }

  /** `chainNow`/`extrapolatedChainNow`'s shared cache. */
  private chainClock(): Promise<ClockReading> {
    this.clock = this.cached(this.clock, CHAIN_CLOCK_TTL_MS, async () => {
      const info = await this.chain.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
      return { value: clockUnixTimestamp(info?.data), observedAt: Date.now() };
    });
    return this.clock.result;
  }

  /** Cached so /status polling at 2 s does not turn into a getSlot per client. */
  private rpcHealth(): Promise<RpcHealth> {
    this.probe = this.cached(this.probe, RPC_PROBE_TTL_MS, () => this.probeRpc());
    return this.probe.result;
  }

  /**
   * Serves `fetch()` from `cache` for `ttlMs`, replacing it with a fresh call
   * once the window lapses. Returns the new cache entry; the caller stores
   * it back on its own field since a shared private field would mix values
   * of different types across `chainNow` and `rpcHealth` above.
   * `cachedJackpotBalance` below needs a failed read to clear its slot
   * instead of sitting cached for the window, so it keeps its own copy of
   * this check rather than reusing this helper.
   */
  private cached<T>(
    cache: CachedRead<T> | undefined,
    ttlMs: number,
    fetch: () => Promise<T>,
  ): CachedRead<T> {
    if (cache === undefined || Date.now() - cache.at > ttlMs) {
      return { at: Date.now(), result: fetch() };
    }
    return cache;
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
  houseCut: round.houseCut,
});

/** Draw progress for the epoch that just ended, from rows already read.
 *  Null unless `previous` is Registering or Drawing. */
function drawingProgressFrom(previous: Epoch | null, players: Player[]) {
  if (
    previous === null ||
    (previous.status !== EPOCH_REGISTERING && previous.status !== EPOCH_DRAWING)
  ) {
    return null;
  }
  const eligible = players.filter(
    (player) => weightAt(player, previous.id, previous.startsAt, previous.endsAt) > 0n,
  ).length;
  return {
    epochId: previous.id,
    registeredCount: previous.registeredCount,
    eligible,
    status: previous.status,
  };
}

/** GET /status's shape, from rows already read. */
function statusFrom(
  operator: OperatorState | null,
  cursor: Cursor | null,
  rpc: RpcHealth,
  aprBps: number,
) {
  const now = nowSeconds();
  return {
    // The row keeps unix seconds; the frontend `Date.parse`s this field,
    // which reads a bare digit string as NaN and shows "STALLED" forever.
    operator: operator && {
      ...operator,
      lastTickAt:
        operator.lastTickAt == null ? null : new Date(Number(operator.lastTickAt) * 1000),
      // Same treatment: the crank sleeps to a deadline, so the frontend
      // needs to know when it plans to wake before calling it stalled.
      nextWakeAt:
        operator.nextWakeAt == null ? null : new Date(Number(operator.nextWakeAt) * 1000),
    },
    cursor: {
      lastSlot: cursor?.lastSlot ?? null,
      lastSignature: cursor?.lastSignature ?? null,
      // Null rather than 0 when the indexer has never synced, so the
      // frontend can tell "fresh" from "never ran".
      ageSeconds: cursor?.updatedAt == null ? null : Number(now - cursor.updatedAt),
    },
    ...rpc,
    aprBps,
  };
}

/** Each player's Weight at instant `at`, plus the epoch total, from rows already read. */
function weightsFrom(
  players: Player[],
  epoch: Epoch,
  at: bigint,
): { weights: LiveWeight[]; total: bigint } {
  const weights = players.map((player) => ({
    player,
    liveWeight: weightAt(player, epoch.id, epoch.startsAt, at),
    drawWeight: weightAt(player, epoch.id, epoch.startsAt, epoch.endsAt),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.drawWeight, 0n);
  return { weights, total };
}

/** A weighted entry as `/players/:owner` and `/state` return it. */
function playerDto(entry: LiveWeight, total: bigint) {
  return {
    ...entry.player,
    liveWeight: entry.liveWeight,
    odds: oddsPercent(entry.drawWeight, total),
  };
}
