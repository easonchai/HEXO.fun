// Ticket 01 (reveal-timing): the operator writes `lastTickAt` from the clock
// at the moment `writeState` runs, after the tick's transaction has
// confirmed, not from the clock at the tick's start. Otherwise a slow devnet
// confirmation reads as a stall (spec.md "Operator" and status.ts's 10 s
// freshness window). Against a real Postgres, since that upsert is the thing
// under test; the chain is fake, with `send` the only seam that matters here.
const TEST_DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { epochAddress, poolAddress, roundAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { EPOCH_STATUS, ROUND_STATUS } from "./chain-state";
import type { IndexerQueries } from "./indexer-queries";
import { OperatorService } from "./operator.service";
import type { SparringService } from "./sparring";
import { msUntilWake, SAFETY_INTERVAL_SECONDS } from "./tick";
import { RANDOMNESS_DISCRIMINATOR, randomnessAddress } from "./vrf";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);

// No RPC is reached: `beginEpoch`'s `.instruction()` only encodes calldata.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);

const bn = (value: bigint | number): BN => new BN(value.toString());

/** A `SparringService` this suite never exercises: only `wake()` is called,
 *  and only to notice a `create_round`, which none of these fixtures send. */
const noopSparring = { wake: () => {} } as unknown as SparringService;
/** Every test here fabricates its own chain and DB reads, so the config
 *  service only needs to answer the one key `OperatorService` asks it for. */
const fakeConfig = {
  get: () => 60,
} as unknown as ConfigService<HexVaultEnv, true>;

const pool = (overrides: object = {}) => ({
  poolId: bn(1),
  admin: Keypair.generate().publicKey,
  operator: Keypair.generate().publicKey,
  acceptedMint: Keypair.generate().publicKey,
  principalVault: Keypair.generate().publicKey,
  jackpotVault: Keypair.generate().publicKey,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  // No epoch and no round open: the tick's only possible move is step 3,
  // `begin_epoch`, so `send` fires without any Epoch or Round fixture.
  currentEpochId: bn(0),
  currentEpochStart: bn(0),
  currentEpochEndsAt: bn(0),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  nextRoundId: bn(1),
  openRoundId: bn(0),
  carryPot: bn(0),
  totalPrincipal: bn(0),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  version: 1,
  shutdown: false,
  ...overrides,
});

describe.skipIf(!DB_AVAILABLE)("OperatorService end-of-tick timestamp", () => {
  it("records lastTickAt at or after the instant a slow send resolves", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await prisma.operatorState.deleteMany({ where: { id: 1 } });

    const accounts = new Map<string, Buffer>();
    accounts.set(
      POOL.toBase58(),
      await program.coder.accounts.encode("pool", pool()),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const START_MS = 1_800_000_000_000;
    let clockMs = START_MS;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => clockMs);

    // Stands in for a slow devnet confirmation: the wall clock advances 15 s,
    // past the 10 s freshness window (status.ts), before `send` resolves.
    let sendResolvedAtMs = 0;
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: new CountingConnection(accounts),
      poolAddress: () => POOL,
      recordChainTime: () => {},
      send: async (
        _instructions: TransactionInstruction[],
      ): Promise<string> => {
        clockMs += 15_000;
        sendResolvedAtMs = clockMs;
        return "fake-signature";
      },
    };

    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      fakeConfig,
    );

    try {
      const outcome = await operator.runOnce();
      expect(outcome.action).toBe("begin_epoch");
      // Acted this tick, so the deadline (a chain timestamp) collapses to
      // "now": zero wall-clock ms to wait before looking again.
      expect(outcome.waitMs).toBe(0);

      const state = await prisma.operatorState.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(Number(state.lastTickAt)).toBeGreaterThanOrEqual(
        Math.floor(sendResolvedAtMs / 1000),
      );
      // The pre-fix behaviour recorded the tick's start time, 15 s earlier.
      expect(Number(state.lastTickAt)).toBeGreaterThan(
        Math.floor(START_MS / 1000),
      );
      // nextWakeAt is written from the same wall clock as lastTickAt, waitMs
      // (here 0) past it (ticket 03).
      expect(state.nextWakeAt).toEqual(state.lastTickAt);
    } finally {
      dateNowSpy.mockRestore();
      await prisma.operatorState.deleteMany({ where: { id: 1 } });
      await prisma.$disconnect();
    }
  });
});

