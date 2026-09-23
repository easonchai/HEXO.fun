// A dedicated database so a rerun, or another agent's suite, cannot collide
// with these rows. Set before the Nest module is built, which is when
// PrismaService opens its connection.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_api";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import type { INestApplication } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Prisma, type Player } from "@prisma/client";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ChainModule } from "../chain/chain.module";
import { ChainService } from "../chain/chain.service";
import { ConfigModule } from "../config/config.module";
import { HealthController } from "../health/health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { ApiModule } from "./api.module";
import { FaucetController } from "./faucet.controller";
import {
  BALANCES_TTL_MS,
  CHAIN_CLOCK_TTL_MS,
  JACKPOT_BALANCE_TTL_MS,
  oddsPercent,
  oneDayYieldCost,
  playerTicketExtras,
  poolBonusCap,
  principalOut,
  weightAt,
} from "./api.service";

const NOW = BigInt(Math.floor(Date.now() / 1000));
const EPOCH_LENGTH = 86_400n;
const CURRENT_EPOCH = 7n;
const PREVIOUS_EPOCH = 6n;
const CURRENT_START = NOW - 100n;
const PREVIOUS_START = CURRENT_START - EPOCH_LENGTH;

// Deliberately far from wall-clock NOW, so a route that read Date.now()
// instead of the chain clock would return a different liveWeight.
const CHAIN_NOW = NOW + 10_000n;

const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();
const ALICE = Keypair.generate().publicKey.toBase58();
const BOB = Keypair.generate().publicKey.toBase58();
const HOUSE = Keypair.generate().publicKey.toBase58();

// Both sit past 2^53, so a route that leaked a JSON number would round the
// value rather than return these digits. u64 columns cannot take the u128 one.
const HUGE_U64 = "9007199254740993";
const HUGE_U128 = "123456789012345678901234567890";

const FAKE_SIGNATURE = "FakeSignature1111111111111111111111111111111";
/** What the fake RPC says sits in the jackpot vault while epoch 7 is open. */
const VAULT_BALANCE = 5_000_000n;
/** GET /state's ticket 08 field: the fake `priorityFeeMicroLamports`'s
 *  canned answer. */
const FAKE_PRIORITY_FEE = 4_242;
/** The seeded Pool row's `closeBuffer`/`minDeposit`, which the browser reads
 *  off `/state` rather than off the chain (ticket 07). */
const POOL_CLOSE_BUFFER = 15n;
const POOL_MIN_DEPOSIT = 1_000_000n;

/** Ticket 03's `/status` figures: what the pool owes, what the principal
 *  vault holds against it, and what the operator has left for fees. */
const POOL_PENDING_WITHDRAWALS = 3_000_000n;
const PRINCIPAL_VAULT_BALANCE = 9_000_000n;
const OPERATOR_LAMPORTS = 2 * LAMPORTS_PER_SOL;

/** Ticket 05's `/status`, `/pool` and `/players/:owner` figures: base yield,
 *  bought tickets and granted tickets. */
const POOL_BASE_RATE_BPS = 488;
// Far under one day's yield cost at that rate against HUGE_U64's Principal,
// so the low-budget warning is exercised by the default seed.
const POOL_YIELD_BUDGET = 5_000_000n;
const POOL_TICKETS_PER_USDC = 10;
const POOL_BONUS_CAP_BPS = 500;
const POOL_BONUS_GRANTED = 250_000n;
const ALICE_BOUGHT_AMOUNT = 200_000n;
const ALICE_BONUS_GRANTED = 50_000n;

/** The operator key, which is also the authority of the mint the faucet
 *  mints from; the faucet resolves that at boot. */
const OPERATOR = Keypair.generate();
const ACCEPTED_MINT = new PublicKey(process.env.ACCEPTED_MINT as string);
const PRINCIPAL_VAULT = Keypair.generate().publicKey;

/** A Clock sysvar account's data, `unix_timestamp` at byte offset 32 (see
 *  operator/chain-state.ts `clockUnixTimestamp`). The other fields are unused. */
function clockSysvarData(unixTimestamp: bigint): Buffer {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(unixTimestamp, 32);
  return data;
}

/** An SPL mint account whose authority is `mintAuthority`, as the faucet's
 *  boot check reads it. */
