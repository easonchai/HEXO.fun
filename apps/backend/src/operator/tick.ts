// Spec §3.4: the seven steps, in order, at most one transaction per tick,
// plus 6b (paying out the withdrawals whose epoch has ended). Round steps
// (1-2) run before the Epoch steps (3+) so a Round can never straddle an
// Epoch boundary; `begin_epoch` (3) waits for both the sweep and the previous
// Epoch to be settled.
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

/** Instructions per transaction for the two batched steps (spec §3.4). */
export const BATCH_SIZE = 8;
/** Step 7 waits this long past a settled/forfeited `lastRound.endsAt` before
 *  opening the next Round. The reveal now fires the moment the draw lands,
 *  usually before `endsAt`, so one second of slack is all it needs. */
export const REVEAL_SECONDS = 1n;
/**
 * How far apart the scheduler's slow safety tick runs (ticket 03, spec.md
 * "The Operator becomes deadline-driven"), and the ceiling `nextWakeAt` falls
 * back to when nothing on chain gives it a closer deadline. A mis-computed
 * deadline then degrades to "checked on this cadence", not a stall.
 */
export const SAFETY_INTERVAL_SECONDS = 60n;
/**
 * Pending withdrawals per transaction (step 6b). Smaller than BATCH_SIZE
 * because each one carries three accounts of its own (owner, Player, the
 * owner's token account) plus an idempotent ATA creation, and eight of those
 * overflow a legacy transaction.
 */
export const WITHDRAW_BATCH_SIZE = 4;
/** What the program answers when the principal vault cannot cover a payout;
 *  `ChainService.mapSendError` puts the IDL name in `Error.message`. */
const SHORT_VAULT = "InsufficientVaultLiquidity";

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
  readonly ix: OperatorInstructions;
  /** Null before the first tick has ever checked. */
  readonly lastRegisterCheck: RegisterCheck | null;
  /** Has the oracle answered the request for this seed? */
  fulfilled(seed: Uint8Array): Promise<boolean>;
  /** The principal vault's balance, in atomic units. Read only when a payout
   *  has already failed for want of liquidity, to size the shortfall. */
  principalVaultBalance(): Promise<bigint>;
  /**
   * Players from the Read model whose withdrawal request is payable now:
   * `pendingWithdraw > 0` and `pendingEpoch < currentEpochId`. Oldest
   * request first, so a long queue still drains in order.
   */
  duePendingWithdrawals(
    currentEpochId: bigint,
  ): Promise<{ owner: string; amount: bigint }[]>;
  playersToRegister(epochId: bigint): Promise<string[]>;
  /**
   * Positions still on chain whose Round has reached a terminal status
   * (Settled, Forfeited, Voided), across every such Round, not just the
   * newest, with the Round id so step 2 can group a batch by Round.
   */
  unsettledPositions(): Promise<
    { address: string; owner: string; roundId: bigint }[]
  >;
  /** Positions a confirmed `settle_position` just closed; keep them out of
   *  later `unsettledPositions` results. */
  forgetPositions(addresses: string[]): Promise<void>;
  /** Owner of the Player whose registered interval contains `target`. */
  winner(epochId: bigint, target: bigint): Promise<string | null>;
  send(instructions: TransactionInstruction[]): Promise<string>;
  /** Something an operator should read but that is not a failed tick: so far
   *  only a payout that would not land, which step 6 retries. */
  warn(message: string): void;
}

export interface TickOutcome {
  /** Instruction sent this tick, named as in the program, or null. */
  readonly action: string | null;
  /** Registration progress, while step 4 is cranking. */
  readonly progress?: { readonly count: number; readonly total: number };
  /** Present whenever step 4 checked `playersToRegister`, for the service to
   *  remember as next tick's `lastRegisterCheck`. */
  readonly registerCheck?: RegisterCheck;
  /**
   * How much the principal vault was short of everything step 6b owed, 0
   * when it covered them all. Present only on a tick that reached step 6b,
   * so a tick that acted earlier leaves the last reported figure standing.
   */
  readonly withdrawShortfall?: bigint;
  /**
   * The chain timestamp at which this decision could next differ: a Round
   * closing, an Epoch ending, a VRF timeout, the reveal wait after the last
   * Round, or the safety interval when none of those apply. Not a wall-clock
   * value and not a duration; the scheduler converts it (see
   * `operator.service.ts`).
   */
  readonly nextWakeAt: bigint;
}

