// Ticket 01 (reveal-timing): the operator writes `lastTickAt` from the clock
// at the moment `writeState` runs, after the tick's transaction has
// confirmed, not from the clock at the tick's start. Otherwise a slow devnet
// confirmation reads as a stall (spec.md "Operator" and status.ts's 10 s
// freshness window). Against a real Postgres, since that upsert is the thing
// under test; the chain is fake, with `send` the only seam that matters here.
process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import type { ConfigService } from "@nestjs/config";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { epochAddress, poolAddress, roundAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { CountingConnection } from "../test-utils/counting-connection";
import { EPOCH_STATUS } from "./chain-state";
import type { IndexerQueries } from "./indexer-queries";
import { OperatorService } from "./operator.service";
import type { SparringService } from "./sparring";
import { msUntilWake, SAFETY_INTERVAL_SECONDS } from "./tick";

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

const pool = (overrides: object = {}) => ({
  poolId: bn(1),
  authority: Keypair.generate().publicKey,
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
  ...overrides,
});

/** OperatorService's constructor only ever calls `get` on the config. */
function stubConfig(
  env: Pick<HexVaultEnv, "HEXUSDC_MINT">,
) {
  return {
    get: (key: keyof HexVaultEnv) => env[key as keyof typeof env],
  } as unknown as ConfigService<HexVaultEnv, true>;
}

describe("OperatorService end-of-tick timestamp", () => {
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
    };
    const config = stubConfig({
      HEXUSDC_MINT: Keypair.generate().publicKey.toBase58(),
    });
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      config,
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

describe("OperatorService read budget", () => {
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
      send: async () => {
        throw new Error("an idle tick must not send anything");
      },
    };
    const indexer: IndexerQueries = {
      playersToRegister: async () => [],
      unsettledPositions: async () => [],
    };
    const operator = new OperatorService(
      fakeChain as unknown as ChainService,
      prisma,
      indexer,
      noopSparring,
      stubConfig({ HEXUSDC_MINT: Keypair.generate().publicKey.toBase58() }),
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