function mintAccount(mintAuthority: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

/** An SPL token account holding `amount`, as `/status`'s liquidity read
 *  unpacks it. */
function tokenAccount(amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: ACCEPTED_MINT,
      owner: PublicKey.default,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

const accountInfo = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({
  data,
  owner,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});

const sentInstructions: TransactionInstruction[][] = [];

/** Counts calls the caching tests assert against, so they check the chain
 *  seam rather than the response body. */
let clockReads = 0;
let jackpotReads = 0;
let balanceReads = 0;
/** When set, the next `getTokenAccountBalance` call throws once and resets it. */
let failNextJackpotRead = false;
/** Same, for the paired vault/operator balance read behind /status. */
let failNextBalanceRead = false;
/** What the fake Clock sysvar reads. Mutable so a test can make the chain
 *  clock regress the way a real one does when it drifts behind wall time. */
let chainClockValue = CHAIN_NOW;

const fakeChain = {
  connection: {
    rpcEndpoint: "http://127.0.0.1:8899",
    getSlot: async (): Promise<number> => 1234,
    // The mint for the faucet's boot check, the Clock sysvar for everything
    // else: those are the only two accounts this suite reads one at a time.
    getAccountInfo: async (address: PublicKey): Promise<AccountInfo<Buffer>> => {
      if (address.equals(ACCEPTED_MINT)) return mintAccount(OPERATOR.publicKey);
      clockReads += 1;
      return accountInfo(clockSysvarData(chainClockValue), SystemProgram.programId);
    },
    getMultipleAccountsInfo: async (
      addresses: PublicKey[],
    ): Promise<(AccountInfo<Buffer> | null)[]> => {
      balanceReads += 1;
      if (failNextBalanceRead) {
        failNextBalanceRead = false;
        throw new Error("simulated balance read failure");
      }
      return addresses.map((address) =>
        address.equals(PRINCIPAL_VAULT)
          ? tokenAccount(PRINCIPAL_VAULT_BALANCE)
          : { ...accountInfo(Buffer.alloc(0), SystemProgram.programId), lamports: OPERATOR_LAMPORTS },
      );
    },
    getTokenAccountBalance: async (): Promise<{ value: { amount: string } }> => {
      jackpotReads += 1;
      if (failNextJackpotRead) {
        failNextJackpotRead = false;
        throw new Error("simulated jackpot vault balance read failure");
      }
      return { value: { amount: VAULT_BALANCE.toString() } };
    },
  },
  jackpotVaultAddress: (): PublicKey => Keypair.generate().publicKey,
  principalVaultAddress: (): PublicKey => PRINCIPAL_VAULT,
  roundAddress: (): PublicKey => Keypair.generate().publicKey,
  priorityFeeMicroLamports: async (): Promise<number> => FAKE_PRIORITY_FEE,
  keypair: OPERATOR,
  send: async (instructions: TransactionInstruction[]): Promise<string> => {
    sentInstructions.push(instructions);
    return FAKE_SIGNATURE;
  },
};

const emptyPlayer = (owner: string): Player => ({
  owner,
  principal: 0n,
  entries: 0n,
  weightAcc: new Prisma.Decimal(0),
  lastUpdate: CURRENT_START,
  epochId: CURRENT_EPOCH,
  frozenWeight: new Prisma.Decimal(0),
  frozenEpoch: 0n,
  regEpoch: 0n,
  regStart: new Prisma.Decimal(0),
  regEnd: new Prisma.Decimal(0),
  isHouse: false,
  pendingWithdraw: 0n,
  pendingEpoch: 0n,
  principalAcc: new Prisma.Decimal(0),
  frozenPrincipalAcc: new Prisma.Decimal(0),
  yieldEpoch: 0n,
  boughtEpoch: 0n,
  boughtAmount: 0n,
  bonusEpoch: 0n,
  bonusGranted: 0n,
});

const MAX_JSON_SAFE = 2 ** 53;

/** The whole point of the serialization interceptor: no lossy JSON numbers. */
function assertNoLargeNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    expect(Math.abs(value), `${path} came back as a JSON number`).toBeLessThanOrEqual(
      MAX_JSON_SAFE,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoLargeNumbers(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      assertNoLargeNumbers(inner, `${path}.${key}`);
    }
  }
}

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Pool", "Epoch", "Round", "Player", "Position", "Event", "Cursor", "FaucetClaim", "OperatorState"',
  );
}

describe("weightAt", () => {
  const at = 1_000n;

  it("uses the frozen weight once the epoch is closed for that player", () => {
    const player: Player = {
      ...emptyPlayer(ALICE),
      frozenEpoch: 6n,
      frozenWeight: new Prisma.Decimal(999),
    };
    expect(weightAt(player, 6n, 0n, at)).toBe(999n);
  });

  it("accrues entries since the last touch inside the player's own epoch", () => {
    const player: Player = {
      ...emptyPlayer(ALICE),
      epochId: 7n,
      entries: 5n,
      weightAcc: new Prisma.Decimal(100),
      lastUpdate: 900n,
    };
    expect(weightAt(player, 7n, 0n, at)).toBe(100n + 5n * 100n);
  });

  it("treats an untouched player as holding principal for the whole epoch", () => {
    const player: Player = { ...emptyPlayer(BOB), epochId: 3n, principal: 7n };
    expect(weightAt(player, 7n, 400n, at)).toBe(7n * 600n);
  });

  it("is zero for an epoch the player has already moved past unfrozen", () => {
    const player: Player = { ...emptyPlayer(BOB), epochId: 9n };
    expect(weightAt(player, 7n, 0n, at)).toBe(0n);
  });

  it("never goes negative when the clock runs behind the last touch", () => {
    const player: Player = {
      ...emptyPlayer(ALICE),
      epochId: 7n,
      entries: 5n,
      lastUpdate: 2_000n,
    };
    expect(weightAt(player, 7n, 0n, at)).toBe(0n);
  });
});

describe("oddsPercent", () => {
  it("truncates to two decimals", () => {
    expect(oddsPercent(1n, 3n)).toBe("33.33");
    expect(oddsPercent(1n, 8n)).toBe("12.50");
    expect(oddsPercent(5n, 5n)).toBe("100.00");
  });

  it("does not divide by zero when nobody holds weight", () => {
    expect(oddsPercent(0n, 0n)).toBe("0.00");
  });

  it("pads a sub-one-percent share", () => {
    expect(oddsPercent(1n, 1_000n)).toBe("0.10");
  });
});

describe("oneDayYieldCost", () => {
  it("matches register's per-second rate over a full day", () => {
    // 1,000 USDC at 500 bps (5%) for a year is 50 USDC; one 365th of that,
    // atomic (6 decimals), is what one day costs the whole pool.
    expect(oneDayYieldCost(1_000_000_000n, 500)).toBe(136_986n);
  });

  it("is zero at a zero rate or with no Principal", () => {
    expect(oneDayYieldCost(1_000_000_000n, 0)).toBe(0n);
    expect(oneDayYieldCost(0n, 500)).toBe(0n);
  });
});

describe("poolBonusCap", () => {
  it("mirrors the on-chain pool_bonus_cap", () => {
    expect(poolBonusCap(1_000_000_000n, 500)).toBe(50_000_000n);
  });

  it("is zero at a zero cap", () => {
    expect(poolBonusCap(1_000_000_000n, 0)).toBe(0n);
  });
});

describe("principalOut", () => {
  const OWED = { totalPrincipal: 3_000_000n, pendingWithdrawals: 250_000n, yieldBudget: 100_000n };

  it("is the gap between what the pool owes and what the vault holds", () => {
    expect(principalOut({ ...OWED, vaultAmount: 1_000_000n })).toBe(2_350_000n);
  });

  it("is zero once the vault covers everything owed, never negative", () => {
    expect(principalOut({ ...OWED, vaultAmount: 3_350_000n })).toBe(0n);
    // A deposit landed after vaultAmount was read: more than owed sits in
    // the vault, which is a stale read, not principal out.
    expect(principalOut({ ...OWED, vaultAmount: 5_000_000n })).toBe(0n);
  });
});

