// Against a real Postgres (docs/plan/hexo-referrals ticket 11), same shape as
// access.test.ts: a dedicated database so a rerun, or another agent's suite,
// cannot collide with these rows. ReferralsController is exercised directly,
// not through the whole ApiModule: it needs no ChainService, so there is
// nothing to fake. The SerializationInterceptor is wired in here by hand
// (api.module.ts registers it for the real app) so bigint fields serialize
// the same way in this isolated test as they do in production.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_referrals";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Pool } from "@prisma/client";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { ReferralsController } from "./referrals.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const REFERRER = Keypair.generate().publicKey.toBase58();
const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "Pool", "InviteCode", "Referral", "ReferralGrant"');
}

const emptyPool = (overrides: Partial<Pool> = {}): Pool => ({
  address: POOL_ADDRESS,
  poolId: 1n,
  admin: Keypair.generate().publicKey.toBase58(),
  operator: Keypair.generate().publicKey.toBase58(),
  pendingAdmin: null,
  mint: Keypair.generate().publicKey.toBase58(),
  epochSeconds: 86_400n,
  epochAnchor: 0n,
  roundSeconds: 60n,
  closeBuffer: 15n,
  minDeposit: 0n,
  paused: false,
  currentEpochId: 5n,
  currentEpochEndsAt: 0n,
  previousEpochEndsAt: 0n,
  totalPrincipal: 0n,
  pendingWithdrawals: 0n,
  minJackpot: 0n,
  carryPot: 0n,
  houseCutBps: 0,
  baseRateBps: 488,
  yieldBudget: 0n,
  ticketsPerUsdc: 1,
  bonusCapBps: 500,
  bonusEpoch: 0n,
  bonusGranted: 0n,
  updatedSlot: 0n,
  ...overrides,
});

describe.skipIf(!DB_AVAILABLE)("GET /referrals/:wallet", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      controllers: [ReferralsController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: SerializationInterceptor }],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.pool.deleteMany();
    await prisma.inviteCode.deleteMany();
    await prisma.referral.deleteMany();
    await prisma.referralGrant.deleteMany();
  });

  it("400s a malformed wallet", async () => {
    await http.get("/referrals/not-a-wallet").expect(400);
  });

  it("is the empty state for a wallet with nothing indexed yet (no pool either)", async () => {
    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body).toEqual({
      ownedCodes: [],
      referrals: [],
      qualifiedCount: 0,
      rateBps: 0,
      countToNextBand: 1,
      nextRateBps: 200,
      bonusToday: "0",
      bonusYesterday: "0",
    });
  });

  it("lists owned invite codes with uses left", async () => {
    await prisma.inviteCode.create({
      data: { code: "ABCD2345", ownerWallet: REFERRER, maxUses: 5, uses: 2, createdAt: 0n },
    });
    await prisma.inviteCode.create({
      data: { code: "WXYZ6789", ownerWallet: REFERRER, maxUses: 5, uses: 5, createdAt: 0n },
    });
    // Owned by someone else: must not show up under REFERRER.
    await prisma.inviteCode.create({
      data: {
        code: "OTHR1234",
        ownerWallet: Keypair.generate().publicKey.toBase58(),
        maxUses: 5,
        uses: 0,
        createdAt: 0n,
      },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.ownedCodes).toEqual([
      { code: "ABCD2345", usesLeft: 3 },
      { code: "WXYZ6789", usesLeft: 0 },
    ]);
  });

  it("masks referral wallets and reports qualified vs. days to qualify", async () => {
    const qualifiedReferee = Keypair.generate().publicKey.toBase58();
    const pendingReferee = Keypair.generate().publicKey.toBase58();
    const now = BigInt(Math.floor(Date.now() / 1000));

    await prisma.referral.create({
      data: {
        referee: qualifiedReferee,
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: 0n,
        aboveSince: now - 604_800n, // exactly the default qualify window
        principal: 50_000_000n,
      },
    });
    await prisma.referral.create({
      data: {
        referee: pendingReferee,
        referrer: REFERRER,
        code: "ABCD2345",
        boundAt: 0n,
        aboveSince: now - 100_000n,
        principal: 60_000_000n,
      },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.referrals).toHaveLength(2);
    for (const row of body.referrals as { wallet: string }[]) {
      expect(row.wallet).not.toBe(qualifiedReferee);
      expect(row.wallet).not.toBe(pendingReferee);
      expect(row.wallet).toMatch(/^.{4}….{4}$/);
    }
    expect(body.qualifiedCount).toBe(1);
    expect(body.rateBps).toBe(200);
  });

  it("reads today's and yesterday's bonus off the pool's currentEpochId", async () => {
    await prisma.pool.create({ data: emptyPool({ currentEpochId: 5n }) });
    await prisma.referralGrant.create({
      data: { epochId: 5n, referrer: REFERRER, amount: 72_000_000n, qualifiedCount: 6, rateBps: 400 },
    });
    await prisma.referralGrant.create({
      data: { epochId: 4n, referrer: REFERRER, amount: 50_000_000n, qualifiedCount: 4, rateBps: 300 },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.bonusToday).toBe("72000000");
    expect(body.bonusYesterday).toBe("50000000");
  });

  it("reads 0 for a wallet the bonus job has not granted today", async () => {
    await prisma.pool.create({ data: emptyPool({ currentEpochId: 5n }) });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.bonusToday).toBe("0");
    expect(body.bonusYesterday).toBe("0");
  });
});
