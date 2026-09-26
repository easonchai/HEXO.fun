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

import { TransactionPendingError } from "../chain/chain.service";
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
 * Markers in a failed `payout`'s message that mean this winner cannot be
 * paid at all, so step 6 warns and leaves the epoch Drawn for the
 * `payout_timeout` rollover to take. Every other failure is a real one and
 * has to reach `runOnce()`, or an RPC blip would look like an unpayable
 * winner and retry silently with no `lastError` until the timeout.
 *
 * `payout`'s non-House branch no longer has a `winner_token` account at all
 * (docs/plan/hexo-referrals ticket 02): the prize compounds into
 * `principal_vault`, a pool-owned PDA, so a non-House winner has nothing left
 * here that can independently be uninitialized, wrong-mint, wrong-owner or
 * frozen the way an arbitrary external token account could. These markers
 * now only have a real "unpayable winner" case on a House win, whose prize
 * still lands in the externally-owned `treasury`/`buyback_reserve` accounts
 * pinned at `create_pool` (see ADR 0010 and ticket 02's Comments). The
 * strings themselves are unchanged: they are Anchor's and SPL Token's own
 * generic account-constraint names, so they still match whichever account in
 * the transaction actually failed, House-only or not. SPL Token's codes are
 * in neither error table, so a frozen destination arrives as the raw custom
 * error code instead; both spellings are listed because a test names the
 * error and a validator names the code. Only SPL Token and this program run
 * in a payout transaction, and this program's codes start at 0x1770, so 0x11
 * can only be SPL Token's.
 */
const UNPAYABLE_WINNER = [
  "AccountNotInitialized",
  "ConstraintTokenMint",
  "ConstraintTokenOwner",
  "AccountFrozen",
  "custom program error: 0x11",
];

const cannotPayWinner = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return UNPAYABLE_WINNER.some((marker) => message.includes(marker));
};

/**
 * `grant_tickets`' operator-path cap errors (ticket 04). `computeBonuses`'
 * pool-wide scale-down is a best effort, not a guarantee: other grant
 * activity already counted against the epoch (an admin grant, an earlier
 * batch this same tick loop sent) can leave less headroom than it assumed
 * when a referrer's row was written.
 */
const GRANT_CAP_EXCEEDED = ["DailyPlayerGrantCapExceeded", "DailyPoolGrantCapExceeded"];