// Ticket 10: a database blip during a failing tick must not itself crash the
// process. No DB needed here — both the RPC read and the state write are
// fakes, so this covers the catch-path write in isolation.
describe("OperatorService catch-path state write", () => {
  it("does not reject when recording the tick's own error also fails", async () => {
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: {
        getMultipleAccountsInfo: async () => {
          throw new Error("boom: rpc down");
        },
      },
      poolAddress: () => POOL,
      recordChainTime: () => {},
    };
    const failingPrisma = {
      operatorState: {
        upsert: async () => {
          throw new Error("db blip");
        },
      },
    };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      failingPrisma as unknown as PrismaService,
      indexer,
      noopSparring,
      fakeConfig,
    );

    const outcome = await operator.runOnce();
    expect(outcome.action).toBeNull();
  });
});

// Ticket 10: Nest only calls onModuleDestroy when enableShutdownHooks() is
// on (main.ts); this covers that it actually waits for the tick in flight
// rather than tearing down underneath it.
describe("OperatorService.onModuleDestroy", () => {
  it("awaits the in-flight tick before resolving", async () => {
    let releaseTick: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection: {
        getMultipleAccountsInfo: async () => {
          await gate;
          throw new Error("boom: rpc down");
        },
        removeAccountChangeListener: async () => {},
      },
      poolAddress: () => POOL,
      recordChainTime: () => {},
    };
    const prisma = { operatorState: { upsert: async () => {} } };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma as unknown as PrismaService,
      indexer,
      noopSparring,
      fakeConfig,
    );

    const tickPromise = operator.tick();
    let destroyed = false;
    const destroyPromise = operator.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toBe(false);

    releaseTick();
    await tickPromise;
    await destroyPromise;
    expect(destroyed).toBe(true);
  });
});

// Step 6b's queue comes straight out of Postgres, so the predicate is the
// query, not any JS the tick runs afterwards: a wrong `lt`/`lte` here either
// pays a withdrawal a whole epoch early or never pays it at all.
describe.skipIf(!DB_AVAILABLE)("OperatorService.duePendingWithdrawals", () => {
  const owner = (): string => Keypair.generate().publicKey.toBase58();

  const player = (over: {
    owner: string;
    pendingWithdraw: bigint;
    pendingEpoch: bigint;
  }) => ({
    principal: 0n,
    entries: 0n,
    weightAcc: "0",
    lastUpdate: 0n,
    epochId: 0n,
    frozenWeight: "0",
    frozenEpoch: 0n,
    regEpoch: 0n,
    regStart: "0",
    regEnd: "0",
    isHouse: false,
    principalAcc: "0",
    frozenPrincipalAcc: "0",
    yieldEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    bonusEpoch: 0n,
    bonusGranted: 0n,
    ...over,
  });

  it("returns only the requests the pool has moved past, oldest first", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();

    const oldest = owner();
    const newer = owner();
    const thisEpoch = owner();
    const zeroAmount = owner();
    const owners = [oldest, newer, thisEpoch, zeroAmount];
    await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    await prisma.player.createMany({
      data: [
        // Out of order on purpose: the ordering has to come from the query.
        player({ owner: newer, pendingWithdraw: 2_000_000n, pendingEpoch: 4n }),
        player({ owner: oldest, pendingWithdraw: 1_000_000n, pendingEpoch: 2n }),
        // Requested in the epoch that is still running: locked until it ends.
        player({ owner: thisEpoch, pendingWithdraw: 9_000_000n, pendingEpoch: 5n }),
        // Already paid, so the row survives with nothing owed on it.
        player({ owner: zeroAmount, pendingWithdraw: 0n, pendingEpoch: 1n }),
      ],
    });

    const operator = new OperatorService(
      {
        program,
        programId: PROGRAM_ID,
        keypair: Keypair.generate(),
        connection: new CountingConnection(new Map()),
      } as unknown as ChainService,
      prisma,
      {
        playersToRegister: async () => [],
        unsettledPositions: async () => [],
        referralGrantsDue: async () => [],
        markReferralGrantsSent: async () => {},
        roundsToClose: async () => [],
      },
      noopSparring,
      fakeConfig,
    );

    try {
      // Private: the seam this test needs is the query, and reaching it
      // through a whole fabricated tick would assert the batching instead.
      const due = await operator["duePendingWithdrawals"](5n);
      expect(due.filter((entry) => owners.includes(entry.owner))).toEqual([
        { owner: oldest, amount: 1_000_000n },
        { owner: newer, amount: 2_000_000n },
      ]);
    } finally {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
      await prisma.$disconnect();
    }
  });
});

