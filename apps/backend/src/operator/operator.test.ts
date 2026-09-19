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
  msUntilWake,
  runTick,
  SAFETY_INTERVAL_SECONDS,
  WITHDRAW_BATCH_SIZE,
  type TickContext,
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
}

function context(over: Partial<TickContext> = {}): Recorder {
  const sent: TransactionInstruction[][] = [];
  const warned: string[] = [];
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
    fulfilled: async () => false,
    principalVaultBalance: async () => 0n,
    // Empty by default so step 6b stays quiet in every test that is not about it.
    duePendingWithdrawals: async () => [],
    playersToRegister: async () => [],
    unsettledPositions: async () => [],
    forgetPositions: async () => {},
    winner: async () => null,
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    warn: (message) => warned.push(message),
    ...over,
  };
  return { ctx, sent, warned };
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

  it("2. keeps the rows when the send fails, so the next tick retries", async () => {
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
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    await expect(runTick(ctx)).rejects.toThrow("blockhash expired");
    expect(forgotten).toEqual([]);
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

  // --- 6. Payout.

  it("6. pays the winner, creating their token account in the same transaction", async () => {
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
    expect(result.labels).toEqual([CREATE_ATA_IDEMPOTENT, "payout"]);
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

  it("6. rolls the drawn epoch over once the payout timeout has passed", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const { ctx, sent, warned } = context({
      pool: pool({ payoutTimeout: 30n }),
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWN,
        target: 42n,
        drawnAt: NOW - 31n,
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

  it("6b. lets any other send failure fail the tick", async () => {
    const { ctx } = context({
      duePendingWithdrawals: async () => pending(1),
      send: async () => {
        throw new Error("blockhash expired");
      },
    });
    await expect(runTick(ctx)).rejects.toThrow("blockhash expired");
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

  it("separates seeds by domain, pool and id", () => {
    const other = poolAddress(PROGRAM_ID, 2n);
    const base = vrfSeed("epoch", POOL, 7n);
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n))).toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("round", POOL, 7n))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", other, 7n))).not.toEqual(
      Buffer.from(base),
    );
    expect(Buffer.from(vrfSeed("epoch", POOL, 8n))).not.toEqual(
      Buffer.from(base),
    );
  });

  it("uses this program's PDA under test-vrf and ORAO's otherwise", () => {
    const seed = vrfSeed("round", POOL, 1n);
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
