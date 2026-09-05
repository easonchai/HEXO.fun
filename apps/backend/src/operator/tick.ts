// Spec §3.4: the eight steps, in order, at most one transaction per tick.
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
  const accrued = (totalPrincipal * aprBps * epochSeconds) / (BPS * SECONDS_PER_YEAR);
  return accrued > floor ? accrued : floor;
}

export interface TickContext {
  /** Chain clock, not wall time: every deadline below is a chain timestamp. */
  readonly now: bigint;
  readonly pool: PoolState;
  readonly currentEpoch: EpochState | null;
  readonly previousEpoch: EpochState | null;
  /** The Round at `pool.openRoundId`, null when none is open. */
  readonly openRound: RoundState | null;
  readonly aprBps: bigint;
  readonly jackpotFloor: bigint;
  readonly ix: OperatorInstructions;
  /** Has the oracle answered the request for this seed? */
  fulfilled(seed: Uint8Array): Promise<boolean>;
  /** The authority's own hexUSDC balance, in atomic units. */
  authorityBalance(): Promise<bigint>;
  playersToRegister(epochId: bigint): Promise<string[]>;
  unsettledPositions(roundId: bigint): Promise<{ address: string; owner: string }[]>;
  /** Owner of the Player whose registered interval contains `target`. */
  winner(epochId: bigint, target: bigint): Promise<string | null>;
  send(instructions: TransactionInstruction[]): Promise<string>;
}

export interface TickOutcome {
  /** Instruction sent this tick, named as in the program, or null. */
  readonly action: string | null;
  /** Registration progress, while step 2 is cranking. */
  readonly progress?: { readonly count: number; readonly total: number };
}

const NOTHING: TickOutcome = { action: null };

export async function runTick(ctx: TickContext): Promise<TickOutcome> {
  const { pool, currentEpoch, previousEpoch, openRound, now } = ctx;

  // 1. No epoch yet, or the current one is over.
  if (pool.currentEpochId === 0n || (currentEpoch && now >= currentEpoch.endsAt)) {
    await ctx.send(await ctx.ix.beginEpoch(pool));
    return { action: "begin_epoch" };
  }

  // 2. The ended epoch is taking registrations: crank them, then fund the
  // jackpot and close in one transaction.
  if (previousEpoch?.status === EPOCH_STATUS.REGISTERING) {
    const owners = await ctx.playersToRegister(previousEpoch.epochId);
    if (owners.length > 0) {
      const batch = owners.slice(0, BATCH_SIZE).map((owner) => new PublicKey(owner));
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
    await ctx.send(await ctx.ix.fundAndClose(pool, previousEpoch.epochId, amount, shortfall));
    return { action: "close_registration" };
  }

  // 3. Waiting on the draw's randomness.
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

  // 4. Drawn: pay whoever owns the interval the target landed in.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    const winner = await ctx.winner(previousEpoch.epochId, previousEpoch.target);
    if (winner) {
      await ctx.send(await ctx.ix.payout(pool, previousEpoch.epochId, new PublicKey(winner)));
      return { action: "payout" };
    }
    // No row covers the target yet: the indexer has not caught up with the
    // registrations. Retried next tick rather than treated as an error.
  }

  if (openRound) {
    // 5. The round is over: ask for its randomness.
    if (openRound.status === ROUND_STATUS.OPEN && now >= openRound.endsAt) {
      await ctx.send(await ctx.ix.requestRoundRandomness(pool, openRound));
      return { action: "request_round_randomness" };
    }

    // 6. Requested: settle it, or void it once the oracle has had long enough.
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

  // 7. Close out the Positions of the round that just ended. `open_round_id`
  // is cleared by settle/void, so the round to sweep is always the newest one,
  // and step 8 below cannot open the next one until this comes up empty.
  if (pool.openRoundId === 0n && pool.nextRoundId > 1n) {
    const roundId = pool.nextRoundId - 1n;
    const positions = await ctx.unsettledPositions(roundId);
    if (positions.length > 0) {
      await ctx.send(
        await ctx.ix.settlePositions(pool, roundId, positions.slice(0, BATCH_SIZE)),
      );
      return { action: "settle_position" };
    }
  }

  // 8. Open the next round, if a whole one still fits in this epoch.
  if (
    pool.openRoundId === 0n &&
    !pool.paused &&
    currentEpoch &&
    now + pool.roundSeconds <= currentEpoch.endsAt
  ) {
    await ctx.send(await ctx.ix.createRound(pool, now, now + pool.roundSeconds));
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
