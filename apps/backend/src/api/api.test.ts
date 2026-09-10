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
import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { ConfigModule } from "../config/config.module";
import { HealthController } from "../health/health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { ApiModule } from "./api.module";
import { oddsPercent, weightAt } from "./api.service";

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

/** A Clock sysvar account's data, `unix_timestamp` at byte offset 32 (see
 *  operator/chain-state.ts `clockUnixTimestamp`). The other fields are unused. */
function clockSysvarData(unixTimestamp: bigint): Buffer {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(unixTimestamp, 32);
  return data;
}

const sentInstructions: TransactionInstruction[][] = [];
const fakeChain = {
  connection: {
    rpcEndpoint: "http://127.0.0.1:8899",
    getSlot: async (): Promise<number> => 1234,
    getAccountInfo: async (): Promise<{ data: Buffer }> => ({
      data: clockSysvarData(CHAIN_NOW),
    }),
    getTokenAccountBalance: async (): Promise<{ value: { amount: string } }> => ({
      value: { amount: VAULT_BALANCE.toString() },
    }),
  },
  jackpotVaultAddress: (): PublicKey => Keypair.generate().publicKey,
  keypair: Keypair.generate(),
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

describe("API routes", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // HealthController rides along to prove the global throttler guard
      // leaves the container probe alone.
      imports: [ConfigModule, PrismaModule, ApiModule],
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
    });
    expect(body.currentEpoch).toMatchObject({ id: "7", status: 0 });
    expect(body.openRound).toEqual({
      id: "100",
      epochId: "7",
      startsAt: String(CURRENT_START),
      endsAt: String(CURRENT_START + 60n),
      status: 0,
      pot: "5000",
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
    expect(body.aprBps).toBe(500);
    assertNoLargeNumbers(body, "/status");
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
      authority: HOUSE,
      mint: Keypair.generate().publicKey.toBase58(),
      epochSeconds: EPOCH_LENGTH,
      epochAnchor: CURRENT_START,
      roundSeconds: 60n,
      paused: false,
      currentEpochId: CURRENT_EPOCH,
      currentEpochEndsAt: CURRENT_START + EPOCH_LENGTH,
      previousEpochEndsAt: CURRENT_START,
      totalPrincipal: BigInt(HUGE_U64),
      carryPot: 0n,
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
      },
      // Withdrew everything, so no entries and no weight this epoch.
      emptyPlayer(BOB),
      { ...emptyPlayer(HOUSE), isHouse: true },
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
    },
  });
}