describe.skipIf(!DB_AVAILABLE)("OperatorService read budget", () => {
  it("costs two account reads per tick and sleeps the safety interval when there is nothing to do", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await prisma.operatorState.deleteMany({ where: { id: 1 } });

    const CHAIN_NOW = 1_800_000_000n;
    // An Epoch running well past the safety interval, no open Round, paused so
    // step 7 does not open one: the crank has nothing to do for a long time,
    // which is the state it spends most of a Round in.
    const idlePool = pool({
      paused: true,
      currentEpochId: bn(1),
      currentEpochStart: bn(CHAIN_NOW - 100n),
      currentEpochEndsAt: bn(CHAIN_NOW + 86_300n),
    });
    const accounts = new Map<string, Buffer>();
    accounts.set(
      POOL.toBase58(),
      await program.coder.accounts.encode("pool", idlePool),
    );
    accounts.set(
      epochAddress(PROGRAM_ID, POOL, 1n).toBase58(),
      await program.coder.accounts.encode("epoch", {
        epochId: bn(1),
        startsAt: bn(CHAIN_NOW - 100n),
        endsAt: bn(CHAIN_NOW + 86_300n),
        // Registering, not Open: step 6b tops the jackpot up only while the
        // Epoch is Open, and that read is not what this test is measuring.
        status: EPOCH_STATUS.REGISTERING,
        registeredWeight: bn(0),
        registeredCount: 0,
        jackpotAmount: bn(0),
        vrfSeed: Array(32).fill(0),
        requestedAt: bn(0),
        target: bn(0),
        winner: PublicKey.default,
        bump: 255,
      }),
    );
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(CHAIN_NOW, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const connection = new CountingConnection(accounts);
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection,
      poolAddress: () => POOL,
      epochAddress: (id: bigint) => epochAddress(PROGRAM_ID, POOL, id),
      roundAddress: (id: bigint) => roundAddress(PROGRAM_ID, POOL, id),
      recordChainTime: () => {},
      send: async () => {
        throw new Error("an idle tick must not send anything");
      },
    };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      fakeConfig,
    );

    try {
      for (let i = 0; i < 3; i++) {
        const outcome = await operator.runOnce();
        expect(outcome.action).toBeNull();
        // runOnce swallows a failed tick into a null action, so without this
        // a broken fixture would look like a quiet crank.
        const state = await prisma.operatorState.findUniqueOrThrow({
          where: { id: 1 },
        });
        expect(state.lastError).toBeNull();
        expect(outcome.nextWakeAt).toBe(CHAIN_NOW + SAFETY_INTERVAL_SECONDS);
        // The whole point of the ticket: an idle crank waits a minute, not a
        // second. At one tick per second this line reads 1_000.
        expect(outcome.waitMs).toBe(msUntilWake(CHAIN_NOW, outcome.nextWakeAt));
        expect(outcome.waitMs).toBe(Number(SAFETY_INTERVAL_SECONDS) * 1000);
      }

      // Two batched reads per tick, the Pool with the clock and then the
      // cycle, and nothing else. A reintroduced poll shows up here.
      expect(connection.callCounts()).toEqual({ getMultipleAccountsInfo: 6 });
    } finally {
      await prisma.operatorState.deleteMany({ where: { id: 1 } });
      await prisma.$disconnect();
    }
  });
});

