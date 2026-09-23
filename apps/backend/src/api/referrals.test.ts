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

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Player, Pool } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { applyReferralMessage } from "./invite-code";
import { ReferralsController } from "./referrals.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const REFERRER = Keypair.generate().publicKey.toBase58();
const POOL_ADDRESS = Keypair.generate().publicKey.toBase58();

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Pool", "InviteCode", "Referral", "ReferralGrant", "ReferralCode", "Player"',
  );
}

/** Signs with a Solana keypair's own seed, mirroring what a wallet's
 *  `signMessage` does (see access.test.ts). */
function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

const emptyPlayer = (owner: string): Player => ({
  owner,
  principal: 0n,
  entries: 0n,
  weightAcc: new Prisma.Decimal(0),
  lastUpdate: 0n,
  epochId: 0n,
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
  version: 1,
  shutdown: false,
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
    await prisma.referralCode.deleteMany();
    await prisma.player.deleteMany();
  });

  it("400s a malformed wallet", async () => {
    await http.get("/referrals/not-a-wallet").expect(400);
  });

  it("is the empty state for a wallet with nothing indexed yet (no pool either)", async () => {
    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body).toEqual({
      referralCode: null,
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

  it("returns the wallet's own referral code once the indexer has created one", async () => {
    await prisma.referralCode.create({
      data: { code: "ABCD2345", owner: REFERRER, createdAt: 0n },
    });

    const { body } = await http.get(`/referrals/${REFERRER}`).expect(200);
    expect(body.referralCode).toBe("ABCD2345");
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

describe.skipIf(!DB_AVAILABLE)("POST /referrals/apply", () => {
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
    await prisma.referral.deleteMany();
    await prisma.referralCode.deleteMany();
    await prisma.player.deleteMany();
  });

  it("400s a signature that does not match the wallet and code", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(wallet, "not the right message"),
      })
      .expect(400);
  });

  it("400s a redeem signature replayed here (ADR 0014: distinct messages)", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(wallet, `HEXO access: ${wallet.publicKey.toBase58()} OWNR2345`),
      })
      .expect(400);
  });

  it("binds the referral code owner as referrer", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "OWNR2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "OWNR2345",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "OWNR2345"),
        ),
      })
      .expect(200);
    expect(body).toEqual({ applied: true, reason: "referral applied" });

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.referrer).toBe(owner.publicKey.toBase58());
    expect(referral?.code).toBe("OWNR2345");
  });

  it("quietly declines a wallet that has already deposited", async () => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "DEPO2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });
    await prisma.player.create({ data: emptyPlayer(wallet.publicKey.toBase58()) });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "DEPO2345",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "DEPO2345"),
        ),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral).toBeNull();
  });

  it("quietly declines a wallet that already has a Referrer, without overwriting it", async () => {
    const firstReferrer = Keypair.generate();
    const secondReferrer = Keypair.generate();
    const wallet = Keypair.generate();
    await prisma.referral.create({
      data: {
        referee: wallet.publicKey.toBase58(),
        referrer: firstReferrer.publicKey.toBase58(),
        code: "FIRST111",
        boundAt: 0n,
      },
    });
    await prisma.referralCode.create({
      data: { code: "SECOND22", owner: secondReferrer.publicKey.toBase58(), createdAt: 0n },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "SECOND22",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "SECOND22"),
        ),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral?.referrer).toBe(firstReferrer.publicKey.toBase58());
    expect(referral?.code).toBe("FIRST111");
  });

  it("quietly declines a self-applied code", async () => {
    const owner = Keypair.generate();
    await prisma.referralCode.create({
      data: { code: "SELF2345", owner: owner.publicKey.toBase58(), createdAt: 0n },
    });

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: owner.publicKey.toBase58(),
        code: "SELF2345",
        signature: sign(owner, applyReferralMessage(owner.publicKey.toBase58(), "SELF2345")),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: owner.publicKey.toBase58() },
    });
    expect(referral).toBeNull();
  });

  it("quietly declines an unknown code", async () => {
    const wallet = Keypair.generate();

    const { body } = await http
      .post("/referrals/apply")
      .send({
        wallet: wallet.publicKey.toBase58(),
        code: "ZZZZ9999",
        signature: sign(
          wallet,
          applyReferralMessage(wallet.publicKey.toBase58(), "ZZZZ9999"),
        ),
      })
      .expect(200);
    expect(body.applied).toBe(false);

    const referral = await prisma.referral.findUnique({
      where: { referee: wallet.publicKey.toBase58() },
    });
    expect(referral).toBeNull();
  });
});