describe("playerTicketExtras", () => {
  const ALICE_ADDRESS = Keypair.generate().publicKey.toBase58();
  const player = (over: Partial<Player>): Player => ({
    ...emptyPlayer(ALICE_ADDRESS),
    principal: 1_000_000n,
    ...over,
  });

  it("reads today's counters live when their epoch matches the current one", () => {
    const extras = playerTicketExtras(
      player({ boughtEpoch: 7n, boughtAmount: 300_000n, bonusEpoch: 7n, bonusGranted: 40_000n }),
      7n,
    );
    expect(extras).toEqual({
      boughtToday: 300_000n,
      buyAllowanceLeft: 700_000n,
      grantedToday: 40_000n,
    });
  });

  it("reads a counter from a past epoch as already reset to 0", () => {
    // The on-chain reset only happens the next time buy_tickets/grant_tickets
    // actually runs for the new epoch, so a leftover epoch=6 value must not
    // leak into epoch 7's figures.
    const extras = playerTicketExtras(
      player({ boughtEpoch: 6n, boughtAmount: 300_000n, bonusEpoch: 6n, bonusGranted: 40_000n }),
      7n,
    );
    expect(extras).toEqual({ boughtToday: 0n, buyAllowanceLeft: 1_000_000n, grantedToday: 0n });
  });

  it("floors buyAllowanceLeft at zero once bought spend reaches or passes Principal", () => {
    expect(
      playerTicketExtras(player({ principal: 1_000n, boughtEpoch: 7n, boughtAmount: 1_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(0n);
    // Reads 0, not negative, even if a drifted row somehow has more spent
    // than the current Principal covers.
    expect(
      playerTicketExtras(player({ principal: 500n, boughtEpoch: 7n, boughtAmount: 1_000n }), 7n)
        .buyAllowanceLeft,
    ).toBe(0n);
  });
});

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

describe.skipIf(!DB_AVAILABLE)("API routes", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // HealthController rides along to prove the global throttler guard
      // leaves the container probe alone. It needs ChainModule imported
      // here too, same as AppModule does at the real root: ApiModule
      // importing ChainModule only makes ChainService visible inside
      // ApiModule's own controllers, not to a controller declared on this
      // root test module.
      imports: [ConfigModule, PrismaModule, ChainModule, ApiModule],
      controllers: [HealthController],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      // No validator in the loop: the faucet's only chain contact is send().
      .overrideProvider(ChainService)
      .useValue(fakeChain)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);
    await seed(prisma);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  it("GET /pool returns the pool, the current epoch and the open round", async () => {
    const { body } = await http.get("/pool").expect(200);
    expect(body.pool).toMatchObject({
      address: POOL_ADDRESS,
      poolId: "1",
      currentEpochId: "7",
      totalPrincipal: HUGE_U64,
      paused: false,
      epochAnchor: String(CURRENT_START),
      currentEpochEndsAt: String(CURRENT_START + EPOCH_LENGTH),
      previousEpochEndsAt: String(CURRENT_START),
      // Ticket 05: the whole Pool row rides along, so these need no route
      // change to show up.
      baseRateBps: POOL_BASE_RATE_BPS,
      ticketsPerUsdc: POOL_TICKETS_PER_USDC,
      bonusCapBps: POOL_BONUS_CAP_BPS,
    });
    expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
    expect(body.openRound).toEqual({
      id: "100",
      epochId: "7",
      startsAt: String(CURRENT_START),
      endsAt: String(CURRENT_START + 60n),
      status: 0,
      pot: "5000",
      houseCut: "0",
    });
    assertNoLargeNumbers(body, "/pool");
  });

  it("GET /epochs returns newest first and honours limit", async () => {
    const { body } = await http.get("/epochs?limit=1").expect(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("7");
    expect(body[0].registeredWeight).toBe(HUGE_U128);
    assertNoLargeNumbers(body, "/epochs");
  });

  it("GET /epochs rejects a nonsense limit", async () => {
    await http.get("/epochs?limit=abc").expect(400);
    await http.get("/epochs?limit=0").expect(400);
  });

  it("GET /epochs/current reports draw progress for the epoch that just ended", async () => {
    const { body } = await http.get("/epochs/current").expect(200);
    expect(body.id).toBe("7");
    // Open epoch: the indexed snapshot is 0, the vault balance is what shows.
    expect(body.jackpotAmount).toBe(VAULT_BALANCE.toString());
    expect(body.drawing).toEqual({
      epochId: "6",
      registeredCount: 1,
      eligible: 1,
      status: 1,
    });
    assertNoLargeNumbers(body, "/epochs/current");
  });

  it("GET /rounds returns newest first with the winning tile and the pot", async () => {
    const { body } = await http.get("/rounds").expect(200);
    expect(body.map((round: { id: string }) => round.id)).toEqual(["100", "99"]);
    expect(body[1]).toMatchObject({ winningTile: 17, pot: "4000", status: 2 });
    assertNoLargeNumbers(body, "/rounds");
  });

  it("GET /rounds/:id returns one round with its tile totals", async () => {
    const { body } = await http.get("/rounds/99").expect(200);
    expect(body.id).toBe("99");
    expect(body.tileTotals).toEqual({ "17": "4000" });
    assertNoLargeNumbers(body, "/rounds/99");
  });

  it("GET /rounds/:id is 404 for an unknown round and 400 for a non-numeric id", async () => {
    await http.get("/rounds/4242").expect(404);
    await http.get("/rounds/abc").expect(400);
  });

  it("GET /players/:owner computes liveWeight from the chain clock, not wall time", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    expect(body.owner).toBe(ALICE);
    expect(body.principal).toBe("1000000");
    expect(body.weightAcc).toBe(HUGE_U128);
    // Alice is the only player holding entries, so she owns all of the weight.
    expect(body.odds).toBe("100.00");
    // CHAIN_NOW sits 10,000 s ahead of wall-clock NOW: this is the value
    // weightAt(alice, ...) gives only when `at` came from the chain clock.
    const expectedLiveWeight = BigInt(HUGE_U128) + 1_000_000n * (CHAIN_NOW - CURRENT_START);
    expect(body.liveWeight).toBe(expectedLiveWeight.toString());
    assertNoLargeNumbers(body, "/players/:owner");
  });

  it("GET /players/:owner reports today's bought and granted tickets, and Base yield earned", async () => {
    const { body } = await http.get(`/players/${ALICE}`).expect(200);
    // bonusEpoch/boughtEpoch both equal the current epoch (7) in the seed,
    // so both counters read live rather than reset to 0.
    expect(body.boughtToday).toBe(ALICE_BOUGHT_AMOUNT.toString());
    expect(body.buyAllowanceLeft).toBe((1_000_000n - ALICE_BOUGHT_AMOUNT).toString());
    expect(body.grantedToday).toBe(ALICE_BONUS_GRANTED.toString());
    // yieldEpoch is the previous epoch (6): only that epoch's YieldCredited
    // row counts toward yieldLastEpoch, but every epoch's counts toward
    // yieldToDate.
    expect(body.yieldLastEpoch).toBe("12000");
    expect(body.yieldToDate).toBe("20000");
    assertNoLargeNumbers(body, "/players/:owner (yield/tickets)");
  });

  it("GET /players/:owner floors buyAllowanceLeft at zero once bought spend reaches Principal", async () => {
    await prisma.player.update({
      where: { owner: BOB },
      data: { principal: 1_000n, boughtEpoch: CURRENT_EPOCH, boughtAmount: 1_000n },
    });
    try {
      const { body } = await http.get(`/players/${BOB}`).expect(200);
      expect(body.boughtToday).toBe("1000");
      expect(body.buyAllowanceLeft).toBe("0");
    } finally {
      await prisma.player.update({
        where: { owner: BOB },
        data: { principal: 0n, boughtEpoch: 0n, boughtAmount: 0n },
      });
    }
  });

  it("GET /players/:owner gives zero odds to a player with no entries", async () => {
    const { body } = await http.get(`/players/${BOB}`).expect(200);
    expect(body.liveWeight).toBe("0");
    expect(body.odds).toBe("0.00");
  });

  it("GET /players/:owner is 400 for a bad address and 404 for an unknown wallet", async () => {
    await http.get("/players/not-a-wallet").expect(400);
    await http.get(`/players/${Keypair.generate().publicKey.toBase58()}`).expect(404);
  });

  it("GET /leaderboard ranks players by their odds at the draw", async () => {
    const { body } = await http.get("/leaderboard").expect(200);
    expect(body.map((row: { owner: string }) => row.owner)).toEqual([
      ALICE,
      BOB,
      HOUSE,
    ]);
    expect(body[0].odds).toBe("100.00");
    expect(body[2].isHouse).toBe(true);
    assertNoLargeNumbers(body, "/leaderboard");
  });

  it("odds are the share at the draw, not the share right now", async () => {
    // Alice has held 1e6 entries since the epoch opened; Bob deposits the
    // same 1e6 at the chain clock, so he has no weight yet but a slice of
    // the draw. Alice's seeded head start is dropped so Bob's share is not
    // rounded to zero.
    await prisma.player.update({
      where: { owner: ALICE },
      data: { weightAcc: new Prisma.Decimal(0) },
    });
    await prisma.player.update({
      where: { owner: BOB },
      data: { principal: 1_000_000n, entries: 1_000_000n, lastUpdate: CHAIN_NOW },
    });
    try {
      const { body } = await http.get(`/players/${BOB}`).expect(200);
      expect(body.liveWeight).toBe("0");
      const end = CURRENT_START + EPOCH_LENGTH;
      const bobAtDraw = 1_000_000n * (end - CHAIN_NOW);
      const aliceAtDraw = 1_000_000n * (end - CURRENT_START);
      expect(body.odds).toBe(oddsPercent(bobAtDraw, bobAtDraw + aliceAtDraw));
    } finally {
      await prisma.player.update({
        where: { owner: ALICE },
        data: { weightAcc: HUGE_U128 },
      });
      await prisma.player.update({
        where: { owner: BOB },
        data: { principal: 0n, entries: 0n, lastUpdate: CURRENT_START },
      });
    }
  });

  it("GET /feed keeps user-facing events only, newest first", async () => {
    const { body } = await http.get("/feed").expect(200);
    expect(body.map((event: { name: string }) => event.name)).toEqual([
      "PositionSettled",
      "JackpotPaid",
      "PositionSettled",
      "Deposited",
    ]);
    // The zero-reward PositionSettled and the operator-only RoundOpened are gone.
    expect(body.every((event: { slot: string }) => event.slot !== "11")).toBe(true);
    expect(body.every((event: { slot: string }) => event.slot !== "13")).toBe(true);
    assertNoLargeNumbers(body, "/feed");
  });

  it("GET /feed?owner filters to that wallet, keeping a JackpotPaid row by its winner field", async () => {
    // Alice owns every feed-eligible row here, including the JackpotPaid one
    // by its `winner` field: drop that disjunct and this list loses a row.
    const alice = await http.get(`/feed?owner=${ALICE}`).expect(200);
    expect(alice.body.map((event: { name: string }) => event.name)).toEqual([
      "PositionSettled",
      "JackpotPaid",
      "PositionSettled",
      "Deposited",
    ]);
    assertNoLargeNumbers(alice.body, "/feed?owner=alice");

    // Bob's only owned row (slot 11) is a zero-reward PositionSettled, which
    // the reward filter already drops, and he is nobody's JackpotPaid winner.
    const bob = await http.get(`/feed?owner=${BOB}`).expect(200);
    expect(bob.body).toEqual([]);
  });

  it("GET /positions/counts counts from the PositionBought event log, including rounds Position has already dropped", async () => {
    // Runs after the /feed tests above on purpose: PositionBought is a
    // FEED_NAMES event, so seeding it earlier would perturb their exact
    // match on the shared Event table.
    //
    // Carl has no Position row at all (his round settled and the indexer
    // deleted it, same as any settled position), yet his PositionBought
    // event is still in the log. That is the whole point of reading Event
    // instead of Position: this case reads 0 against the old
    // Position.groupBy implementation and must not here.
    const CARL = Keypair.generate().publicKey.toBase58();
    await prisma.event.createMany({
      data: [
        {
          slot: 20n,
          signature: "sig20",
          index: 0,
          name: "PositionBought",
          data: { roundId: "99", owner: ALICE, tiles: "1", stakePerTile: "100", total: "100" },
          blockTime: NOW - 20n,
        },
        {
          slot: 21n,
          signature: "sig21",
          index: 0,
          name: "PositionBought",
          data: { roundId: "100", owner: ALICE, tiles: "1", stakePerTile: "100", total: "100" },
          blockTime: NOW - 10n,
        },
        {
          slot: 22n,
          signature: "sig22",
          index: 0,
          name: "PositionBought",
          data: { roundId: "99", owner: CARL, tiles: "1", stakePerTile: "50", total: "50" },
          blockTime: NOW - 5n,
        },
      ],
    });

    const { body } = await http
      .get(`/positions/counts?owners=${ALICE},${BOB},${CARL}`)
      .expect(200);
    expect(body).toEqual({ counts: { [ALICE]: 2, [BOB]: 0, [CARL]: 1 } });
    assertNoLargeNumbers(body, "/positions/counts");
  });

  it("GET /status reports the operator, the cursor age and rpc health", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.operator).toMatchObject({
      lastAction: "settle_round",
      registeredCount: 1,
      registeredTotal: 3,
    });
    // ISO, not unix seconds: the frontend `Date.parse`s it.
    expect(Date.parse(body.operator.lastTickAt)).toBe(Number(NOW - 2n) * 1000);
    expect(body.cursor.lastSlot).toBe("15");
    expect(body.cursor.ageSeconds).toBeGreaterThanOrEqual(40);
    expect(body.cursor.ageSeconds).toBeLessThan(120);
    expect(body.rpcOk).toBe(true);
    expect(body.slot).toBe(1234);
    assertNoLargeNumbers(body, "/status");
  });

  it("GET /status reports the withdrawal queue, the vault's liquidity and the operator's SOL", async () => {
    const { body } = await http.get("/status").expect(200);
    // u64 amounts as decimal strings, same as every other money field.
    expect(body.pendingWithdrawals).toBe(POOL_PENDING_WITHDRAWALS.toString());
    expect(body.vaultLiquidity).toBe(PRINCIPAL_VAULT_BALANCE.toString());
    // Seeded on the OperatorState row, in atomic units like the rest.
    expect(body.withdrawShortfall).toBe("250000");
    // SOL, not lamports, so the warning threshold reads in the same unit.
    expect(body.operatorSol).toBe(2);
    expect(body.operatorSolLow).toBe(false);
    // total_principal + pending_withdrawals + yield_budget - vault, past
    // 2^53 like the seeded totalPrincipal itself, so a truncating path here
    // would show up the same way `assertNoLargeNumbers` catches one below.
    expect(body.principalOut).toBe(
      (BigInt(HUGE_U64) + POOL_PENDING_WITHDRAWALS + POOL_YIELD_BUDGET - PRINCIPAL_VAULT_BALANCE).toString(),
    );
    expect(body.shutdown).toBe(false);
  });

  it("GET /healthz reports the operator's SOL and its own status, separate from /status", async () => {
    const { body } = await http.get("/healthz").expect(200);
    expect(body.ok).toBe(true);
    expect(body.operatorSol).toBe(2);
    expect(body.status).toBe("ok");
  });

  it("GET /status reports the yield budget, bonus grants and the low-budget warning", async () => {
    const { body } = await http.get("/status").expect(200);
    expect(body.yieldBudget).toBe(POOL_YIELD_BUDGET.toString());
    // Only epoch 6's YieldCredited rows count (Alice 500 + Bob 300); epoch
    // 5's 999 is a different epoch and must not be added in.
    expect(body.yieldShortfall).toBe("800");
    expect(body.bonusGrantedToday).toBe(POOL_BONUS_GRANTED.toString());
    expect(body.bonusCap).toBe(
      poolBonusCap(BigInt(HUGE_U64), POOL_BONUS_CAP_BPS).toString(),
    );
    // HUGE_U64's Principal makes one day of yield dwarf the seeded budget.
    expect(
      POOL_YIELD_BUDGET < oneDayYieldCost(BigInt(HUGE_U64), POOL_BASE_RATE_BPS),
    ).toBe(true);
    expect(body.yieldBudgetLow).toBe(true);
    assertNoLargeNumbers(body, "/status (yield)");
  });

  describe("GET /alerts", () => {
    // The default seed's OperatorState.withdrawShortfall is 250_000n (see
    // "GET /status reports the withdrawal queue..." above), and every other
    // condition reads healthy against it, so the untouched seed already
    // proves the wiring for exactly one code without any setup of its own.
    it("is 503 with exactly WITHDRAW_SHORTFALL against the seeded OperatorState row", async () => {
      const { body } = await http.get("/alerts").expect(503);
      expect(body).toEqual({
        alerts: [{ code: "WITHDRAW_SHORTFALL", message: expect.any(String) }],
      });
    });

    it("is 200 with an empty list once the withdraw shortfall clears", async () => {
      await prisma.operatorState.update({
        where: { id: 1 },
        data: { withdrawShortfall: 0n },
      });
      try {
        const { body } = await http.get("/alerts").expect(200);
        expect(body).toEqual({ alerts: [] });
      } finally {
        await prisma.operatorState.update({
          where: { id: 1 },
          data: { withdrawShortfall: 250_000n },
        });
      }
    });

    it("is 503 with ROUND_VOIDED_RECENTLY and EPOCH_ROLLED_OVER_RECENTLY, from Event rows in the last hour", async () => {
      await prisma.operatorState.update({
        where: { id: 1 },
        data: { withdrawShortfall: 0n },
      });
      await prisma.event.createMany({
        data: [
          {
            slot: 900n,
            signature: "sigAlertsVoided",
            index: 0,
            name: "RoundVoided",
            data: { roundId: "101" },
            blockTime: NOW - 60n,
          },
          {
            slot: 901n,
            signature: "sigAlertsRolledOver",
            index: 0,
            name: "EpochRolledOver",
            data: { epochId: "7" },
            blockTime: NOW - 30n,
          },
        ],
      });
      try {
        const { body } = await http.get("/alerts").expect(503);
        expect(body.alerts).toEqual([
          { code: "ROUND_VOIDED_RECENTLY", message: expect.any(String) },
          { code: "EPOCH_ROLLED_OVER_RECENTLY", message: expect.any(String) },
        ]);
      } finally {
        await prisma.event.deleteMany({
          where: { signature: { in: ["sigAlertsVoided", "sigAlertsRolledOver"] } },
        });
        await prisma.operatorState.update({
          where: { id: 1 },
          data: { withdrawShortfall: 250_000n },
        });
      }
    });
  });

  describe("GET /state", () => {
    it("returns the pool, current epoch, open round, status and chain time for a given owner", async () => {
      const { body } = await http.get(`/state?owner=${ALICE}`).expect(200);
      expect(body.pool).toMatchObject({ address: POOL_ADDRESS, currentEpochId: "7" });
      // The browser needs both and no longer reads the Pool account itself.
      expect(body.pool.closeBuffer).toBe(POOL_CLOSE_BUFFER.toString());
      expect(body.pool.minDeposit).toBe(POOL_MIN_DEPOSIT.toString());
      expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
      // Open epoch: same live-vault-balance rule as GET /epochs/current.
      expect(body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      // Epoch 6 (the one that just ended) is seeded Registering, so the
      // mid-draw case is exercised by the default seed, not extra setup.
      expect(body.currentEpoch.drawing).toEqual({
        epochId: "6",
        registeredCount: 1,
        eligible: 1,
        status: 1,
      });
      expect(body.openRound).toEqual({
        id: "100",
        epochId: "7",
        startsAt: String(CURRENT_START),
        endsAt: String(CURRENT_START + 60n),
        status: 0,
        pot: "5000",
        houseCut: "0",
      });
      expect(body.player).toMatchObject({ owner: ALICE, odds: "100.00" });
      // round: the open Round's full state, no `round=` needed — it falls
      // back to `openRound`'s id.
      expect(body.round).toMatchObject({ id: "100", status: 0, winningTile: null });
      // position: Alice's Position in that same Round, found the same way.
      expect(body.position).toEqual({ tiles: "7", stakePerTile: "1000000" });
      expect(body.status.operator).toMatchObject({ lastAction: "settle_round" });
      expect(body.status.cursor.lastSlot).toBe("15");
      expect(BigInt(body.chainTime)).toBeGreaterThanOrEqual(CHAIN_NOW);
      // Ticket 08: the cached estimate over the pool's hot writable accounts.
      expect(body.priorityFeeMicroLamports).toBe(FAKE_PRIORITY_FEE);
      assertNoLargeNumbers(body, "/state?owner");
    });

    it("omits the Player with no owner given, so a disconnected visitor gets a complete page", async () => {
      const { body } = await http.get("/state").expect(200);
      expect(body.player).toBeNull();
      expect(body.pool).toBeDefined();
      expect(body.currentEpoch).toBeDefined();
      expect(body.openRound).toBeDefined();
      expect(body.status).toBeDefined();
      // No owner: still resolves the open Round as `round`, but no Position.
      expect(body.round).toMatchObject({ id: "100" });
      expect(body.position).toBeNull();
      assertNoLargeNumbers(body, "/state");
    });

    it("keeps returning a settled Round's full state — winning tile and tile totals included — once it is no longer the open Round", async () => {
      // Round 99 settled before this session ever polled: `openRound` never
      // shows it, but naming it with `round=` still returns everything the
      // reveal needs, and Bob's Position in it follows the same param.
      const { body } = await http.get(`/state?owner=${BOB}&round=99`).expect(200);
      expect(body.openRound).toMatchObject({ id: "100" });
      expect(body.round).toMatchObject({
        id: "99",
        epochId: "7",
        status: 2,
        winningTile: 17,
        pot: "4000",
        houseCut: "240",
      });
      expect(body.position).toEqual({ tiles: "3", stakePerTile: "500000" });
      assertNoLargeNumbers(body, "/state?round=99");
    });

    it("returns a null round and Position for a round id nothing was seeded under", async () => {
      const { body } = await http.get(`/state?owner=${ALICE}&round=404`).expect(200);
      expect(body.round).toBeNull();
      expect(body.position).toBeNull();
    });

    it("rejects a malformed round id", async () => {
      await http.get("/state?round=not-a-number").expect(400);
    });

    it("returns a null Player, not a 404, for a wallet with no Player account yet", async () => {
      const stranger = Keypair.generate().publicKey.toBase58();
      const { body } = await http.get(`/state?owner=${stranger}`).expect(200);
      expect(body.player).toBeNull();
    });

    it("returns a null open Round once the epoch has none open", async () => {
      await prisma.round.update({ where: { id: 100n }, data: { status: 2 } });
      try {
        const { body } = await http.get("/state").expect(200);
        expect(body.openRound).toBeNull();
      } finally {
        await prisma.round.update({ where: { id: 100n }, data: { status: 0 } });
      }
    });

    it("rejects a malformed owner", async () => {
      await http.get("/state?owner=not-a-wallet").expect(400);
    });
  });

  describe("chain read caching", () => {
    // Fakes only `Date`, leaving real timers and I/O alone, so `Date.now()`
    // inside the service's TTL caches is controlled without slowing the
    // suite down with real waits. Installed once for the whole block rather
    // than per test: each test only ever advances this clock forward from
    // wherever the previous one left it, so it can never land behind a
    // cache timestamp an earlier test already stamped (which resetting to
    // the real "now" between tests could do, reading a still-fresh cache as
    // stale-checked-clean by accident).
    beforeAll(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it("collapses a concurrent burst of chain-clock reads to one call, then reads again after the window", async () => {
      // Past the window from whatever an earlier test left cached, so the
      // burst below starts from a cold cache.
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const before = clockReads;

      const burst = await Promise.all([
        http.get(`/players/${ALICE}`),
        http.get("/leaderboard"),
        http.get(`/players/${ALICE}`),
      ]);
      burst.forEach((response) => expect(response.status).toBe(200));
      expect(clockReads).toBe(before + 1);

      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      await http.get(`/players/${ALICE}`).expect(200);
      expect(clockReads).toBe(before + 2);
    });

    it("never serves a chainTime below one it already served, when the chain clock drifts behind wall time", async () => {
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const first = await http.get("/state").expect(200);
      const served = BigInt(first.body.chainTime);

      // The Clock sysvar advances slower than wall time, so the window's
      // wall-time extrapolation overshoots and the next fresh read lands
      // below what the previous response already carried.
      chainClockValue = CHAIN_NOW - 5n;
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      try {
        const second = await http.get("/state").expect(200);
        expect(BigInt(second.body.chainTime)).toBeGreaterThanOrEqual(served);
      } finally {
        chainClockValue = CHAIN_NOW;
      }
    });

    it("collapses a concurrent burst of jackpot balance reads to one call, then reads again after the window", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;

      const burst = await Promise.all([
        http.get("/epochs/current"),
        http.get("/epochs/current"),
        http.get("/epochs/current"),
      ]);
      burst.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.jackpotAmount).toBe(VAULT_BALANCE.toString());
      });
      expect(jackpotReads).toBe(before + 1);

      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      await http.get("/epochs/current").expect(200);
      expect(jackpotReads).toBe(before + 2);
    });

    it("falls back to the indexed snapshot on a failed jackpot read, without caching the fallback", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;
      failNextJackpotRead = true;

      const failed = await http.get("/epochs/current").expect(200);
      // Epoch 7's indexed jackpotAmount is seeded at 0, distinct from
      // VAULT_BALANCE, so this proves the fallback path ran rather than a
      // stale success.
      expect(failed.body.jackpotAmount).toBe("0");
      expect(jackpotReads).toBe(before + 1);

      // Still inside the window the failed read opened. A cache poisoned
      // with the "0" fallback would keep serving it here; the failed
      // attempt must instead have cleared the cache slot, so this retries
      // the chain and sees the vault balance again.
      const recovered = await http.get("/epochs/current").expect(200);
      expect(recovered.body.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 2);
    });

    it("reports the balances as unknown on a failed read, without caching that", async () => {
      vi.setSystemTime(Date.now() + BALANCES_TTL_MS + 1);
      const before = balanceReads;
      failNextBalanceRead = true;

      const { body } = await http.get("/status").expect(200);
      expect(body.vaultLiquidity).toBeNull();
      expect(body.operatorSol).toBeNull();
      // Null, not false: a failed read is not evidence of a funded key, and
      // false would keep the "operator is running dry" banner off for as
      // long as the RPC stayed down.
      expect(body.operatorSolLow).toBeNull();
      expect(balanceReads).toBe(before + 1);

      // Still inside the window the failed read opened. A slot left holding
      // the failure would serve nulls for the whole TTL; it has to have
      // been cleared, so this retries the chain.
      const recovered = await http.get("/status").expect(200);
      expect(recovered.body.vaultLiquidity).toBe(PRINCIPAL_VAULT_BALANCE.toString());
      expect(recovered.body.operatorSolLow).toBe(false);
      expect(balanceReads).toBe(before + 2);
    });

    it("GET /state advances the cached chain time by the wall time elapsed since it was observed, with no extra clock read", async () => {
      vi.setSystemTime(Date.now() + CHAIN_CLOCK_TTL_MS + 1);
      const before = clockReads;

      const fresh = await http.get("/state").expect(200);
      expect(clockReads).toBe(before + 1);
      expect(fresh.body.chainTime).toBe(CHAIN_NOW.toString());

      // Still inside the TTL window: the same cached clock value, now
      // extrapolated forward by the whole second that elapsed, with no new
      // read of the chain.
      vi.setSystemTime(Date.now() + 1_500);
      const later = await http.get("/state").expect(200);
      expect(clockReads).toBe(before + 1);
      expect(later.body.chainTime).toBe((CHAIN_NOW + 1n).toString());
    });

    it("GET /state reuses the cached jackpot balance for the open epoch's live amount", async () => {
      vi.setSystemTime(Date.now() + JACKPOT_BALANCE_TTL_MS + 1);
      const before = jackpotReads;

      const first = await http.get("/state").expect(200);
      expect(first.body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 1);

      const second = await http.get("/state").expect(200);
      expect(second.body.currentEpoch.jackpotAmount).toBe(VAULT_BALANCE.toString());
      expect(jackpotReads).toBe(before + 1);
    });
  });

  describe("POST /faucet", () => {
    it("rejects a body without a usable owner", async () => {
      await http.post("/faucet").send({}).expect(400);
      await http.post("/faucet").send({ owner: "not-a-wallet" }).expect(400);
    });

    it("mints once, then answers 429 with retryAfterSeconds", async () => {
      const before = sentInstructions.length;
      const first = await http.post("/faucet").send({ owner: BOB }).expect(201);
      expect(first.body).toMatchObject({
        owner: BOB,
        amount: "1000000000",
        signature: FAKE_SIGNATURE,
      });
      // createAssociatedTokenAccountIdempotent + mintTo, one transaction.
      expect(sentInstructions).toHaveLength(before + 1);
      expect(sentInstructions[before]).toHaveLength(2);
      assertNoLargeNumbers(first.body, "/faucet");

      const second = await http.post("/faucet").send({ owner: BOB }).expect(429);
      expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.body.retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(sentInstructions).toHaveLength(before + 1);
    });

    it("is 404 when the operator is not the mint authority", async () => {
      // What mainnet looks like: the accepted mint is real USDC and nobody
      // here can mint it, so the route is not there at all.
      const faucet = app.get(FaucetController);
      const resolved = faucet.isMintAuthority;
      expect(resolved).toBe(true);
      faucet.isMintAuthority = false;
      try {
        const before = sentInstructions.length;
        await http.post("/faucet").send({ owner: ALICE }).expect(404);
        expect(sentInstructions).toHaveLength(before);
      } finally {
        faucet.isMintAuthority = resolved;
      }
    });

    // Last in the file: it deliberately burns the caller's per-IP budget.
    it("rate limits the caller by IP", async () => {
      let throttled = false;
      for (let attempt = 0; attempt < 20 && !throttled; attempt += 1) {
        const response = await http.post("/faucet").send({ owner: "nope" });
        // Only the throttler sets Retry-After; the per-owner 429 does not.
        throttled = response.headers["retry-after"] !== undefined;
      }
      expect(throttled).toBe(true);

      // The read routes the frontend polls every 2 s share no budget with it.
      for (let poll = 0; poll < 15; poll += 1) {
        await http.get("/pool").expect(200);
      }
      await http.get("/healthz").expect(200);
    });
  });
});

