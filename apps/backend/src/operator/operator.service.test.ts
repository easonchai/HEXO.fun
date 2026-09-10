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
import { poolAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import type { IndexerQueries } from "./indexer-queries";
import { OperatorService } from "./operator.service";

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

/** Only the one RPC call a tick with no open Round or Epoch makes. */
class FakeConnection {
  constructor(private readonly accounts: Map<string, Buffer>) {}

  getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<({ data: Buffer } | null)[]> {
    return Promise.resolve(
      keys.map((key) => {
        const data = this.accounts.get(key.toBase58());
        return data ? { data } : null;
      }),
    );
  }
}

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
      connection: new FakeConnection(accounts),
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
      config,
    );

    try {
      const outcome = await operator.runOnce();
      expect(outcome.action).toBe("begin_epoch");

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
    } finally {
      dateNowSpy.mockRestore();
      await prisma.operatorState.deleteMany({ where: { id: 1 } });
      await prisma.$disconnect();
    }
  });
});
