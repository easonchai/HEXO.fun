import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { isUniqueConstraintViolation } from "./access.controller";
import { applyReferralMessage, normalizeInviteCode, verifyApplyReferralSignature } from "./invite-code";
import { buildReferralsResponse } from "./referral-summary";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const parseWallet = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

interface ApplyReferralBody {
  wallet: PublicKey;
  code: string;
  signature: Uint8Array;
}

function parseApplyReferralBody(body: unknown): ApplyReferralBody {
  const raw = body as
    | { wallet?: unknown; code?: unknown; signature?: unknown }
    | null
    | undefined;
  if (typeof raw?.wallet !== "string" || raw.wallet.length === 0) {
    throw new BadRequestException("Send a JSON body with a `wallet` address.");
  }
  // parseWallet above already validates and round-trips through toBase58();
  // re-wrapping it in a PublicKey here cannot throw.
  const wallet = new PublicKey(parseWallet(raw.wallet));
  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new BadRequestException("Send a JSON body with a referral `code`.");
  }
  if (typeof raw.signature !== "string" || raw.signature.length === 0) {
    throw new BadRequestException("Send a JSON body with a base58 `signature`.");
  }
  let signature: Uint8Array;
  try {
    signature = bs58.decode(raw.signature);
  } catch {
    throw new BadRequestException("`signature` must be base58.");
  }
  if (signature.length !== 64) {
    throw new BadRequestException("`signature` must be a 64-byte ed25519 signature.");
  }
  return { wallet, code: normalizeInviteCode(raw.code), signature };
}

/**
 * The referrals screen (docs/plan/hexo-referrals ticket 11): this wallet's
 * own Referral code (ADR 0014), its owned invite codes, its referrals with
 * qualification state, the current band and today's bonus `{amount,
 * uncapped}` (referral-page ticket 04). The response shape lives in
 * referral-summary.ts's `buildReferralsResponse` so it is unit tested
 * without a database; this controller only fetches the rows it needs.
 *
 * Not throttled, like the rest of ApiController's read routes: api.module.ts
 * only throttles the faucet, access and `POST /referrals/apply` below, which
 * spend resources or are worth rate-limiting against script abuse. This is a
 * plain wallet-keyed read, the same shape as GET /players/:owner.
 */
@Controller("referrals")
export class ReferralsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<HexVaultEnv, true>,
  ) {}

  @Get(":wallet")
  async getReferrals(@Param("wallet") walletRaw: string) {
    const wallet = parseWallet(walletRaw);
    const qualifySeconds = this.config.get("REFERRAL_QUALIFY_SECONDS", { infer: true });

    const [referralCode, ownedCodes, referrals, pool] = await Promise.all([
      this.prisma.referralCode.findUnique({
        where: { owner: wallet },
        select: { code: true },
      }),
      this.prisma.inviteCode.findMany({
        where: { ownerWallet: wallet },
        select: { code: true, maxUses: true, uses: true },
      }),
      this.prisma.referral.findMany({
        where: { referrer: wallet },
        select: { referee: true, aboveSince: true },
      }),
      this.prisma.pool.findFirst(),
    ]);

    const grantToday = await this.bonusGrant(pool?.currentEpochId, wallet);

    return buildReferralsResponse(
      referralCode?.code ?? null,
      ownedCodes,
      referrals,
      nowSeconds(),
      qualifySeconds,
      { amount: grantToday?.amount ?? 0n, uncapped: grantToday?.uncapped ?? 0n },
    );
  }

  /**
   * `POST /referrals/apply` (ADR 0014, ticket 02): covers a wallet already
   * past the beta gate that opens a `?ref=CODE` link before its first
   * deposit. One ed25519 signature over
   * `applyReferralMessage(wallet, code)` (invite-code.ts), distinct from the
   * redeem message so one can't be replayed as the other. Throttled in
   * api.module.ts alongside access, same abuse shape as redeem.
   *
   * Binding only writes a Referral when the wallet has no Referral yet, has
   * no Player yet (never deposited), the code exists, and its owner is not
   * the wallet itself. Any of those failing answers 200 with `applied:
   * false` and a reason, never an error, so the web can ignore it quietly.
   * Only a bad signature is a 4xx.
   */
  @Post("apply")
  @HttpCode(HttpStatus.OK)
  async applyReferral(@Body() body: unknown) {
    const { wallet, code, signature } = parseApplyReferralBody(body);
    if (!verifyApplyReferralSignature(wallet, code, signature)) {
      throw new BadRequestException(
        `That signature does not match "${applyReferralMessage(wallet.toBase58(), code)}".`,
      );
    }
    const address = wallet.toBase58();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingReferral = await tx.referral.findUnique({ where: { referee: address } });
        if (existingReferral !== null) {
          return { applied: false, reason: "This wallet already has a Referrer." };
        }
        const player = await tx.player.findUnique({ where: { owner: address } });
        if (player !== null) {
          return { applied: false, reason: "This wallet has already deposited." };
        }
        const referralCode = await tx.referralCode.findUnique({ where: { code } });
        if (referralCode === null) {
          return { applied: false, reason: "That referral code does not exist." };
        }
        if (referralCode.owner === address) {
          return { applied: false, reason: "You cannot apply your own referral code." };
        }
        await tx.referral.create({
          data: { referee: address, referrer: referralCode.owner, code, boundAt: nowSeconds() },
        });
        return { applied: true, reason: "referral applied" };
      });
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) {
        return { applied: false, reason: "This wallet already has a Referrer." };
      }
      throw cause;
    }
  }

  /** undefined `epochId` (no pool indexed yet) short-circuits without a
   *  query. */
  private bonusGrant(epochId: bigint | undefined, referrer: string) {
    if (epochId === undefined) return Promise.resolve(null);
    return this.prisma.referralGrant.findUnique({
      where: { epochId_referrer: { epochId, referrer } },
      select: { amount: true, uncapped: true },
    });
  }
}