// Production-hardening ticket 03: every chain read now has a timeout, which
// the operator's tick had none of before this ticket. A timed-out read is
// just another failed tick to `runOnce` (it already wraps every read in
// try/catch and writes `lastError`), so this proves that generic recovery
// against the specific new failure mode instead of assuming it still holds.
describe.skipIf(!DB_AVAILABLE)("OperatorService RPC failure recovery", () => {
  it("records lastError from a timed-out read, and recovers on the next tick", async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    await prisma.operatorState.deleteMany({ where: { id: 1 } });

    const accounts = new Map<string, Buffer>();
    accounts.set(POOL.toBase58(), await program.coder.accounts.encode("pool", pool()));
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const connection = new CountingConnection(accounts);
    const realRead = connection.getMultipleAccountsInfo.bind(connection);
    // Stands in for `ChainService`'s resilient connection (ticket 03) timing
    // a hung read out: the very first read the tick makes rejects, once,
    // exactly what a real timeout now surfaces as.
    let failNextRead = true;
    connection.getMultipleAccountsInfo = (keys) => {
      if (!failNextRead) return realRead(keys);
      failNextRead = false;
      return Promise.reject(new Error("RPC getMultipleAccountsInfo timed out after 10000ms"));
    };

    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection,
      poolAddress: () => POOL,
      recordChainTime: () => {},
      send: async () => "signature",
    };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      fakeConfig,
    );

    try {
      await operator.runOnce();
      const afterFailure = await prisma.operatorState.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(afterFailure.lastError).toMatch(/timed out/);
      // Ticket 09: a failing tick never stamps lastSuccessAt.
      expect(afterFailure.lastSuccessAt).toBeNull();

      // The single-flight guard resets in `runOnce`'s `finally`, so the next
      // call is never skipped by the failed one still "running".
      await operator.runOnce();
      const afterRecovery = await prisma.operatorState.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(afterRecovery.lastError).toBeNull();
      // Ticket 09: the recovering tick stamps it.
      expect(afterRecovery.lastSuccessAt).not.toBeNull();
    } finally {
      await prisma.operatorState.deleteMany({ where: { id: 1 } });
      await prisma.$disconnect();
    }
  });
});

