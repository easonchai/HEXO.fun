// Spec §3.4: the seven steps, in order, at most one transaction per tick.
// Round steps (1-2) run before the Epoch steps (3+) so a Round can never
// straddle an Epoch boundary; `begin_epoch` (3) waits for both the sweep and
// the previous Epoch to be settled.
//
// Everything the steps touch arrives in the context, so a test drives them
// with a fabricated chain state and a recording `send`, and the service is
// left with nothing but plumbing.
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import {
  EPOCH_STATUS,
  ROUND_STATUS,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import type { OperatorInstructions } from "./instructions";

const BPS = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;
/** Instructions per transaction for the two batched steps (spec §3.4). */
export const BATCH_SIZE = 8;
/** The reveal's 4.6 s choreography, rounded up to whole chain seconds. Step 7
 *  waits this long past a settled/forfeited `lastRound.endsAt` before opening
 *  the next Round, so no viewer sees a new countdown while the laser lands. */
export const REVEAL_SECONDS = 5n;

/**
 * The simulated yield an ended epoch pays out, in atomic units. Integer math
 * throughout: the truncated remainder is worth less than 10^-6 hexUSDC and
 * the floor dwarfs it during the demo anyway.
 */
export function yieldAmount(
  totalPrincipal: bigint,
  aprBps: bigint,
  epochSeconds: bigint,
  floor: bigint,
): bigint {
  const accrued =
    (totalPrincipal * aprBps * epochSeconds) / (BPS * SECONDS_PER_YEAR);
  return accrued > floor ? accrued : floor;
}

/**
 * What step 4 remembers about the last tick's `playersToRegister` check, so
 * it can tell "empty again" from "empty for the first time". The service
 * persists this across ticks; the pure function only reads and returns it.
 */
export interface RegisterCheck {
  readonly epochId: bigint;
  readonly empty: boolean;
}

export interface TickContext {
  /** Chain clock, not wall time: every deadline below is a chain timestamp. */
  readonly now: bigint;
  readonly pool: PoolState;
  readonly currentEpoch: EpochState | null;
  readonly previousEpoch: EpochState | null;
  /** The Round at `pool.openRoundId`, null when none is open. */
  readonly openRound: RoundState | null;
  /** The Round at `pool.nextRoundId - 1`, the most recently created one
   *  (open or already terminal). Null when none has ever been created. */
  readonly lastRound: RoundState | null;
  readonly aprBps: bigint;
  readonly jackpotFloor: bigint;
  readonly ix: OperatorInstructions;
  /** Null before the first tick has ever checked. */
  readonly lastRegisterCheck: RegisterCheck | null;
  /** Has the oracle answered the request for this seed? */
  fulfilled(seed: Uint8Array): Promise<boolean>;
  /** The authority's own hexUSDC balance, in atomic units. */
  authorityBalance(): Promise<bigint>;
  playersToRegister(epochId: bigint): Promise<string[]>;
  /**
   * Positions still on chain whose Round has reached a terminal status
   * (Settled, Forfeited, Voided), across every such Round, not just the
   * newest, with the Round id so step 2 can group a batch by Round.
   */
  unsettledPositions(): Promise<
    { address: string; owner: string; roundId: bigint }[]
  >;
  /** Owner of the Player whose registered interval contains `target`. */
  winner(epochId: bigint, target: bigint): Promise<string | null>;
  send(instructions: TransactionInstruction[]): Promise<string>;
}

export interface TickOutcome {
  /** Instruction sent this tick, named as in the program, or null. */
  readonly action: string | null;
  /** Registration progress, while step 4 is cranking. */
  readonly progress?: { readonly count: number; readonly total: number };
  /** Present whenever step 4 checked `playersToRegister`, for the service to
   *  remember as next tick's `lastRegisterCheck`. */
  readonly registerCheck?: RegisterCheck;
}

const NOTHING: TickOutcome = { action: null };

export async function runTick(ctx: TickContext): Promise<TickOutcome> {
  const { pool, currentEpoch, previousEpoch, openRound, now } = ctx;

  // 1. Round: an Open round past its close asks for randomness, the same
  // instant `buy_position` starts refusing (program §2.3); Requested and
  // fulfilled settles; Requested past `vrf_timeout` voids. Runs first so a
  // Round can never straddle the boundary step 3 might open next.
  if (openRound) {
    if (
      openRound.status === ROUND_STATUS.OPEN &&
      now >= openRound.endsAt - pool.closeBuffer
    ) {
      await ctx.send(await ctx.ix.requestRoundRandomness(pool, openRound));
      return { action: "request_round_randomness" };
    }
    if (openRound.status === ROUND_STATUS.REQUESTED) {
      if (await ctx.fulfilled(openRound.vrfSeed)) {
        await ctx.send(await ctx.ix.settleRound(pool, openRound));
        return { action: "settle_round" };
      }
      if (now > openRound.requestedAt + pool.vrfTimeout) {
        await ctx.send(await ctx.ix.voidRound(pool, openRound.roundId));
        return { action: "void_round" };
      }
    }
  }

  // 2. Sweep: unsettled Positions on any Round that is Settled, Forfeited or
  // Voided, not just the newest one. Grouped by Round because a batch settles
  // within one Round; one batch, and one Round, per tick, as before.
  const sweep = await ctx.unsettledPositions();
  const [firstUnsettled] = sweep;
  if (firstUnsettled) {
    const roundId = firstUnsettled.roundId;
    const batch = sweep
      .filter((position) => position.roundId === roundId)
      .slice(0, BATCH_SIZE);
    await ctx.send(await ctx.ix.settlePositions(pool, roundId, batch));
    return { action: "settle_position" };
  }

  // 3. Begin Epoch: only once the Round and the sweep above are clear, and
  // the previous Epoch (if any) has actually finished, so no Epoch is ever
  // left two behind.
  const epochEnded =
    pool.currentEpochId === 0n ||
    (currentEpoch !== null && now >= currentEpoch.endsAt);
  const previousDone =
    previousEpoch === null ||
    previousEpoch.status === EPOCH_STATUS.PAID ||
    previousEpoch.status === EPOCH_STATUS.ROLLED_OVER;
  if (epochEnded && pool.openRoundId === 0n && previousDone) {
    await ctx.send(await ctx.ix.beginEpoch(pool));
    return { action: "begin_epoch" };
  }

  // 4. The ended epoch is taking registrations: crank them, then fund the
  // jackpot and close once the list has come back empty on two consecutive
  // ticks for this Epoch, so a player who registered right before `ends_at`
  // gets one more indexer sync window before being counted out.
  if (previousEpoch?.status === EPOCH_STATUS.REGISTERING) {
    const owners = await ctx.playersToRegister(previousEpoch.epochId);
    if (owners.length > 0) {
      const batch = owners
        .slice(0, BATCH_SIZE)
        .map((owner) => new PublicKey(owner));
      await ctx.send(await ctx.ix.register(pool, previousEpoch.epochId, batch));
      // ponytail: an owner whose on-chain weight is zero registers as a no-op
      // and comes back next tick, so a sloppy indexer query stalls the epoch
      // here forever. The contract is on IndexerQueries.playersToRegister; if
      // it has to be enforced on this side, compare consecutive batches.
      return {
        action: "register",
        progress: {
          count: previousEpoch.registeredCount,
          total: previousEpoch.registeredCount + owners.length,
        },
        registerCheck: { epochId: previousEpoch.epochId, empty: false },
      };
    }

    const emptyLastTick =
      ctx.lastRegisterCheck?.epochId === previousEpoch.epochId &&
      ctx.lastRegisterCheck.empty;
    if (!emptyLastTick) {
      return {
        action: null,
        registerCheck: { epochId: previousEpoch.epochId, empty: true },
      };
    }

    const amount = yieldAmount(
      pool.totalPrincipal,
      ctx.aprBps,
      previousEpoch.endsAt - previousEpoch.startsAt,
      ctx.jackpotFloor,
    );
    const balance = await ctx.authorityBalance();
    const shortfall = amount > balance ? amount - balance : 0n;
    await ctx.send(
      await ctx.ix.fundAndClose(pool, previousEpoch.epochId, amount, shortfall),
    );
    return { action: "close_registration" };
  }

  // 5. Waiting on the draw's randomness.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    if (await ctx.fulfilled(previousEpoch.vrfSeed)) {
      await ctx.send(await ctx.ix.draw(pool, previousEpoch));
      return { action: "draw" };
    }
    if (now > previousEpoch.requestedAt + pool.vrfTimeout) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch.epochId));
      return { action: "rollover_epoch" };
    }
  }

  // 6. Drawn: pay whoever owns the interval the target landed in.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    const winner = await ctx.winner(
      previousEpoch.epochId,
      previousEpoch.target,
    );
    if (winner) {
      await ctx.send(
        await ctx.ix.payout(pool, previousEpoch.epochId, new PublicKey(winner)),
      );
      return { action: "payout" };
    }
    // No row covers the target yet: the indexer has not caught up with the
    // registrations. Retried next tick rather than treated as an error.
  }

  // 7. Open the next round, if a whole one still fits in this epoch, and the
  // previous Round's reveal has had time to play: no viewer should see a new
  // countdown while the last Round's laser is still landing.
  const lastRound = ctx.lastRound;
  const revealDone =
    lastRound === null ||
    lastRound.status === ROUND_STATUS.VOIDED ||
    now >= lastRound.endsAt + REVEAL_SECONDS;
  if (
    pool.openRoundId === 0n &&
    !pool.paused &&
    currentEpoch &&
    now + pool.roundSeconds <= currentEpoch.endsAt &&
    revealDone
  ) {
    await ctx.send(
      await ctx.ix.createRound(pool, now, now + pool.roundSeconds),
    );
    return { action: "create_round" };
  }

  return NOTHING;
}

/**
 * Program errors that mean "someone already did this" or "not yet". Every one
 * of them is a race between the tick's read and its transaction landing, so
 * they are noise, not failures. Names come from the IDL error table, which is
 * what `ChainService.mapSendError` puts in `Error.message`.
 */
export const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  "AlreadyRegistered",
  "EpochNotDrawing",
  "EpochNotDrawn",
  "EpochNotEnded",
  "EpochNotRegistering",
  "NotPreviousEpoch",
  "RandomnessNotFulfilled",
  "RoundAlreadyOpen",
  "RoundNotEnded",
  "RoundNotOpen",
  "RoundNotRequested",
  "RoundNotSettled",
  "VrfTimeoutNotElapsed",
]);
