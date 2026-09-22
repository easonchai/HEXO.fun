// Against a real Postgres (docs/plan/hexo-referrals ticket 06), same shape as
// api.test.ts and indexer.test.ts: a dedicated database so a rerun, or
// another agent's suite, cannot collide with these rows. AccessController is
// exercised directly, not through the whole ApiModule: it needs no
// ChainService, so there is nothing to fake.
const TEST_DATABASE_URL =
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_access";
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Player } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { AccessController } from "./access.controller";
import { accessMessage } from "./invite-code";

const ADMIN_KEY = "k".repeat(32);

const DEPOSITOR = Keypair.generate().publicKey.toBase58();

/** Signs with a Solana keypair's own seed, mirroring what a wallet's
 *  `signMessage` does (see invite-code.test.ts). */
function sign(keypair: Keypair, message: string): string {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return bs58.encode(signEd25519(null, Buffer.from(message, "utf8"), key));
}

async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "InviteCode", "InviteRedemption", "Player", "Referral"');
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

describe("access routes", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [AccessController],
      providers: [
        { provide: ConfigService, useValue: new ConfigService({ INVITE_ADMIN_KEY: ADMIN_KEY }) },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ datasourceUrl: TEST_DATABASE_URL }))
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    prisma = app.get(PrismaService);
    await truncate(prisma);
    await prisma.player.create({ data: emptyPlayer(DEPOSITOR) });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await truncate(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.inviteCode.deleteMany();
    await prisma.inviteRedemption.deleteMany();
    await prisma.referral.deleteMany();
  });

  describe("GET /access/:wallet", () => {
    it("is not allowed for a wallet with no redemption and no Player", async () => {
      const { body } = await http
        .get(`/access/${Keypair.generate().publicKey.toBase58()}`)
        .expect(200);
      expect(body).toEqual({ allowed: false, reason: "no invite code redeemed" });
    });

    it("allows an existing depositor with no invite redeemed", async () => {
      const { body } = await http.get(`/access/${DEPOSITOR}`).expect(200);
      expect(body).toEqual({ allowed: true, reason: "existing depositor" });
    });

    it("is 400 for a malformed wallet", async () => {
      await http.get("/access/not-a-wallet").expect(400);
    });
  });

  describe("POST /access/invites", () => {
    it("401s a missing or wrong key and writes nothing", async () => {
      await http.post("/access/invites").send({ maxUses: 5 }).expect(401);
      await http
        .post("/access/invites")
        .set("x-admin-key", "wrong")
        .send({ maxUses: 5 })
        .expect(401);
      expect(await prisma.inviteCode.count()).toBe(0);
    });

    it("creates `count` owned codes that redeem binds as a referral", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const { body } = await http
        .post("/access/invites")
        .set("x-admin-key", ADMIN_KEY)
        .send({ maxUses: 3, owner, count: 2 })
        .expect(201);
      expect(body.codes).toHaveLength(2);
      const rows = await prisma.inviteCode.findMany();
      expect(rows.map((row) => row.code).sort()).toEqual([...body.codes].sort());
      expect(rows.every((row) => row.maxUses === 3 && row.ownerWallet === owner)).toBe(true);

      const wallet = Keypair.generate();
      const address = wallet.publicKey.toBase58();
      const signature = sign(wallet, accessMessage(address, body.codes[0]));
      await http
        .post("/access/redeem")
        .send({ wallet: address, code: body.codes[0], signature })
        .expect(201);
      expect(await prisma.referral.findUnique({ where: { referee: address } })).toMatchObject({
        referrer: owner,
      });
    });

    it("400s a bad body", async () => {
      for (const bad of [{}, { maxUses: 0 }, { maxUses: 1, count: 101 }, { maxUses: 1, owner: "x" }]) {
        await http.post("/access/invites").set("x-admin-key", ADMIN_KEY).send(bad).expect(400);
      }
    });
  });

  describe("POST /access/redeem", () => {
    it("400s a signature that does not match the wallet and code", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "ABCD2345", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      const signature = sign(wallet, "not the right message");
      await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "ABCD2345", signature })
        .expect(400);
    });

    it("404s a code that does not exist", async () => {
      const wallet = Keypair.generate();
      const signature = sign(
        wallet,
        accessMessage(wallet.publicKey.toBase58(), "ZZZZ9999"),
      );
      await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "ZZZZ9999", signature })
        .expect(404);
    });

    it("redeems a valid code, is case-insensitive, and updates uses", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "ABCD2345", maxUses: 5, uses: 2, createdAt: 0n, ownerWallet: null },
      });
      // The client normalizes the code to upper case before signing (same
      // rule the server applies), so a lower-case `code` field still matches.
      const signature = sign(
        wallet,
        accessMessage(wallet.publicKey.toBase58(), "ABCD2345"),
      );
      const { body } = await http
        .post("/access/redeem")
        .send({ wallet: wallet.publicKey.toBase58(), code: "abcd2345", signature })
        .expect(201);
      expect(body).toEqual({ allowed: true, reason: "invite code redeemed" });

      const code = await prisma.inviteCode.findUnique({ where: { code: "ABCD2345" } });
      expect(code?.uses).toBe(3);
      const redemption = await prisma.inviteRedemption.findUnique({
        where: { wallet: wallet.publicKey.toBase58() },
      });
      expect(redemption?.code).toBe("ABCD2345");

      const { body: access } = await http
        .get(`/access/${wallet.publicKey.toBase58()}`)
        .expect(200);
      expect(access).toEqual({ allowed: true, reason: "invite code redeemed" });
    });

    it("409s a wallet redeeming a second time", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.createMany({
        data: [
          { code: "AAAA2222", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
          { code: "BBBB3333", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
        ],
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "AAAA2222",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "AAAA2222")),
        })
        .expect(201);
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "BBBB3333",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "BBBB3333")),
        })
        .expect(409);
    });

    it("409s a code with no uses left", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "USEDUP22", maxUses: 1, uses: 1, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "USEDUP22",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "USEDUP22")),
        })
        .expect(409);
    });

    it("only lets one of two concurrent redeemers take the last use", async () => {
      await prisma.inviteCode.create({
        data: { code: "LASTONE1", maxUses: 1, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      const wallets = [Keypair.generate(), Keypair.generate()];
      const responses = await Promise.all(
        wallets.map((wallet) =>
          http.post("/access/redeem").send({
            wallet: wallet.publicKey.toBase58(),
            code: "LASTONE1",
            signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "LASTONE1")),
          }),
        ),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 409]);

      const code = await prisma.inviteCode.findUnique({ where: { code: "LASTONE1" } });
      expect(code?.uses).toBe(1);
    });
  });

  describe("referral binding (ticket 07)", () => {
    it("binds the code owner as referrer, unqualified until Principal holds", async () => {
      const owner = Keypair.generate();
      const referee = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "OWNR2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: referee.publicKey.toBase58(),
          code: "OWNR2345",
          signature: sign(referee, accessMessage(referee.publicKey.toBase58(), "OWNR2345")),
        })
        .expect(201);

      const referral = await prisma.referral.findUnique({
        where: { referee: referee.publicKey.toBase58() },
      });
      expect(referral?.referrer).toBe(owner.publicKey.toBase58());
      expect(referral?.code).toBe("OWNR2345");
      expect(referral?.aboveSince).toBeNull();
      expect(referral?.principal).toBe(0n);
    });

    it("does not bind a referral for a code with no owner", async () => {
      const wallet = Keypair.generate();
      await prisma.inviteCode.create({
        data: { code: "NOOWN123", maxUses: 5, uses: 0, createdAt: 0n, ownerWallet: null },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: wallet.publicKey.toBase58(),
          code: "NOOWN123",
          signature: sign(wallet, accessMessage(wallet.publicKey.toBase58(), "NOOWN123")),
        })
        .expect(201);
      const referral = await prisma.referral.findUnique({
        where: { referee: wallet.publicKey.toBase58() },
      });
      expect(referral).toBeNull();
    });

    it("does not bind a self-redeemed code", async () => {
      const owner = Keypair.generate();
      await prisma.inviteCode.create({
        data: {
          code: "SELF2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      await http
        .post("/access/redeem")
        .send({
          wallet: owner.publicKey.toBase58(),
          code: "SELF2345",
          signature: sign(owner, accessMessage(owner.publicKey.toBase58(), "SELF2345")),
        })
        .expect(201);
      const referral = await prisma.referral.findUnique({
        where: { referee: owner.publicKey.toBase58() },
      });
      expect(referral).toBeNull();
    });

    it("does not bind a referral for a wallet that already has a Player", async () => {
      const owner = Keypair.generate();
      const existingDepositor = Keypair.generate();
      await prisma.player.create({ data: emptyPlayer(existingDepositor.publicKey.toBase58()) });
      await prisma.inviteCode.create({
        data: {
          code: "PLYR2345",
          maxUses: 5,
          uses: 0,
          createdAt: 0n,
          ownerWallet: owner.publicKey.toBase58(),
        },
      });
      try {
        await http
          .post("/access/redeem")
          .send({
            wallet: existingDepositor.publicKey.toBase58(),
            code: "PLYR2345",
            signature: sign(
              existingDepositor,
              accessMessage(existingDepositor.publicKey.toBase58(), "PLYR2345"),
            ),
          })
          .expect(201);
        const referral = await prisma.referral.findUnique({
          where: { referee: existingDepositor.publicKey.toBase58() },
        });
        expect(referral).toBeNull();
      } finally {
        await prisma.player.delete({ where: { owner: existingDepositor.publicKey.toBase58() } });
      }
    });
  });
});
