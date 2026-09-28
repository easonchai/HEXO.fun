// Step selection is the whole operator: given a state, exactly one thing
// should happen. The instructions built here are the real ones, decoded back
// out of the recorded transaction, so a wrong account list still shows up.
import {
  AnchorProvider,
  BorshInstructionCoder,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import { poolAddress } from "../chain/pda";
import {
  EPOCH_STATUS,
  ROUND_STATUS,
  clockUnixTimestamp,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";
import {
  DRAWN_UNPAID_ALERT_SECONDS,
  EXPECTED_ERROR_REPEAT_LIMIT,
  msUntilWake,
  runTick,
  SAFETY_INTERVAL_SECONDS,
  WITHDRAW_BATCH_SIZE,
  WITHDRAW_FAILURE_LIMIT,
  type TickContext,
  type WithdrawState,
} from "./tick";
import { isFulfilled, keccak256, randomnessAddress, vrfSeed } from "./vrf";

const AUTHORITY = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);

// No RPC is reached: every account is passed explicitly, so Anchor never has
// to resolve one.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);
const coder = new BorshInstructionCoder(idl);
const instructions = new OperatorInstructions(
  program,
  PROGRAM_ID,
  AUTHORITY,
  true,
);

/** Readable name for one recorded instruction, whoever owns it. */
function label(ix: TransactionInstruction): string {
  if (ix.programId.equals(PROGRAM_ID)) {
    return coder.decode(ix.data)?.name ?? "unknown";
  }
  if (ix.programId.equals(TOKEN_PROGRAM_ID)) return `token:${ix.data[0]}`;
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    return `ata:${ix.data[0]}`;
  return ix.programId.toBase58();
}

const CREATE_ATA_IDEMPOTENT = "ata:1";

const NOW = 1_800_000_000n;

const pool = (over: Partial<PoolState> = {}): PoolState => ({
  address: POOL,
  admin: AUTHORITY,
  operator: AUTHORITY,
  acceptedMint: MINT,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: 86_400n,
  roundSeconds: 60n,
  closeBuffer: 0n,
  vrfTimeout: 120n,
  // No wait by default, so every test that is not about the window keeps the
  // timing it had before the window existed.
  registrationWindow: 0n,
  payoutTimeout: 86_400n,
  paused: false,
  currentEpochId: 2n,
  nextRoundId: 4n,
  openRoundId: 3n,
  totalPrincipal: 1_000_000_000n,
  shutdown: false,
  gamePaused: false,
  jackpotPaused: false,
  ...over,
});

const epoch = (over: Partial<EpochState> = {}): EpochState => ({
  epochId: 2n,
  startsAt: NOW - 100n,
  endsAt: NOW + 86_300n,
  status: EPOCH_STATUS.OPEN,
  registeredCount: 0,
  jackpotAmount: 0n,
  vrfSeed: new Uint8Array(32).fill(3),
  requestedAt: 0n,
  target: 0n,
  drawnAt: 0n,
  registrationOpenedAt: 0n,
  ...over,
});

/** The epoch that has ended and is taking registrations, which is what
 *  `previousEpoch` holds for steps 4 and 5. Its `endsAt` is behind `now`:
 *  `begin_epoch` is what moves an epoch into this status, and it will not
 *  run before the epoch has ended. */
const registering = (over: Partial<EpochState> = {}): EpochState =>
  epoch({
    epochId: 1n,
    status: EPOCH_STATUS.REGISTERING,
    endsAt: NOW - 100n,
    ...over,
  });

const round = (over: Partial<RoundState> = {}): RoundState => ({
  roundId: 3n,
  endsAt: NOW + 30n,
  status: ROUND_STATUS.OPEN,
  vrfSeed: new Uint8Array(32).fill(5),
  requestedAt: 0n,
  ...over,
});

interface Recorder {
  ctx: TickContext;
  sent: TransactionInstruction[][];
  warned: string[];
  markedSent: { epochId: bigint; referrers: string[]; txSig: string }[];
  forgottenRegistered: string[][];
}

function context(over: Partial<TickContext> = {}): Recorder {
  const sent: TransactionInstruction[][] = [];
  const warned: string[] = [];
  const markedSent: { epochId: bigint; referrers: string[]; txSig: string }[] = [];
  const forgottenRegistered: string[][] = [];
  const ctx: TickContext = {
    now: NOW,
    pool: pool(),
    // A healthy mid-round state: epoch running, previous one already paid,
    // round open and not yet over.
    currentEpoch: epoch(),
    previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
    openRound: round(),
    // Null by default: only the step 7 tests below care, and null means "no
    // previous round", which never delays opening the next one.
    lastRound: null,
    ix: instructions,
    lastRegisterCheck: null,
    lastWithdrawState: null,
    // Fresh and caught up by default, so step 4's close_registration gate
    // stays quiet in every test that is not about it.
    indexerCursor: { ageSeconds: 0, updatedAt: NOW },
    indexerFreshThresholdSeconds: 60n,
    lastExpectedErrors: new Map(),
    // Unconfigured by default (ticket 05): begin_epoch is never withheld in
    // any test that is not about the launch window.
    launchAt: null,
    fulfilled: async () => false,
    principalVaultBalance: async () => 0n,
    // Empty by default so step 6b stays quiet in every test that is not about it.
    duePendingWithdrawals: async () => [],
    playersToRegister: async () => [],
    forgetRegistered: async (owners) => {
      forgottenRegistered.push([...owners]);
    },
    unsettledPositions: async () => [],
    forgetPositions: async () => {},
    // Empty by default so step 2c stays quiet in every test that is not about it.
    roundsToClose: async () => [],
    forgetRound: () => {},
    winner: async () => null,
    winnerOnChain: async () => null,
    // Empty by default so step 3b stays quiet in every test that is not about it.
    referralGrantsDue: async () => [],
    markReferralGrantsSent: async (epochId, referrers, txSig) => {
      markedSent.push({ epochId, referrers: [...referrers], txSig });
    },
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    warn: (message) => warned.push(message),
    ...over,
  };
  return { ctx, sent, warned, markedSent, forgottenRegistered };
}

/** Runs one tick and returns the labels of the single transaction it sent. */
async function tickLabels(over: Partial<TickContext> = {}): Promise<{
  action: string | null;
  labels: string[];
  transactions: number;
  nextWakeAt: bigint;
  withdrawShortfall: bigint | undefined;
}> {
  const { ctx, sent } = context(over);
  const outcome = await runTick(ctx);
  return {
    action: outcome.action,
    labels: (sent[0] ?? []).map(label),
    transactions: sent.length,
    nextWakeAt: outcome.nextWakeAt,
    withdrawShortfall: outcome.withdrawShortfall,
  };
}

describe("runTick", () => {
  it("sends nothing on a healthy mid-round state", async () => {
    const result = await tickLabels();
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
    // Round end minus the close buffer is the closest of the round end,
    // epoch end and safety-interval candidates.
    expect(result.nextWakeAt).toBe(NOW + 30n);
  });

  // --- 1. Round: open-and-ended, requested, or voided. Runs before any Epoch
  // step, so a Round can never straddle the boundary step 3 might open.

  it("1. requests randomness for a round that has ended", async () => {
    const result = await tickLabels({ openRound: round({ endsAt: NOW }) });
    expect(result.labels).toEqual(["request_round_randomness"]);
    // Acted this tick: look again immediately rather than waiting on a
    // boundary that already fired.
    expect(result.nextWakeAt).toBe(NOW);
  });

  it("1. does not request randomness one second before the close", async () => {
    const result = await tickLabels({
      pool: pool({ closeBuffer: 5n }),
      openRound: round({ endsAt: NOW + 6n }),
    });
    expect(result.transactions).toBe(0);
    // The close buffer is part of the deadline: endsAt minus closeBuffer.
    expect(result.nextWakeAt).toBe(NOW + 1n);
  });

  it("1. requests randomness at the close, `closeBuffer` seconds before `endsAt`", async () => {
    const result = await tickLabels({
      pool: pool({ closeBuffer: 5n }),
      openRound: round({ endsAt: NOW + 5n }),
    });
    expect(result.labels).toEqual(["request_round_randomness"]);
  });

  it("1. settles a requested round once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 5n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["settle_round"]);
  });

  it("1. voids a requested round after the timeout", async () => {
    const result = await tickLabels({
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["void_round"]);
  });

  it("1. requests round randomness before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: round({ endsAt: NOW }),
    });
    expect(result.labels).toEqual(["request_round_randomness"]);
    expect(result.action).toBe("request_round_randomness");
  });

  it("1. settles a requested round before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: round({
        status: ROUND_STATUS.REQUESTED,
        requestedAt: NOW - 5n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["settle_round"]);
  });

  // --- 2. Sweep: unsettled Positions on any terminal Round, not just the
  // newest.

  it("2. settles up to eight leftover positions per transaction", async () => {
    const positions = Array.from({ length: 9 }, () => ({
      address: Keypair.generate().publicKey.toBase58(),
      owner: Keypair.generate().publicKey.toBase58(),
      roundId: 3n,
    }));
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => positions,
    });
    expect(result.labels).toEqual(Array(8).fill("settle_position"));
    expect(result.action).toBe("settle_position");
  });

  it("2. forgets the positions it settled, and only those, once the send confirms", async () => {
    const positions = Array.from({ length: 9 }, () => ({
      address: Keypair.generate().publicKey.toBase58(),
      owner: Keypair.generate().publicKey.toBase58(),
      roundId: 3n,
    }));
    const forgotten: string[][] = [];
    await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => positions,
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
    });
    expect(forgotten).toEqual([positions.slice(0, 8).map((position) => position.address)]);
  });

  it("2. (ticket 06) keeps the rows when the send fails, records the error, and lets the tick continue", async () => {
    const forgotten: string[][] = [];
    const { ctx } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "settle_position")) {
          throw new Error("blockhash expired");
        }
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(forgotten).toEqual([]);
    expect(outcome.stepError).toMatch(/blockhash expired/);
    // Falls through to open the next round instead of aborting the tick.
    expect(outcome.action).toBe("create_round");
  });

  it("2. (ticket 12) an AccountNotInitialized race is treated as already settled", async () => {
    const address = Keypair.generate().publicKey.toBase58();
    const forgotten: string[][] = [];
    const { ctx } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        { address, owner: Keypair.generate().publicKey.toBase58(), roundId: 3n },
      ],
      forgetPositions: async (addresses) => {
        forgotten.push(addresses);
      },
      send: async () => {
        throw new Error("AccountNotInitialized");
      },
    });
    const outcome = await runTick(ctx);
    expect(forgotten).toEqual([[address]]);
    expect(outcome.stepError).toBeUndefined();
  });

  it("2. (ticket 12) an expected race is swallowed twice, then escalates to a recorded error", async () => {
    const positions = () => [
      {
        address: Keypair.generate().publicKey.toBase58(),
        owner: Keypair.generate().publicKey.toBase58(),
        roundId: 3n,
      },
    ];
    let expectedErrors: ReadonlyMap<string, number> = new Map();
    let outcome;
    for (let i = 0; i < EXPECTED_ERROR_REPEAT_LIMIT; i += 1) {
      const { ctx } = context({
        pool: pool({ openRoundId: 0n }),
        openRound: null,
        lastExpectedErrors: expectedErrors,
        unsettledPositions: async () => positions(),
        send: async (ixs) => {
          if (ixs.some((ix) => label(ix) === "settle_position")) {
            throw new Error("RoundNotSettled");
          }
          return "signature";
        },
      });
      outcome = await runTick(ctx);
      expectedErrors = outcome.expectedErrors ?? expectedErrors;
    }
    expect(outcome?.stepError).toMatch(/RoundNotSettled/);
  });

  it("2. sweeps a leftover position before begin_epoch when the epoch has also ended", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
    });
    expect(result.labels).toEqual(["settle_position"]);
    expect(result.action).toBe("settle_position");
  });

  it("2. sweeps an older round's position while a newer round is open", async () => {
    // Default openRound is round 3, open; the leftover position sits on
    // round 1, two ids behind, and gets swept anyway.
    const result = await tickLabels({
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 1n,
        },
      ],
    });
    expect(result.labels).toEqual(["settle_position"]);
  });

  // --- 2c. Close a terminal Round once nothing settled on it is still owed
  // (ops-and-envs ticket 08): reclaims its rent for the operator.

  it("2c. closes a round once roundsToClose names one", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      roundsToClose: async () => [7n],
    });
    expect(result.labels).toEqual(["close_round"]);
    expect(result.action).toBe("close_round");
  });

  it("2c. forgets the round it closed once the send confirms", async () => {
    const forgotten: bigint[] = [];
    await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      roundsToClose: async () => [7n],
      forgetRound: (id) => forgotten.push(id),
    });
    expect(forgotten).toEqual([7n]);
  });

  it("2c. sweeps leftover positions before closing any round", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async () => [
        {
          address: Keypair.generate().publicKey.toBase58(),
          owner: Keypair.generate().publicKey.toBase58(),
          roundId: 3n,
        },
      ],
      roundsToClose: async () => [7n],
    });
    expect(result.action).toBe("settle_position");
  });

  it("2c. closes a round even while the pool is shut down: close_round is permissionless throughout", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, shutdown: true }),
      openRound: null,
      currentEpoch: null,
      previousEpoch: null,
      roundsToClose: async () => [7n],
    });
    expect(result.action).toBe("close_round");
  });

  // --- 3. Begin Epoch: only once the Round and sweep above are clear, and
  // the previous Epoch (if any) is Paid or Rolled over.

  it("3. begins the first epoch when the pool has none", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  it("3. begins the next epoch once it has ended, the round is clear, and the previous epoch is paid", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("3. does not begin the epoch while the previous epoch is still registering", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      previousEpoch: registering(),
      playersToRegister: async () => [owner],
    });
    expect(result.action).not.toBe("begin_epoch");
    expect(result.labels).toEqual(["register"]);
  });

  // --- 3 (ticket 05): LAUNCH_AT holds back only the Pool's very first
  // begin_epoch (no Epoch yet), so deposits can open before the launch time
  // with nothing else in the tick changing.

  it("3. a future launch time withholds the first begin_epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW + 3_600n,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
    // Further off than the safety interval, so the safety tick is still the
    // soonest thing that could re-check, same as any other far-off deadline.
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  it("3. sleeps straight to the launch time once it is closer than the safety interval", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW + 10n,
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 10n);
  });

  it("3. a past launch time begins the first epoch", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      launchAt: NOW - 1n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  // game-jackpot-pause ticket 02: begin_epoch is refused under jackpot
  // pause, and a new pool starts that way.
  it("3. does not begin the first epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n, jackpotPaused: true }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. does not begin the next epoch while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, jackpotPaused: true }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("3. LAUNCH_AT does not hold back a later epoch once one already exists", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW }),
      openRound: null,
      launchAt: NOW + 3_600n,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  // --- 3b. Referral bonuses (docs/plan/hexo-referrals ticket 08): grants
  // due for the epoch that just began, batched like registration.

  it("3b. grants up to eight referral bonuses per transaction and records the signature", async () => {
    const referrers = Array.from({ length: 10 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    const { ctx, sent, markedSent } = context({
      referralGrantsDue: async (epochId) => {
        expect(epochId).toBe(2n); // currentEpoch's id, not previousEpoch's
        return referrers.map((referrer) => ({ referrer, amount: 1_000_000n }));
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("grant_tickets");
    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(Array(8).fill("grant_tickets"));
    expect(markedSent).toEqual([
      { epochId: 2n, referrers: referrers.slice(0, 8), txSig: "signature" },
    ]);
  });

  it("3b. does nothing once every referral bonus for the epoch is granted", async () => {
    const result = await tickLabels({ referralGrantsDue: async () => [] });
    expect(result.action).toBeNull();
  });

  it("3b. does nothing before the first epoch has begun", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
      referralGrantsDue: () => {
        throw new Error("must not be asked before an epoch exists");
      },
    });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("3b. logs a warning and falls through instead of throwing when the on-chain cap is exceeded", async () => {
    const referrer = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      referralGrantsDue: async () => [{ referrer, amount: 1_000_000n }],
      send: async () => {
        throw new Error("custom program error: DailyPoolGrantCapExceeded");
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/DailyPoolGrantCapExceeded/);
    // The error itself does not say which referrer in the batch tripped it,
    // so every one of them (and the amount tried) is named in the log.
    expect(warned[0]).toContain(`${referrer}:1000000`);
  });

  it("3b. does not grant tickets once the pool is shut down: grant_tickets is refused", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      referralGrantsDue: () => {
        throw new Error("must not be asked while shut down");
      },
    });
    expect(result.action).toBeNull();
  });

  // game-jackpot-pause ticket 02: grant_tickets is refused under jackpot pause.
  it("3b. does not grant tickets while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ jackpotPaused: true }),
      referralGrantsDue: () => {
        throw new Error("must not be asked while the jackpot is paused");
      },
    });
    expect(result.action).toBeNull();
  });

  // --- 4. Register / close registration. Closing waits for two consecutive
  // empty ticks (spec §3.4, ticket 04) so an indexer that has not caught up
  // with a last-second deposit gets one more chance.

  it("4. registers up to eight players per transaction", async () => {
    const owners = Array.from({ length: 10 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    const { ctx, sent } = context({
      previousEpoch: registering({ registeredCount: 2 }),
      playersToRegister: async () => owners,
    });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(Array(8).fill("register"));
    expect(outcome.progress).toEqual({ count: 2, total: 12 });
    expect(outcome.registerCheck).toEqual({ epochId: 1n, empty: false });
    // Acted this tick: a further batch may still be waiting, so look again
    // immediately rather than on the running epoch's own, far-off end.
    expect(outcome.nextWakeAt).toBe(NOW);
  });

  it("4. waits for a second empty tick before closing registration", async () => {
    const { ctx, sent } = context({
      previousEpoch: registering(),
    });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    expect(outcome.registerCheck).toEqual({ epochId: 1n, empty: true });
  });

  it("4. closes registration on the second consecutive empty tick, without funding", async () => {
    const result = await tickLabels({
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 1n, empty: true },
    });
    expect(result.labels).toEqual(["close_registration"]);
    expect(result.action).toBe("close_registration");
  });

  it("4. list empty, then non-empty, then empty: only the second empty tick closes", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const previousEpoch = registering();

    // Tick 1: nobody left, for the first time. Waits.
    const tick1 = context({ previousEpoch, playersToRegister: async () => [] });
    const outcome1 = await runTick(tick1.ctx);
    expect(outcome1.action).toBeNull();
    expect(outcome1.registerCheck).toEqual({ epochId: 1n, empty: true });

    // Tick 2: a late registrant shows up. Registers, and the flag resets.
    const tick2 = context({
      previousEpoch,
      lastRegisterCheck: outcome1.registerCheck ?? null,
      playersToRegister: async () => [owner],
    });
    const outcome2 = await runTick(tick2.ctx);
    expect(outcome2.action).toBe("register");
    expect(outcome2.registerCheck).toEqual({ epochId: 1n, empty: false });

    // Tick 3: empty again, but this is the first empty tick since the reset,
    // so it waits rather than closing.
    const tick3 = context({
      previousEpoch,
      lastRegisterCheck: outcome2.registerCheck ?? null,
      playersToRegister: async () => [],
    });
    const outcome3 = await runTick(tick3.ctx);
    expect(tick3.sent).toHaveLength(0);
    expect(outcome3.action).toBeNull();
    expect(outcome3.registerCheck).toEqual({ epochId: 1n, empty: true });
  });

  it("4. waits out the registration window before closing", async () => {
    // Paused with no Round, so the window is the nearest deadline.
    const { ctx, sent } = context({
      pool: pool({ registrationWindow: 50n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: registering({ endsAt: NOW - 10n }),
      lastRegisterCheck: { epochId: 1n, empty: true },
    });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    // The flag survives, so the tick that finds the window shut closes right
    // away instead of starting the two-empty-tick count again.
    expect(outcome.registerCheck).toEqual({ epochId: 1n, empty: true });
    // endsAt + registrationWindow, the instant the program starts accepting.
    expect(outcome.nextWakeAt).toBe(NOW + 40n);
  });

  it("4. closes the moment the registration window has passed", async () => {
    const result = await tickLabels({
      pool: pool({ registrationWindow: 300n }),
      previousEpoch: registering({ endsAt: NOW - 300n }),
      lastRegisterCheck: { epochId: 1n, empty: true },
    });
    expect(result.labels).toEqual(["close_registration"]);
  });

  // --- 4. (ticket 07) close_registration is withheld on a stale Read model.

  it("4. (ticket 07) withholds close_registration on a stale cursor and emits the wait reason", async () => {
    const { ctx, sent, warned } = context({
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 1n, empty: true },
      // Fresh in age, but never actually synced past the epoch's own end.
      indexerCursor: { ageSeconds: 5, updatedAt: NOW - 200n },
    });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    expect(outcome.indexerStale).toBe(true);
    expect(warned).toHaveLength(1);
  });

  it("4. (ticket 07) a cursor younger than the threshold but behind the epoch's end still withholds", async () => {
    const { ctx, sent } = context({
      previousEpoch: registering({ endsAt: NOW - 100n }),
      lastRegisterCheck: { epochId: 1n, empty: true },
      indexerFreshThresholdSeconds: 60n,
      // Age is well under the 60 s threshold...
      indexerCursor: { ageSeconds: 10, updatedAt: NOW - 150n },
    });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.indexerStale).toBe(true);
  });

  it("4. (ticket 07) a fresh, caught-up cursor closes registration as today", async () => {
    const result = await tickLabels({
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 1n, empty: true },
      indexerCursor: { ageSeconds: 1, updatedAt: NOW },
    });
    expect(result.labels).toEqual(["close_registration"]);
  });

  // --- 4. (ticket 12) a confirmed register batch is not resent.

  it("4. (ticket 12) forgets the owners a register batch was just confirmed for", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const { ctx, forgottenRegistered } = context({
      previousEpoch: registering({ registeredCount: 2 }),
      playersToRegister: async () => [owner],
    });
    await runTick(ctx);
    expect(forgottenRegistered).toEqual([[owner]]);
  });

  it("4. a late begin_epoch owes the window from when registration opened", async () => {
    // The program anchors the window on `registrationOpenedAt` when that is
    // later than `endsAt`, so the tick has to wait for the same instant or
    // it burns a transaction on RegistrationWindowOpen every time.
    const { ctx, sent } = context({
      pool: pool({ registrationWindow: 50n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: registering({ registrationOpenedAt: NOW - 10n }),
      lastRegisterCheck: { epochId: 1n, empty: true },
    });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    expect(outcome.nextWakeAt).toBe(NOW + 40n);
  });

  it("4. an empty-tick flag from a different epoch does not close registration", async () => {
    const { ctx, sent } = context({
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 0n, empty: true },
    });
    const outcome = await runTick(ctx);
    expect(sent).toHaveLength(0);
    expect(outcome.action).toBeNull();
    expect(outcome.registerCheck).toEqual({ epochId: 1n, empty: true });
  });

  it("4. stops registering once the pool is shut down: close_registration is refused", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 1n, empty: true },
      playersToRegister: () => {
        throw new Error("must not be asked while shut down");
      },
    });
    expect(result.action).toBeNull();
  });

  // game-jackpot-pause ticket 02: close_registration is refused under
  // jackpot pause, register is not.
  it("4. does not close registration while the jackpot is paused", async () => {
    const result = await tickLabels({
      pool: pool({ jackpotPaused: true }),
      previousEpoch: registering(),
      lastRegisterCheck: { epochId: 1n, empty: true },
    });
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("4. still registers players while the jackpot is paused", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      pool: pool({ jackpotPaused: true }),
      previousEpoch: registering(),
      playersToRegister: async () => [owner],
    });
    expect(result.labels).toEqual(["register"]);
  });

  // --- 5. Draw or rollover.

  it("5. draws once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["draw"]);
  });

  it("5. rolls the epoch over when the randomness never arrives", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
    expect(result.action).toBe("rollover_epoch");
  });

  it("5. waits while the request is still inside the timeout", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
  });

  it("5. does not draw once the pool is shut down: draw is refused, even fulfilled", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
      fulfilled: async () => true,
    });
    expect(result.transactions).toBe(0);
  });

  it("5. still rolls a shut-down pool's stuck draw over once the timeout elapses", async () => {
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
  });

  // --- 6. Payout.

  it("6. pays the winner, compounding the prize into their principal", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      winner: async (epochId, target) =>
        epochId === 1n && target === 42n ? winner : null,
    });
    // No winner token account any more (ticket 02): the prize goes into
    // principal_vault instead, so payout is the whole transaction.
    expect(result.labels).toEqual(["payout"]);
  });

  it("6. still pays an already-drawn epoch once the pool is shut down: payout is allowed throughout", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      pool: pool({ shutdown: true }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      winner: async () => winner,
    });
    expect(result.labels).toEqual(["payout"]);
  });

  it("6. logs the winner and retries when the payout will not land", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 60n,
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) {
          throw new Error("AccountFrozen");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBeNull();
    expect(sent).toHaveLength(0);
    expect(warned).toEqual([
      `payout of epoch 1 to ${winner} failed: AccountFrozen`,
    ]);
  });

  it("6. lets any other send failure fail the tick", async () => {
    // An RPC blip is not an unpayable winner: swallowing it would retry
    // quietly until `payout_timeout` rolled a payable epoch over, with
    // /status showing no error the whole time.
    const { ctx, warned } = context({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 60n,
      }),
      winner: async () => Keypair.generate().publicKey.toBase58(),
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    await expect(runTick(ctx)).rejects.toThrow("blockhash expired");
    expect(warned).toEqual([]);
  });

  it("6. wakes at the payout timeout of a drawn epoch", async () => {
    // Paused with no Round, so nothing else contributes a nearer deadline.
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true, payoutTimeout: 30n }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + 20n);
  });

  it("6. rolls the drawn epoch over once payout_timeout and the drawn-unpaid alert window have both passed", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n),
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) {
          throw new Error("AccountFrozen");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("rollover_epoch");
    expect((sent[0] ?? []).map(label)).toEqual(["rollover_epoch"]);
    expect(warned).toHaveLength(1);
  });

  it("6. (ticket 12) withholds rolling a human winner over until the drawn-unpaid alert window has passed, even past payout_timeout", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, warned } = context({
      pool: pool({ payoutTimeout: 30n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        // Past payoutTimeout, but well inside DRAWN_UNPAID_ALERT_SECONDS.
        drawnAt: NOW - 31n,
      }),
      winner: async () => winner,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) throw new Error("AccountFrozen");
        throw new Error("must not roll over yet");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(warned).toHaveLength(1);
  });

  it("6. (ticket 12) still rolls a House win over immediately past payout_timeout: nobody is owed a Prize", async () => {
    const housePool = pool({ payoutTimeout: 30n });
    const { ctx, sent } = context({
      pool: housePool,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 31n,
      }),
      winner: async () => housePool.house.toBase58(),
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "payout")) throw new Error("AccountFrozen");
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("rollover_epoch");
  });

  it("6. (ticket 12) falls back to an on-chain scan when the Read model misses, and still pays", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      winner: async () => null,
      winnerOnChain: async (epochId, target) =>
        epochId === 1n && target === 42n ? winner : null,
    });
    expect(result.labels).toEqual(["payout"]);
  });

  it("6. waits when no registered interval covers the target yet", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 10n,
      }),
      openRound: round({ endsAt: NOW + 1n }),
    });
    expect(result.transactions).toBe(0);
  });

  // --- 6b. Pending withdrawals whose epoch has ended.

  const pending = (count: number, amount = 1_000_000n) =>
    Array.from({ length: count }, () => ({
      owner: Keypair.generate().publicKey.toBase58(),
      amount,
    }));

  it("6b. pays a due withdrawal, creating the owner's token account first", async () => {
    const due = pending(1);
    const { ctx, sent } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async (epochId) => (epochId === 2n ? due : []),
    });
    const outcome = await runTick(ctx);

    expect(outcome.action).toBe("process_withdraw");
    expect((sent[0] ?? []).map(label)).toEqual([
      CREATE_ATA_IDEMPOTENT,
      "process_withdraw",
    ]);
    expect(outcome.withdrawShortfall).toBe(0n);
  });

  it("6b. pays at most WITHDRAW_BATCH_SIZE of them, in a transaction that fits", async () => {
    const { ctx, sent } = context({
      duePendingWithdrawals: async () => pending(WITHDRAW_BATCH_SIZE + 3),
    });
    await runTick(ctx);

    expect((sent[0] ?? []).map(label)).toEqual(
      Array.from({ length: WITHDRAW_BATCH_SIZE }, () => [
        CREATE_ATA_IDEMPOTENT,
        "process_withdraw",
      ]).flat(),
    );
    // Three accounts per payout plus an ATA creation is what caps the batch
    // below BATCH_SIZE, so the ceiling is asserted rather than trusted.
    const tx = new Transaction({
      feePayer: AUTHORITY,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }).add(...(sent[0] ?? []));
    const size = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
    expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it("6b. reports the gap and opens the round anyway when the vault is short", async () => {
    const { ctx, sent, warned } = context({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      duePendingWithdrawals: async () => pending(3, 4_000_000n),
      principalVaultBalance: async () => 5_000_000n,
      send: async (ixs) => {
        if (ixs.some((ix) => label(ix) === "process_withdraw")) {
          throw new Error("InsufficientVaultLiquidity");
        }
        sent.push(ixs);
        return "signature";
      },
    });
    const outcome = await runTick(ctx);

    // 12 USDC due against 5 in the vault.
    expect(outcome.withdrawShortfall).toBe(7_000_000n);
    expect(warned).toHaveLength(1);
    // A short vault delays cash, never the game: the round still opens.
    expect(outcome.action).toBe("create_round");
    expect((sent[0] ?? []).map(label)).toEqual(["create_round"]);
  });

  it("6b. sizes the shortfall against the batch it tried, not the whole queue", async () => {
    const { ctx } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () =>
        pending(WITHDRAW_BATCH_SIZE + 3, 4_000_000n),
      principalVaultBalance: async () => 5_000_000n,
      send: async () => {
        throw new Error("InsufficientVaultLiquidity");
      },
    });
    const outcome = await runTick(ctx);

    // Four of the seven were sent: 16 USDC against 5 in the vault. Summing
    // the whole queue would ask the admin for 23 instead of the 11 the next
    // transaction actually needs.
    expect(outcome.withdrawShortfall).toBe(
      BigInt(WITHDRAW_BATCH_SIZE) * 4_000_000n - 5_000_000n,
    );
  });

  it("6b. (ticket 06) any other failure switches to single-send mode and records the error instead of throwing", async () => {
    const { ctx } = context({
      duePendingWithdrawals: async () => pending(1),
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBeNull();
    expect(outcome.stepError).toMatch(/blockhash expired/);
    expect(outcome.withdrawState?.singleMode).toBe(true);
  });

  it("6b. (ticket 06) falls back to single sends after a batch failure", async () => {
    const owners = pending(3);
    let attempt = 0;
    const { ctx, sent } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () => owners,
      send: async (ixs) => {
        attempt += 1;
        if (attempt === 1) throw new Error("some transient failure");
        sent.push(ixs);
        return "signature";
      },
    });
    // First tick: the 3-owner batch fails, switches to single-send mode.
    const first = await runTick(ctx);
    expect(first.action).toBeNull();
    expect(first.withdrawState?.singleMode).toBe(true);

    // Second tick: pays exactly one, still in single-send mode (two remain).
    const { ctx: ctx2 } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      duePendingWithdrawals: async () => owners,
      lastWithdrawState: first.withdrawState ?? null,
      send: async (ixs) => {
        sent.push(ixs);
        return "signature";
      },
    });
    const second = await runTick(ctx2);
    expect(second.action).toBe("process_withdraw");
    expect((sent.at(-1) ?? []).filter((ix) => label(ix) === "process_withdraw")).toHaveLength(1);
    expect(second.withdrawState?.singleMode).toBe(true);
  });

  it("6b. (ticket 06) skips an owner for the rest of the epoch after WITHDRAW_FAILURE_LIMIT consecutive failures", async () => {
    const [entry] = pending(1);
    if (entry === undefined) throw new Error("test setup");
    let state: WithdrawState | null = null;
    let outcome;
    for (let i = 0; i < WITHDRAW_FAILURE_LIMIT; i += 1) {
      const { ctx, warned: w } = context({
        pool: pool({ openRoundId: 0n, paused: true }),
        openRound: null,
        lastWithdrawState: i === 0 ? { epochId: 2n, singleMode: true, failures: new Map(), skipped: new Set() } : state,
        duePendingWithdrawals: async () => [entry],
        send: async () => {
          throw new Error("frozen destination");
        },
      });
      outcome = await runTick(ctx);
      state = outcome.withdrawState ?? state;
      if (i === WITHDRAW_FAILURE_LIMIT - 1) {
        expect(w).toEqual(
          expect.arrayContaining([expect.stringContaining("skipping for the rest of epoch")]),
        );
      }
    }
    expect(state?.skipped.has(entry.owner)).toBe(true);

    // Once skipped, the owner is filtered out of the queue entirely.
    const { ctx: finalCtx } = context({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      lastWithdrawState: state,
      duePendingWithdrawals: async () => [entry],
      send: () => {
        throw new Error("must not be sent: owner is skipped");
      },
    });
    const finalOutcome = await runTick(finalCtx);
    expect(finalOutcome.action).toBeNull();
  });

  it("6b. reports no shortfall and reads no balance when nothing is due", async () => {
    let reads = 0;
    const result = await tickLabels({
      principalVaultBalance: async () => {
        reads += 1;
        return 0n;
      },
    });
    expect(result.transactions).toBe(0);
    expect(result.withdrawShortfall).toBe(0n);
    expect(reads).toBe(0);
  });

  it("6b. leaves the last reported shortfall alone on a tick that acted earlier", async () => {
    const { ctx } = context({
      openRound: round({ endsAt: NOW }),
      duePendingWithdrawals: async () => pending(1),
    });
    const outcome = await runTick(ctx);
    expect(outcome.action).toBe("request_round_randomness");
    expect(outcome.withdrawShortfall).toBeUndefined();
  });

  // --- 7. Create Round.

  it("7. opens the next round when the last one is fully settled", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  it("7. does not open a round that would outlast the epoch", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW + 59n }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    // The epoch end is the closest candidate: sooner than the 60 s safety
    // interval, and there is no open round to bound it further.
    expect(result.nextWakeAt).toBe(NOW + 59n);
  });

  it("7. does not open a round while the pool is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    // Nothing closer than the running epoch's own (far-off) end: falls back
    // to the safety interval.
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  // game-jackpot-pause ticket 02: create_round is refused under game pause.
  it("7. does not open a round while the game is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, gamePaused: true }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
    expect(result.nextWakeAt).toBe(NOW + SAFETY_INTERVAL_SECONDS);
  });

  // --- 7. The previous Round gets REVEAL_SECONDS (1 s) past its `endsAt`
  // before the next one opens; the reveal itself fires when the draw lands,
  // usually before `endsAt`.

  it("7. holds the next round at a settled lastRound's endsAt", async () => {
    const settledLastRound = round({
      status: ROUND_STATUS.SETTLED,
      endsAt: NOW,
    });
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: settledLastRound,
    });
    expect(result.transactions).toBe(0);
    // The reveal wait (lastRound.endsAt + REVEAL_SECONDS) is the closest
    // candidate.
    expect(result.nextWakeAt).toBe(NOW + 1n);
  });

  it("computes the VRF timeout as the deadline when it is the closest one", async () => {
    // Paused, so no Round opens: acting would make the deadline "now" and
    // hide the candidate this test is about.
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 70n,
      }),
    });
    expect(result.transactions).toBe(0);
    // vrfTimeout (120n) minus the 70 elapsed seconds beats both the epoch
    // end and the 60 s safety interval.
    expect(result.nextWakeAt).toBe(NOW + 50n);
  });

  it("7. opens the next round one second past a settled lastRound's endsAt", async () => {
    const settledLastRound = round({
      status: ROUND_STATUS.SETTLED,
      endsAt: NOW,
    });
    const result = await tickLabels({
      now: NOW + 1n,
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: settledLastRound,
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  it("7. a voided lastRound opens the next round immediately", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      lastRound: round({ status: ROUND_STATUS.VOIDED, endsAt: NOW }),
    });
    expect(result.labels).toEqual(["create_round"]);
  });

  // --- Ticket 09: epochNoProgress and drawnUnpaid are computed off the
  // previous epoch every tick, regardless of which step (if any) acts.

  it("epochNoProgress and drawnUnpaid read false on a healthy mid-round state", async () => {
    const { ctx } = context();
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
    expect(outcome.drawnUnpaid).toBe(false);
  });

  it("epochNoProgress fires once a registering epoch outlives its window plus the slack", async () => {
    const { ctx } = context({
      pool: pool({ registrationWindow: 60n, vrfTimeout: 120n }),
      previousEpoch: registering({ endsAt: NOW - (60n + 120n + 300n + 1n) }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(true);
  });

  it("epochNoProgress stays false for a registering epoch still inside its window", async () => {
    const { ctx } = context({
      pool: pool({ registrationWindow: 60n, vrfTimeout: 120n }),
      previousEpoch: registering({ endsAt: NOW - (60n + 120n + 300n - 1n) }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
  });

  it("epochNoProgress clears once the epoch reaches Paid or RolledOver, no matter its age", async () => {
    const { ctx } = context({
      previousEpoch: epoch({ status: EPOCH_STATUS.PAID, endsAt: NOW - 1_000_000n }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.epochNoProgress).toBe(false);
  });

  it("drawnUnpaid fires once a drawn epoch outlives DRAWN_UNPAID_ALERT_SECONDS, before payout_timeout does", async () => {
    const { ctx } = context({
      pool: pool({ payoutTimeout: 86_400n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS + 1n),
      }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.drawnUnpaid).toBe(true);
  });

  it("drawnUnpaid stays false for a drawn epoch still inside the alert window", async () => {
    const { ctx } = context({
      pool: pool({ payoutTimeout: 86_400n, openRoundId: 0n, paused: true }),
      openRound: null,
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        drawnAt: NOW - (DRAWN_UNPAID_ALERT_SECONDS - 1n),
      }),
    });
    const outcome = await runTick(ctx);
    expect(outcome.drawnUnpaid).toBe(false);
  });
});

describe("instruction builders", () => {
  const keysOf = (ixs: readonly TransactionInstruction[]): string[] =>
    (ixs[0]?.keys ?? []).map((key) => key.pubkey.toBase58());

  it("hand void_round and rollover_epoch the request's randomness account", async () => {
    // The program matches both against the seed on the Round or Epoch, so a
    // builder that forgets the account cannot void or roll over at all.
    const openRound = round({ status: ROUND_STATUS.REQUESTED });
    expect(keysOf(await instructions.voidRound(pool(), openRound))).toContain(
      instructions.randomnessFor(openRound.vrfSeed).toBase58(),
    );

    const drawing = epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING });
    expect(keysOf(await instructions.rolloverEpoch(pool(), drawing))).toContain(
      instructions.randomnessFor(drawing.vrfSeed).toBase58(),
    );
  });
});

describe("randomness", () => {
  it("hashes seeds the way solana_keccak_hasher does", () => {
    expect(Buffer.from(keccak256(new Uint8Array(0))).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(Buffer.from(keccak256(Buffer.from("abc"))).toString("hex")).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  const NONCE_A = new Uint8Array(32).fill(1);
  const NONCE_B = new Uint8Array(32).fill(2);

  it("separates seeds by domain, pool, id and nonce", () => {
    const other = poolAddress(PROGRAM_ID, 2n);
    const base = vrfSeed("epoch", POOL, 7n, NONCE_A);
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n, NONCE_A))).toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("round", POOL, 7n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", other, 7n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", POOL, 8n, NONCE_A))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n, NONCE_B))).not.toEqual(
      Buffer.from(base),
    );
  });

  it("uses this program's PDA under test-vrf and ORAO's otherwise", () => {
    const seed = vrfSeed("round", POOL, 1n, NONCE_A);
    const test = randomnessAddress(PROGRAM_ID, seed, true);
    const orao = randomnessAddress(PROGRAM_ID, seed, false);
    expect(test.equals(orao)).toBe(false);
    expect(test).toEqual(
      PublicKey.findProgramAddressSync(
        [Buffer.from("test-vrf"), Buffer.from(seed)],
        PROGRAM_ID,
      )[0],
    );
  });

  it("accepts only a fulfilled RandomnessV2 account", () => {
    // [8 discriminator][1 tag][32 client][32 seed][64 randomness]
    const account = Buffer.concat([
      Buffer.from("8befb8d7e356bfe2", "hex"),
      Buffer.from([1]),
      Buffer.alloc(128, 9),
    ]);
    expect(isFulfilled(account)).toBe(true);

    const pending = Buffer.from(account);
    pending[8] = 0;
    expect(isFulfilled(pending)).toBe(false);

    const foreign = Buffer.from(account);
    foreign[0] = 0xff;
    expect(isFulfilled(foreign)).toBe(false);

    expect(isFulfilled(account.subarray(0, account.length - 1))).toBe(false);
    expect(isFulfilled(null)).toBe(false);
  });
});

describe("clockUnixTimestamp", () => {
  it("reads unix_timestamp out of the Clock sysvar", () => {
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    expect(clockUnixTimestamp(clock)).toBe(1_800_000_000n);
    expect(() => clockUnixTimestamp(undefined)).toThrow(/clock sysvar/);
  });
});

describe("msUntilWake", () => {
  it("converts a chain-seconds gap straight to wall-clock ms", () => {
    expect(msUntilWake(NOW, NOW + 30n)).toBe(30_000);
  });

  it("never goes negative for a deadline already behind now", () => {
    expect(msUntilWake(NOW, NOW - 5n)).toBe(0);
  });

  it("clamps to the safety interval for a far-off deadline", () => {
    expect(msUntilWake(NOW, NOW + 86_400n)).toBe(
      Number(SAFETY_INTERVAL_SECONDS) * 1000,
    );
  });
});