/** `runTick`'s decision, before the deadline is attached. Every branch below
 *  still returns one of these; `runTick` is the thin wrapper that adds
 *  `nextWakeAt` in one place instead of at every return statement. */
type Decision = Omit<TickOutcome, "nextWakeAt">;

const NOTHING: Decision = { action: null };

/**
 * The instant `close_registration` starts being accepted. The program
 * measures the window from the later of the epoch's end and the moment
 * `begin_epoch` actually opened registration, so an operator that ran late
 * still owes the full window from when it ran.
 */
function registrationClosesAt(pool: PoolState, epoch: EpochState): bigint {
  const opened =
    epoch.registrationOpenedAt > epoch.endsAt
      ? epoch.registrationOpenedAt
      : epoch.endsAt;
  return opened + pool.registrationWindow;
}

/**
 * The next chain timestamp at which `decide` could return something
 * different, given the same ctx it just ran on. Pure: everything it reads
 * already lives on `ctx`, so it never touches the clock or the network.
 *
 * Acting this tick (`acted`) always makes that "now": a batched step
 * (register, the settle sweep) may have more left to do, and the state that
 * triggered the action is still the state on `ctx`, so recomputing off it
 * would otherwise just repeat the same boundary that already fired.
 */
function nextWakeAt(ctx: TickContext, acted: boolean): bigint {
  const { pool, currentEpoch, previousEpoch, openRound, lastRound, now } = ctx;
  const candidates: bigint[] = [now + SAFETY_INTERVAL_SECONDS];

  if (acted) candidates.push(now);
  if (openRound?.status === ROUND_STATUS.OPEN) {
    candidates.push(openRound.endsAt - pool.closeBuffer);
  }
  if (openRound?.status === ROUND_STATUS.REQUESTED) {
    candidates.push(openRound.requestedAt + pool.vrfTimeout);
  }
  if (currentEpoch) candidates.push(currentEpoch.endsAt);
  if (previousEpoch?.status === EPOCH_STATUS.REGISTERING) {
    candidates.push(registrationClosesAt(pool, previousEpoch));
  }
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    candidates.push(previousEpoch.requestedAt + pool.vrfTimeout);
  }
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    candidates.push(previousEpoch.drawnAt + pool.payoutTimeout);
  }
  if (
    pool.openRoundId === 0n &&
    lastRound &&
    lastRound.status !== ROUND_STATUS.VOIDED
  ) {
    candidates.push(lastRound.endsAt + REVEAL_SECONDS);
  }

  return candidates
    .filter((candidate) => candidate >= now)
    .reduce((soonest, candidate) => (candidate < soonest ? candidate : soonest));
}

/** Wall-clock ms until the scheduler should look again: the chain-seconds gap
 * to `deadline`, clamped to the safety interval and never negative. The clamp
 * is what keeps a fast local validator from under-serving the protocol: chain
 * time there can run ahead of wall time, so a raw `deadline - now` read as
 * wall-clock milliseconds would sleep past the point the safety tick exists
 * to catch. The caller re-reads the chain on every wake, so a clamp that
 * fires early costs one extra tick, never a stale one.
 */
export function msUntilWake(now: bigint, deadline: bigint): number {
  const chainSeconds = Number(deadline - now);
  const clamped = Math.min(Math.max(chainSeconds, 0), Number(SAFETY_INTERVAL_SECONDS));
  return clamped * 1000;
}

export async function runTick(ctx: TickContext): Promise<TickOutcome> {
  const decision = await decide(ctx);
  return { ...decision, nextWakeAt: nextWakeAt(ctx, decision.action !== null) };
}

