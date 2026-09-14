// The crank (spec §3.4). This file is plumbing only: read the chain, hand
// `runTick` everything it needs, write down what happened, then sleep until
// the deadline it returned instead of ticking on a fixed interval (ticket 03).
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  clockUnixTimestamp,
  decodeEpoch,
  decodePool,
  decodeRound,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { INDEXER_QUERIES, type IndexerQueries } from "./indexer-queries";
import { OperatorInstructions } from "./instructions";
import { SparringService } from "./sparring";
import {
  EXPECTED_ERRORS,
  msUntilWake,
  runTick,
  SAFETY_INTERVAL_SECONDS,
  type RegisterCheck,
  type TickContext,
  type TickOutcome,
} from "./tick";
import { isFulfilled, randomnessAddress } from "./vrf";

/** How long a settled Position's address is remembered; well past any sweep lag. */
const SETTLED_MEMORY_MS = 5 * 60_000;
/** The slow safety net alongside the deadline-driven sleep (ticket 03): runs
 *  regardless, so a mis-computed deadline degrades to "checked on this
 *  cadence" rather than a stall. Same cadence `nextWakeAt` falls back to. */
const SAFETY_INTERVAL_MS = Number(SAFETY_INTERVAL_SECONDS) * 1000;

/** `runTick`'s outcome plus the wall-clock ms until the scheduler should look
 *  again: the chain-time deadline converted once, here, so both the DB write
 *  and the self-rescheduling timer agree on the same number. */
interface OperatorTickResult extends TickOutcome {
  readonly waitMs: number;
}