const capExceeded = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return GRANT_CAP_EXCEEDED.some((marker) => message.includes(marker));
};

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
   * Every qualifying referrer's daily bonus for `epochId` not yet sent
   * (docs/plan/hexo-referrals ticket 08), computed and recorded before it is
   * ever handed back, so a crash or restart resumes instead of double
   * granting. Empty once every grant for the epoch is sent or already
   * granted on chain.
   */
  referralGrantsDue(epochId: bigint): Promise<{ referrer: string; amount: bigint }[]>;
  /** Records the signature of a batch of grants just sent. */
  markReferralGrantsSent(
    epochId: bigint,
    referrers: readonly string[],
    txSig: string,
  ): Promise<void>;
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
  /**
   * Terminal Rounds with no Position left on them and not yet marked
   * closed (ops-and-envs ticket 08): what `close_round` may still reclaim
   * rent from. Oldest id first.
   */
  roundsToClose(): Promise<bigint[]>;
  /** A Round `close_round` was just sent for; keep it out of later
   *  `roundsToClose` results until the indexer mirrors `RoundClosed`. */
  forgetRound(id: bigint): void;
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

  // 2c. Close a terminal Round once nothing settled on it is still owed
  // (ops-and-envs ticket 08): reclaims its rent for the operator.
  // Permissionless on the program side and never refused in shutdown, so
  // this runs whether or not the pool is shut down.
  const [roundToClose] = await ctx.roundsToClose();
  if (roundToClose !== undefined) {
    await ctx.send(await ctx.ix.closeRound(pool, roundToClose));
    // The account is closed now, but the indexer mirrors that off the
    // RoundClosed event asynchronously; tell the context so an immediate
    // next tick does not resend close_round and get AccountNotInitialized.
    ctx.forgetRound(roundToClose);
    return { action: "close_round" };
  }

  // 3. Begin Epoch: only once the Round and the sweep above are clear, and
  // the previous Epoch (if any) has actually finished, so no Epoch is ever
  // left two behind. Refused in shutdown, so the epoch loop stops here
  // once the pool is shut down (spec.md "Shutdown").
  const epochEnded =
    pool.currentEpochId === 0n ||
    (currentEpoch !== null && now >= currentEpoch.endsAt);
  const previousDone =
    previousEpoch === null ||
    previousEpoch.status === EPOCH_STATUS.PAID ||
    previousEpoch.status === EPOCH_STATUS.ROLLED_OVER;
  if (!pool.shutdown && epochEnded && pool.openRoundId === 0n && previousDone) {
    await ctx.send(await ctx.ix.beginEpoch(pool));
    return { action: "begin_epoch" };
  }

  // 3b. Referral bonuses (ticket 08): once per epoch, right after
  // begin_epoch, credit each qualifying referrer's daily bonus for the
  // epoch that just began, so it counts for the full day. referralGrantsDue
  // computes and records the whole epoch's bonuses the first time it is
  // asked (the ReferralGrant table's own uniqueness makes that idempotent
  // across restarts), then hands back whatever is still unsent; batched the
  // same way step 4 batches registrations. `grant_tickets` is refused in
  // shutdown (ops-and-envs ticket 02), so this stops with the rest of the
  // epoch loop.
  if (!pool.shutdown && currentEpoch) {
    const grants = await ctx.referralGrantsDue(currentEpoch.epochId);
    if (grants.length > 0) {
      const batch = grants.slice(0, BATCH_SIZE);
      const referrers = batch.map((grant) => grant.referrer);
      try {
        const signature = await ctx.send(await ctx.ix.grantTickets(pool, batch));
        await ctx.markReferralGrantsSent(currentEpoch.epochId, referrers, signature);
        return { action: "grant_tickets" };
      } catch (cause) {
        if (cause instanceof TransactionPendingError) {
          // The send's bounded wait ran out with the blockhash still live
          // (pre-mainnet review): the grant may land in the next minute,
          // and `grant_tickets` is not idempotent on chain, so the batch is
          // recorded as sent under that signature before the tick fails.
          // Otherwise `referralGrantsDue` hands the same referrers back
          // next tick and they are granted twice; the Player mirror's
          // `bonusEpoch` check there stays the backstop for a crash between
          // this write and the send landing. If the transaction never lands
          // after all, these referrers miss the day's bonus rather than
          // risk a double grant. Rethrown, like every other send failure:
          // the tick still reports it in `lastError`.
          await ctx.markReferralGrantsSent(currentEpoch.epochId, referrers, cause.signature);
          throw cause;
        }
        if (!capExceeded(cause)) throw cause;
        // referralGrantsDue re-clamps every grant against the freshest
        // Player data it has before handing it back, so this should now
        // only fire on drift the indexer has not caught up with yet (a very
        // recent withdrawal), not the stale-forever case it used to. The
        // error itself does not say which referrer in the batch tripped it,
        // so every one of them is logged with the amount that was tried;
        // ponytail: still one atomic transaction, so all of them wait for
        // the next tick's freshly re-clamped retry rather than just the
        // culprit. Splitting the batch on a repeated failure is the upgrade
        // path if that ever bites in practice.
        ctx.warn(
          `referral bonus grant for epoch ${currentEpoch.epochId} exceeded the on-chain cap ` +
            `for one of [${batch.map((grant) => `${grant.referrer}:${grant.amount}`).join(", ")}]: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
        );
      }
    }
  }

  // 4. The ended epoch is taking registrations: crank them, then fund the
  // jackpot and close once the list has come back empty on two consecutive
  // ticks for this Epoch, so a player who registered right before `ends_at`
  // gets one more indexer sync window before being counted out.
  // `close_registration` is refused in shutdown, and `pool.currentEpochId`
  // never advances once `begin_epoch` has stopped, so this whole step
  // stops too rather than spending forever on a registration that can
  // never close (ops-and-envs ticket 02).
  if (!pool.shutdown && previousEpoch?.status === EPOCH_STATUS.REGISTERING) {
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

  // 5. Waiting on the draw's randomness. `draw` is refused in shutdown
  // (ops-and-envs ticket 02); `rollover_epoch` is not, so a Drawing epoch
  // still moves on past its `vrf_timeout` instead of waiting forever.
  if (previousEpoch?.status === EPOCH_STATUS.DRAWING) {
    if (!pool.shutdown && (await ctx.fulfilled(previousEpoch.vrfSeed))) {
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
        if (!cannotPayWinner(cause)) throw cause;
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
    const batch = due.slice(0, WITHDRAW_BATCH_SIZE);
    try {
      await ctx.send(await ctx.ix.processWithdrawals(pool, batch));
      return { action: "process_withdraw", withdrawShortfall: 0n };
    } catch (cause) {
      if ((cause instanceof Error ? cause.message : "") !== SHORT_VAULT) throw cause;
      // The batch that was actually tried, not the whole queue: the program
      // refused to pay these four, and sizing the gap against a queue of
      // forty would ask the admin to bring back ten times the principal the
      // next transaction needs.
      const owed = batch.reduce((sum, entry) => sum + entry.amount, 0n);
      const held = await ctx.principalVaultBalance();
      withdrawShortfall = owed > held ? owed - held : 0n;
      ctx.warn(
        `principal vault holds ${held} against ${owed} of due withdrawals; short by ${withdrawShortfall}`,
      );
    }
  }

  // 7. Open the next round, if a whole one still fits in this epoch, and the
  // previous Round's reveal has had time to play: no viewer should see a new
  // countdown while the last Round's laser is still landing. `create_round`
  // is refused in shutdown like every other inflow (spec.md "Shutdown"), so
  // the gate here keeps a shut-down pool from paying a refused send's fee
  // every tick (pre-mainnet review).
  const lastRound = ctx.lastRound;
  const revealDone =
    lastRound === null ||
    lastRound.status === ROUND_STATUS.VOIDED ||
    now >= lastRound.endsAt + REVEAL_SECONDS;
  if (
    !pool.shutdown &&
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
  // `close_round` resent for a Round a previous, now-restarted process
  // already closed (ops-and-envs ticket 08): the in-memory `forgetRound`
  // memory does not survive a restart, and the indexer's own mirror of
  // `RoundClosed` may not have landed yet either, so `roundsToClose` can
  // still hand back an id whose account is already gone on chain.
  "AccountNotInitialized",
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
  // The admin's shutdown() landed between this tick's read of `pool.shutdown`
  // and one of the steps it gates confirming (ops-and-envs ticket 02): the
  // gates above make this rare, not impossible, and the next tick reads the
  // now-shut-down pool and stops asking.
  "PoolShutDown",
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