async function decide(ctx: TickContext): Promise<Decision> {
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
        await ctx.send(await ctx.ix.voidRound(pool, openRound));
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
    // The accounts are closed now, but the indexer can keep (or briefly
    // resurrect) their rows for a few sweeps; tell the context so no later
    // tick resends settle_position and gets AccountNotInitialized.
    await ctx.forgetPositions(batch.map((position) => position.address));
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

    // The program refuses to close before this instant, so that everyone who
    // earned weight in the epoch has had the window to register.
    if (now < registrationClosesAt(pool, previousEpoch)) {
      return {
        action: null,
        registerCheck: { epochId: previousEpoch.epochId, empty: true },
      };
    }

    // The jackpot was funded at the start of the epoch (step 6b), so closing
    // snapshots whatever the vault holds now.
    await ctx.send(await ctx.ix.closeRegistration(pool, previousEpoch.epochId));
    return { action: "close_registration" };
  }

  // 5. Waiting on the draw's randomness.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    if (await ctx.fulfilled(previousEpoch.vrfSeed)) {
      await ctx.send(await ctx.ix.draw(pool, previousEpoch));
      return { action: "draw" };
    }
    if (now > previousEpoch.requestedAt + pool.vrfTimeout) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch));
      return { action: "rollover_epoch" };
    }
  }

  // 6. Drawn: pay whoever owns the interval the target landed in. A winner
  // whose token account is frozen or closed cannot be paid at all, so past
  // `payout_timeout` the epoch rolls over instead and the prize stays in the
  // vault for the next draw rather than stranding this epoch forever.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWN) {
    const timedOut = now > previousEpoch.drawnAt + pool.payoutTimeout;
    const winner = await ctx.winner(
      previousEpoch.epochId,
      previousEpoch.target,
    );
    if (winner) {
      try {
        await ctx.send(
          await ctx.ix.payout(pool, previousEpoch.epochId, new PublicKey(winner)),
        );
        return { action: "payout" };
      } catch (cause) {
        ctx.warn(
          `payout of epoch ${previousEpoch.epochId} to ${winner} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    if (timedOut) {
      await ctx.send(await ctx.ix.rolloverEpoch(pool, previousEpoch));
      return { action: "rollover_epoch" };
    }
    // Retried next tick rather than treated as an error: either the payout
    // will start landing, or no row covers the target yet because the
    // indexer has not caught up with the registrations.
  }

  // 6b. Pay out the withdrawals whose epoch has ended. Permissionless on the
  // program side, so the operator only pays the fee; it runs behind every
  // step above, which is what keeps a late return from the yield venue from
  // delaying a round, a draw or a payout. A vault too short to cover the
  // next batch reports the gap and waits for the admin to bring principal
  // back, retrying on the following tick.
  const due = await ctx.duePendingWithdrawals(pool.currentEpochId);
  let withdrawShortfall = 0n;
  if (due.length > 0) {
    try {
      await ctx.send(
        await ctx.ix.processWithdrawals(pool, due.slice(0, WITHDRAW_BATCH_SIZE)),
      );
      return { action: "process_withdraw", withdrawShortfall: 0n };
    } catch (cause) {
      if ((cause instanceof Error ? cause.message : "") !== SHORT_VAULT) throw cause;
      const owed = due.reduce((sum, entry) => sum + entry.amount, 0n);
      const held = await ctx.principalVaultBalance();
      withdrawShortfall = owed > held ? owed - held : 0n;
      ctx.warn(
        `principal vault holds ${held} against ${owed} of due withdrawals; short by ${withdrawShortfall}`,
      );
    }
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
    return { action: "create_round", withdrawShortfall };
  }

  return { ...NOTHING, withdrawShortfall };
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
  // A pending withdrawal the Player mirror still shows: either a depositor
  // cranked their own payout first (the UI offers that), or a second
  // request re-stamped `pending_epoch` to the epoch now running.
  "NothingPending",
  "NotPreviousEpoch",
  // The oracle answered between the tick's read and its void/rollover
  // landing, which is exactly the race the program guard exists for.
  "RandomnessAlreadyFulfilled",
  "RandomnessNotFulfilled",
  "RoundAlreadyOpen",
  "RoundNotEnded",
  "RoundNotOpen",
  "RoundNotRequested",
  "RoundNotSettled",
  "VrfTimeoutNotElapsed",
  "WithdrawalNotDue",
]);