@Injectable()
export class OperatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperatorService.name);
  private readonly instructions: OperatorInstructions;
  private readonly mint: PublicKey;
  private readonly testVrf: boolean;
  /** Single-flight: an overrunning tick skips the one that would overlap it. */
  private running = false;
  /** The self-rescheduling deadline sleep; cleared and replaced on every
   *  tick, on `wake()`, and on shutdown. */
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** Ticket 04: whether `playersToRegister` came back empty last tick, and
   *  for which Epoch, so step 4 can require two consecutive empty ticks. */
  private lastRegisterCheck: RegisterCheck | null = null;
  /** Step 6b's tries against one Epoch; resets when the Epoch changes. */
  private topUp: { epochId: bigint; attempts: number } | null = null;
  /**
   * Positions this operator has already settled, by address, with when. The
   * indexer's sweep can re-insert one for a few seconds after the close: the
   * sync fired by the settle's own log can snapshot the chain before the
   * close is visible. A closed Position never comes back, so remembering the
   * address is always safe; the timestamp only bounds the map.
   */
  private settled = new Map<string, number>();

  constructor(
    private readonly chain: ChainService,
    private readonly prisma: PrismaService,
    @Inject(INDEXER_QUERIES) private readonly indexer: IndexerQueries,
    private readonly sparring: SparringService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.mint = new PublicKey(config.get("HEXUSDC_MINT", { infer: true }));

    // Which randomness account the program expects depends on how it was
    // compiled, and the IDL is the only thing that travels with the build.
    this.testVrf = chain.program.idl.instructions.some(
      (ix) => ix.name === "testFulfill",
    );
    if (this.testVrf) {
      this.logger.warn(
        "program is a test-vrf build: randomness is fabricated, not ORAO's",
      );
    }

    this.instructions = new OperatorInstructions(
      chain.program,
      chain.programId,
      chain.keypair.publicKey,
      this.testVrf,
    );
  }

  onModuleInit(): void {
    void this.runAndScheduleNext();
  }

  onModuleDestroy(): void {
    this.clearDeadlineTimer();
  }

  /** The slow net (spec.md "Operator becomes deadline-driven"): runs on its
   *  own cadence regardless of the deadline timer, so a mis-computed deadline
   *  degrades to a delay rather than a stall. */
  @Interval(SAFETY_INTERVAL_MS)
  async safetyTick(): Promise<void> {
    await this.runAndScheduleNext();
  }

  /** For a subscription (ticket 04) to call once it notices something the
   *  last computed deadline did not account for: cancels the pending sleep
   *  and looks now instead of waiting for it. */
  wake(): void {
    this.clearDeadlineTimer();
    void this.runAndScheduleNext();
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** Runs one tick, then sleeps until its returned deadline. Every entry
   *  point (boot, the safety tick, `wake()`) funnels through here so only one
   *  sleep is ever pending. */
  private async runAndScheduleNext(): Promise<void> {
    this.clearDeadlineTimer();
    const result = await this.tick();
    // null: another caller already owns `running` and will reschedule once
    // it finishes, so scheduling here too would double the pending sleep.
    if (result === null) return;
    this.deadlineTimer = setTimeout(
      () => void this.runAndScheduleNext(),
      result.waitMs,
    );
  }

  /** Single-flight: an overrunning tick is skipped rather than queued behind
   *  itself. Exposed for the localnet test, which drives it directly. */
  async tick(): Promise<OperatorTickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  /** One pass of spec §3.4. Never throws: a failed tick is state, not a crash. */
  async runOnce(): Promise<OperatorTickResult> {
    let ctx: TickContext | undefined;
    try {
      ctx = await this.context();
      const outcome = await runTick(ctx);
      if (outcome.registerCheck) this.lastRegisterCheck = outcome.registerCheck;
      if (outcome.action) this.logger.log(`sent ${outcome.action}`);
      // A new Round exists on chain now; the Sparring player buys in without
      // waiting for its own (much slower) safety tick to notice.
      if (outcome.action === "create_round") this.sparring.wake();
      const waitMs = msUntilWake(ctx.now, outcome.nextWakeAt);
      await this.writeState(outcome, null, waitMs);
      return { ...outcome, waitMs };
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error(String(cause), { cause });
      // A failed read never produced a deadline to convert; back off by the
      // safety interval rather than retrying immediately.
      const waitMs = SAFETY_INTERVAL_MS;
      const nextWakeAt = (ctx?.now ?? 0n) + SAFETY_INTERVAL_SECONDS;
      if (EXPECTED_ERRORS.has(error.message)) {
        // Lost a race with someone else's transaction (or our own, confirmed
        // after we read). The next tick reads the newer state and moves on.
        this.logger.debug(`skipped: ${error.message}`);
        await this.writeState({ action: null }, null, waitMs);
        return { action: null, nextWakeAt, waitMs };
      }
      // Anchor and web3 hang the program logs off the cause; they name the
      // instruction and the account that failed, which the message does not.
      const logs = (error.cause as { logs?: string[] } | undefined)?.logs;
      this.logger.error(
        `tick failed: ${error.message}${logs ? `\n${logs.join("\n")}` : ""}`,
        error.stack,
      );
      await this.writeState({ action: null }, error.message, waitMs);
      return { action: null, nextWakeAt, waitMs };
    }
  }

  private async context(): Promise<TickContext> {
    const poolAddress = this.chain.poolAddress();
    const [poolInfo, clockInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        poolAddress,
        SYSVAR_CLOCK_PUBKEY,
      ]);
    if (!poolInfo) {
      throw new Error(
        `pool ${poolAddress.toBase58()} does not exist; run bootstrap first`,
      );
    }
    const pool = decodePool(this.chain.program, poolAddress, poolInfo.data);
    const now = clockUnixTimestamp(clockInfo?.data);

    const { currentEpoch, previousEpoch, openRound, lastRound } =
      await this.readCycle(pool);

    return {
      now,
      pool,
      currentEpoch,
      previousEpoch,
      openRound,
      lastRound,
      ix: this.instructions,
      lastRegisterCheck: this.lastRegisterCheck,
      topUpAttempts:
        this.topUp?.epochId === pool.currentEpochId ? this.topUp.attempts : 0,
      fulfilled: (seed) => this.fulfilled(seed),
      authorityBalance: () => this.authorityBalance(),
      jackpotBalance: () => this.jackpotBalance(),
      recordTopUpAttempt: (epochId) => {
        const attempts =
          this.topUp?.epochId === epochId ? this.topUp.attempts + 1 : 1;
        this.topUp = { epochId, attempts };
      },
      playersToRegister: (epochId) => this.indexer.playersToRegister(epochId),
      unsettledPositions: async () =>
        (await this.indexer.unsettledPositions()).filter(
          (position) => !this.settled.has(position.address),
        ),
      forgetPositions: async (addresses) => {
        const now = Date.now();
        for (const [address, at] of this.settled) {
          if (now - at > SETTLED_MEMORY_MS) this.settled.delete(address);
        }
        for (const address of addresses) this.settled.set(address, now);
      },
      winner: (epochId, target) => this.winner(epochId, target),
      send: (instructions) => this.chain.send(instructions),
    };
  }

  /** Current epoch, previous epoch, open round and last round in one
   *  `getMultipleAccounts`. */
  private async readCycle(pool: PoolState): Promise<{
    currentEpoch: EpochState | null;
    previousEpoch: EpochState | null;
    openRound: RoundState | null;
    lastRound: RoundState | null;
  }> {
    const wanted: PublicKey[] = [];
    const currentIndex =
      pool.currentEpochId > 0n
        ? wanted.push(this.chain.epochAddress(pool.currentEpochId)) - 1
        : -1;
    const previousIndex =
      pool.currentEpochId > 1n
        ? wanted.push(this.chain.epochAddress(pool.currentEpochId - 1n)) - 1
        : -1;
    const roundIndex =
      pool.openRoundId > 0n
        ? wanted.push(this.chain.roundAddress(pool.openRoundId)) - 1
        : -1;
    // `nextRoundId - 1` is the most recently created Round, open or already
    // terminal; equal to `openRoundId` while one is open. Round ids start at
    // 1, so `nextRoundId <= 1` means none has ever been created.
    const lastRoundIndex =
      pool.nextRoundId > 1n
        ? wanted.push(this.chain.roundAddress(pool.nextRoundId - 1n)) - 1
        : -1;
    if (wanted.length === 0) {
      return {
        currentEpoch: null,
        previousEpoch: null,
        openRound: null,
        lastRound: null,
      };
    }

    const infos = await this.chain.connection.getMultipleAccountsInfo(wanted);
    const epochAt = (index: number): EpochState | null => {
      const data = index >= 0 ? infos[index]?.data : undefined;
      return data ? decodeEpoch(this.chain.program, data) : null;
    };
    const roundAt = (index: number): RoundState | null => {
      const data = index >= 0 ? infos[index]?.data : undefined;
      return data ? decodeRound(this.chain.program, data) : null;
    };

    return {
      currentEpoch: epochAt(currentIndex),
      previousEpoch: epochAt(previousIndex),
      openRound: roundAt(roundIndex),
      lastRound: roundAt(lastRoundIndex),
    };
  }

  private async fulfilled(seed: Uint8Array): Promise<boolean> {
    const address = randomnessAddress(this.chain.programId, seed, this.testVrf);
    const info = await this.chain.connection.getAccountInfo(address);
    return isFulfilled(info?.data);
  }

  private async authorityBalance(): Promise<bigint> {
    const address = getAssociatedTokenAddressSync(
      this.mint,
      this.chain.keypair.publicKey,
    );
    try {
      return (await getAccount(this.chain.connection, address)).amount;
    } catch (cause) {
      if (cause instanceof TokenAccountNotFoundError) {
        throw new Error(
          `authority hexUSDC account ${address.toBase58()} does not exist; run bootstrap first`,
          { cause },
        );
      }
      throw cause;
    }
  }

  private async jackpotBalance(): Promise<bigint> {
    try {
      return (
        await getAccount(this.chain.connection, this.chain.jackpotVaultAddress())
      ).amount;
    } catch (cause) {
      if (cause instanceof TokenAccountNotFoundError) {
        throw new Error(
          `jackpot vault ${this.chain.jackpotVaultAddress().toBase58()} does not exist; run bootstrap first`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /** The registered interval containing `target` (spec §3.4 step 6). */
  private async winner(
    epochId: bigint,
    target: bigint,
  ): Promise<string | null> {
    const player = await this.prisma.player.findFirst({
      where: {
        regEpoch: epochId,
        regStart: { lte: target.toString() },
        regEnd: { gt: target.toString() },
      },
      select: { owner: true },
    });
    return player?.owner ?? null;
  }

  /**
   * The clock is read here, not at the start of the tick: `outcome` only
   * exists once `ctx.send` has resolved, so this timestamp reflects when the
   * transaction actually confirmed rather than when the tick began reading
   * state. A slow devnet confirmation must not read as a stall (ticket 01).
   *
   * `nextWakeAt` is written from the same wall clock, `waitMs` past it: a
   * wall-clock value alongside a wall-clock `lastTickAt`, so `GET /status`
   * and the web summary never have to reason about chain time (ticket 03).
   */
  private async writeState(
    outcome: Pick<TickOutcome, "action" | "progress">,
    error: string | null,
    waitMs: number,
  ): Promise<void> {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const fields = {
      lastTickAt: nowSeconds,
      nextWakeAt: nowSeconds + BigInt(Math.round(waitMs / 1000)),
      lastError: error,
      ...(outcome.action === null ? {} : { lastAction: outcome.action }),
      ...(outcome.progress === undefined
        ? {}
        : {
            registeredCount: outcome.progress.count,
            registeredTotal: outcome.progress.total,
          }),
    };
    await this.prisma.operatorState.upsert({
      where: { id: 1 },
      create: { id: 1, ...fields },
      update: fields,
    });
  }
}
