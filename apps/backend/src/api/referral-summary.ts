// GET /referrals/:wallet's response shape (docs/plan/hexo-referrals ticket
// 11). Pure and DB-free, same home and reasoning as referral.ts and
// referral-bonus.ts: referrals.controller.ts fetches rows from Postgres and
// hands them here, so the response shape is unit tested without a database.

import { daysToQualify, isQualified } from "./referral";
import { bandForCount } from "./referral-bonus";

/** First 4 and last 4 characters of a base58 wallet, so a referrer sees who
 *  referred without seeing the full address (spec.md Frontend: "Mask
 *  referee wallets"). Short enough addresses are shown as-is. */
export function maskWallet(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/** One owned InviteCode row, reduced to what the share-link list needs. */
export interface OwnedCodeInput {
  readonly code: string;
  readonly maxUses: number;
  readonly uses: number;
}

export interface OwnedCodeDto {
  readonly code: string;
  readonly usesLeft: number;
}

/** One Referral row, reduced to what qualification needs. */
export interface ReferralInput {
  readonly referee: string;
  readonly aboveSince: bigint | null;
}

export interface ReferralRowDto {
  readonly wallet: string;
  readonly qualified: boolean;
  /** Whole days left before qualifying; null while Principal has never
   *  crossed the threshold (nothing counting down yet). */
  readonly daysToQualify: number | null;
}

export interface ReferralsResponse {
  /** The wallet's own Referral code (ADR 0014); null before its first
   *  deposit, since the indexer creates it on that event. */
  readonly referralCode: string | null;
  readonly ownedCodes: OwnedCodeDto[];
  readonly referrals: ReferralRowDto[];
  readonly qualifiedCount: number;
  /** Current band's rate, in basis points; 0 below the first tier. */
  readonly rateBps: number;
  /** Qualified referrals still needed to reach the next band; null at the
   *  top band (11+). */
  readonly countToNextBand: number | null;
  /** The next band's rate, in basis points, for "N more to reach X%"; null
   *  alongside countToNextBand at the top band. */
  readonly nextRateBps: number | null;
  readonly bonusToday: bigint;
  readonly bonusYesterday: bigint;
}

/**
 * Builds GET /referrals/:wallet's response (ticket 11; `referralCode` added
 * by ADR 0014 / docs/plan/referral-page ticket 01) from already-fetched
 * rows: this wallet's own ReferralCode, its owned InviteCodes, its
 * Referrals, and today's/yesterday's ReferralGrant amount (0n when the job
 * has not granted either day yet). `nextRateBps` calls `bandForCount` a
 * second time at `qualifiedCount + countToNextBand`, the exact count that
 * lands in the next tier, instead of re-deriving the rate table here.
 */
export function buildReferralsResponse(
  referralCode: string | null,
  ownedCodes: readonly OwnedCodeInput[],
  referrals: readonly ReferralInput[],
  now: bigint,
  qualifySeconds: number,
  bonusToday: bigint,
  bonusYesterday: bigint,
): ReferralsResponse {
  const qualifiedCount = referrals.filter((referral) =>
    isQualified(referral.aboveSince, now, qualifySeconds),
  ).length;
  const { rateBps, countToNextBand } = bandForCount(qualifiedCount);
  const nextRateBps =
    countToNextBand === null ? null : bandForCount(qualifiedCount + countToNextBand).rateBps;

  return {
    referralCode,
    ownedCodes: ownedCodes.map((invite) => ({
      code: invite.code,
      usesLeft: Math.max(0, invite.maxUses - invite.uses),
    })),
    referrals: referrals.map((referral) => ({
      wallet: maskWallet(referral.referee),
      qualified: isQualified(referral.aboveSince, now, qualifySeconds),
      daysToQualify: daysToQualify(referral.aboveSince, now, qualifySeconds),
    })),
    qualifiedCount,
    rateBps,
    countToNextBand,
    nextRateBps,
    bonusToday,
    bonusYesterday,
  };
}