async function seed(prisma: PrismaService): Promise<void> {
  await prisma.pool.create({
    data: {
      address: POOL_ADDRESS,
      poolId: 1n,
      admin: HOUSE,
      operator: HOUSE,
      pendingAdmin: null,
      mint: Keypair.generate().publicKey.toBase58(),
      pendingWithdrawals: POOL_PENDING_WITHDRAWALS,
      minJackpot: 1_000_000n,
      epochSeconds: EPOCH_LENGTH,
      epochAnchor: CURRENT_START,
      roundSeconds: 60n,
      closeBuffer: POOL_CLOSE_BUFFER,
      minDeposit: POOL_MIN_DEPOSIT,
      houseCutBps: 600,
      paused: false,
      currentEpochId: CURRENT_EPOCH,
      currentEpochEndsAt: CURRENT_START + EPOCH_LENGTH,
      previousEpochEndsAt: CURRENT_START,
      totalPrincipal: BigInt(HUGE_U64),
      carryPot: 0n,
      baseRateBps: POOL_BASE_RATE_BPS,
      yieldBudget: POOL_YIELD_BUDGET,
      ticketsPerUsdc: POOL_TICKETS_PER_USDC,
      bonusCapBps: POOL_BONUS_CAP_BPS,
      bonusEpoch: CURRENT_EPOCH,
      bonusGranted: POOL_BONUS_GRANTED,
      version: 1,
      shutdown: false,
      updatedSlot: 15n,
    },
  });

  await prisma.epoch.createMany({
    data: [
      {
        id: PREVIOUS_EPOCH,
        startsAt: PREVIOUS_START,
        endsAt: CURRENT_START,
        status: 1, // Registering
        registeredWeight: HUGE_U128,
        registeredCount: 1,
        jackpotAmount: 12_000_000n,
        target: "0",
        winner: null,
      },
      {
        id: CURRENT_EPOCH,
        startsAt: CURRENT_START,
        endsAt: CURRENT_START + EPOCH_LENGTH,
        status: 0, // Open
        registeredWeight: HUGE_U128,
        registeredCount: 0,
        jackpotAmount: 0n,
        target: "0",
        winner: null,
      },
    ],
  });

  await prisma.round.createMany({
    data: [
      {
        id: 99n,
        epochId: CURRENT_EPOCH,
        startsAt: CURRENT_START - 60n,
        endsAt: CURRENT_START,
        status: 2, // Settled
        pot: 4_000n,
        houseCut: 240n,
        winningTile: 17,
        tileTotals: { "17": "4000" },
      },
      {
        id: 100n,
        epochId: CURRENT_EPOCH,
        startsAt: CURRENT_START,
        endsAt: CURRENT_START + 60n,
        status: 0, // Open
        pot: 5_000n,
        houseCut: 0n,
        winningTile: null,
        tileTotals: {},
      },
    ],
  });

  await prisma.player.createMany({
    data: [
      {
        ...emptyPlayer(ALICE),
        principal: 1_000_000n,
        entries: 1_000_000n,
        weightAcc: HUGE_U128,
        frozenEpoch: PREVIOUS_EPOCH,
        frozenWeight: HUGE_U128,
        regEpoch: PREVIOUS_EPOCH,
        regStart: "0",
        regEnd: HUGE_U128,
        yieldEpoch: PREVIOUS_EPOCH,
        boughtEpoch: CURRENT_EPOCH,
        boughtAmount: ALICE_BOUGHT_AMOUNT,
        bonusEpoch: CURRENT_EPOCH,
        bonusGranted: ALICE_BONUS_GRANTED,
      },
      // Withdrew everything, so no entries and no weight this epoch.
      emptyPlayer(BOB),
      { ...emptyPlayer(HOUSE), isHouse: true },
    ],
  });

  await prisma.position.createMany({
    data: [
      // Alice's Position in the open round (100): the default case, no
      // `round` query param needed to find it.
      {
        address: Keypair.generate().publicKey.toBase58(),
        owner: ALICE,
        roundId: 100n,
        tiles: 7n,
        stakePerTile: 1_000_000n,
      },
      // Bob's Position in round 99, already Settled: only reachable by
      // naming it explicitly with `round=99`, since it is not `openRound`.
      {
        address: Keypair.generate().publicKey.toBase58(),
        owner: BOB,
        roundId: 99n,
        tiles: 3n,
        stakePerTile: 500_000n,
      },
    ],
  });

  await prisma.event.createMany({
    data: [
      { slot: 10n, signature: "sig10", index: 0, name: "Deposited", data: { owner: ALICE, amount: "1000000" }, blockTime: NOW - 300n },
      { slot: 11n, signature: "sig11", index: 0, name: "PositionSettled", data: { owner: BOB, reward: "0" }, blockTime: NOW - 250n },
      { slot: 12n, signature: "sig12", index: 0, name: "PositionSettled", data: { owner: ALICE, reward: "500" }, blockTime: NOW - 200n },
      { slot: 13n, signature: "sig13", index: 0, name: "RoundOpened", data: { roundId: "100" }, blockTime: NOW - 150n },
      { slot: 14n, signature: "sig14", index: 0, name: "JackpotPaid", data: { winner: ALICE, amount: "12000000", isHouse: false }, blockTime: NOW - 100n },
      // Reward stored as a JSON number rather than a string, which the feed
      // filter has to accept just the same.
      { slot: 15n, signature: "sig15", index: 0, name: "PositionSettled", data: { owner: ALICE, reward: 7 }, blockTime: NOW - 50n },
      // Ticket 05: yieldLastEpoch/yieldToDate (/players/:owner) sum these by
      // owner; yieldShortfall (/status) sums the previous epoch's by epochId
      // alone, across every owner. Epoch 5's row is outside that epoch and
      // must not be counted.
      { slot: 16n, signature: "sig16", index: 0, name: "YieldCredited", data: { epochId: String(PREVIOUS_EPOCH - 1n), owner: ALICE, amount: "8000", shortfall: "999" }, blockTime: NOW - 45n },
      { slot: 17n, signature: "sig17", index: 0, name: "YieldCredited", data: { epochId: String(PREVIOUS_EPOCH), owner: ALICE, amount: "12000", shortfall: "500" }, blockTime: NOW - 40n },
      { slot: 18n, signature: "sig18", index: 0, name: "YieldCredited", data: { epochId: String(PREVIOUS_EPOCH), owner: BOB, amount: "700", shortfall: "300" }, blockTime: NOW - 35n },
    ],
  });

  await prisma.cursor.create({
    data: { id: 1, lastSignature: "sig15", lastSlot: 15n, updatedAt: NOW - 42n },
  });

  await prisma.operatorState.create({
    data: {
      id: 1,
      lastTickAt: NOW - 2n,
      lastAction: "settle_round",
      lastError: null,
      registeredCount: 1,
      registeredTotal: 3,
      withdrawShortfall: 250_000n,
    },
  });
}