// Ticket 04: a Round awaiting VRF is watched via subscription rather than
// polled. `roundAccount`/`requestedPool` below fix `currentEpochId` at 0 (no
// Epoch fixture needed) so `decide()`'s only live branch is step 1's Round
// check; every other step falls through to nothing, and the fake `send`
// throws if that assumption ever breaks.
describe.skipIf(!DB_AVAILABLE)("OperatorService randomness subscription", () => {
  const CHAIN_NOW = 1_800_000_000n;
  const SEED = new Uint8Array(32).fill(7);
  // The checked-in IDL has no `testFulfill`, same derivation OperatorService
  // itself uses, kept in step with it rather than hard-coded.
  const TEST_VRF = program.idl.instructions.some((ix) => ix.name === "testFulfill");
  const RANDOMNESS = randomnessAddress(PROGRAM_ID, SEED, TEST_VRF);
  const ROUND = roundAddress(PROGRAM_ID, POOL, 1n);

  const requestedRound = (overrides: object = {}) => ({
    roundId: bn(1),
    epochId: bn(0),
    startsAt: bn(CHAIN_NOW - 60n),
    endsAt: bn(CHAIN_NOW - 5n),
    status: ROUND_STATUS.REQUESTED,
    tileTotals: Array.from({ length: 36 }, () => bn(0)),
    pot: bn(0),
    houseCut: bn(0),
    vrfSeed: Array.from(SEED),
    requestedAt: bn(CHAIN_NOW - 5n),
    winningTile: 0,
    bump: 255,
    ...overrides,
  });

  async function setUp() {
    const prisma = new PrismaService();
    await prisma.$connect();
    await prisma.operatorState.deleteMany({ where: { id: 1 } });

    const accounts = new Map<string, Buffer>();
    accounts.set(
      POOL.toBase58(),
      await program.coder.accounts.encode(
        "pool",
        pool({ currentEpochId: bn(0), openRoundId: bn(1), nextRoundId: bn(2) }),
      ),
    );
    accounts.set(ROUND.toBase58(), await program.coder.accounts.encode("round", requestedRound()));
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(CHAIN_NOW, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), clock);

    const connection = new CountingConnection(accounts);
    const fakeChain = {
      program,
      programId: PROGRAM_ID,
      keypair: Keypair.generate(),
      connection,
      poolAddress: () => POOL,
      epochAddress: (id: bigint) => epochAddress(PROGRAM_ID, POOL, id),
      roundAddress: (id: bigint) => roundAddress(PROGRAM_ID, POOL, id),
      recordChainTime: () => {},
      send: async () => {
        throw new Error("this fixture's tick should never need to send anything");
      },
    };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
      referralGrantsDue: async () => [],
      markReferralGrantsSent: async () => {},
      roundsToClose: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      fakeConfig,
    );
    return { prisma, connection, accounts, operator };
  }

  async function tearDown(prisma: PrismaService): Promise<void> {
    await prisma.operatorState.deleteMany({ where: { id: 1 } });
    await prisma.$disconnect();
  }

  it("opens one subscription while Requested and wakes once fulfilled, without polling", async () => {
    const { prisma, connection, operator } = await setUp();
    try {
      // Mocked rather than spied-through: the real `wake()` schedules another
      // tick fire-and-forget, which is a separate concern (ticket 03) this
      // test does not want racing its own assertions and teardown.
      const wakeSpy = vi.spyOn(operator, "wake").mockImplementation(() => {});

      const first = await operator.tick();
      expect(first?.action).toBeNull();
      expect(connection.callsTo("onAccountChange")).toBe(1);
      // decide()'s own check, once per tick; unrelated to the subscription.
      expect(connection.callsTo("getAccountInfo")).toBe(1);

      // A second tick while still unfulfilled must not add a second
      // subscription: one persistent watch replaces the poll, it is not
      // re-armed every tick.
      await operator.tick();
      expect(connection.callsTo("onAccountChange")).toBe(1);
      expect(connection.callsTo("getAccountInfo")).toBe(2);

      // ORAO fulfils: the push notification wakes the operator directly,
      // rather than waiting for the vrf-timeout deadline or the safety tick.
      const fulfilled = Buffer.concat([
        RANDOMNESS_DISCRIMINATOR,
        Buffer.from([1]),
        Buffer.alloc(32 + 32 + 64),
      ]);
      connection.setAccount(RANDOMNESS, fulfilled);
      connection.fireAccountChange(RANDOMNESS);
      expect(wakeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await tearDown(prisma);
    }
  });

  it("stops watching once the Round is no longer Requested", async () => {
    const { prisma, connection, accounts, operator } = await setUp();
    try {
      await operator.tick();
      expect(connection.callsTo("onAccountChange")).toBe(1);

      // The next fresh read no longer finds the Round Requested (settled by
      // whatever means); the watch must be torn down rather than left dangling.
      accounts.set(
        ROUND.toBase58(),
        await program.coder.accounts.encode("round", requestedRound({ status: ROUND_STATUS.SETTLED })),
      );
      await operator.tick();
      expect(connection.callsTo("removeAccountChangeListener")).toBe(1);
      expect(connection.callsTo("onAccountChange")).toBe(1); // no new watch opened
    } finally {
      await tearDown(prisma);
    }
  });
});
