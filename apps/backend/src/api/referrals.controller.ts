import { BadRequestException, Controller, Get, Param } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PublicKey } from "@solana/web3.js";

import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { buildReferralsResponse } from "./referral-summary";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const parseWallet = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

/**
 * The referrals screen (docs/plan/hexo-referrals ticket 11): this wallet's
 * own Referral code (ADR 0014), its owned invite codes, its referrals with
 * qualification state, the current band and today's/yesterday's bonus. The
 * response shape lives in
 * referral-summary.ts's `buildReferralsResponse` so it is unit tested
 * without a database; this controller only fetches the rows it needs.
 *
 * Not throttled, like the rest of ApiController's read routes: api.module.ts
 * only throttles the faucet and access, which spend resources or are worth
 * rate-limiting against script abuse. This is a plain wallet-keyed read, the
 * same shape as GET /players/:owner.
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

    const [grantToday, grantYesterday] = await Promise.all([
      this.bonusGrant(pool?.currentEpochId, wallet),
      this.bonusGrant(
        pool !== null && pool.currentEpochId > 0n ? pool.currentEpochId - 1n : undefined,
        wallet,
      ),
    ]);

    return buildReferralsResponse(
      referralCode?.code ?? null,
      ownedCodes,
      referrals,
      nowSeconds(),
      qualifySeconds,
      grantToday?.amount ?? 0n,
      grantYesterday?.amount ?? 0n,
    );
  }

  /** undefined `epochId` (no pool indexed yet, or no epoch before the
   *  first) short-circuits without a query. */
  private bonusGrant(epochId: bigint | undefined, referrer: string) {
    if (epochId === undefined) return Promise.resolve(null);
    return this.prisma.referralGrant.findUnique({
      where: { epochId_referrer: { epochId, referrer } },
      select: { amount: true },
    });
  }
}
