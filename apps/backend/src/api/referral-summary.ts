// GET /referrals/:wallet's response shape (docs/plan/hexo-referrals ticket
// 11). Pure and DB-free, same home and reasoning as referral.ts and
// referral-bonus.ts: referrals.controller.ts fetches rows from Postgres and
// hands them here, so the response shape is unit tested without a database.

import { daysToQualify, isQualified } from "./referral";
import { bandForCount, type ReferralBand } from "./referral-bonus";

/** First 4 and last 4 characters of a base58 wallet, so a referrer sees who
 *  referred without seeing the full address (spec.md Frontend: "Mask
 *  referee wallets"). Short enough addresses are shown as-is. */
export function maskWallet(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/** One owned InviteCode row, reduced to what the wallet's own-codes list
 *  needs (referral-page ticket 07). */
export interface InviteCodeInput {
  readonly code: string;
  readonly maxUses: number;
  readonly uses: number;
}

export interface InviteCodeDto {
  readonly code: string;
  readonly redeemed: boolean;
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
  /** This wallet's own Invite codes, granted by redeeming one (ticket 07);
   *  no web UI yet. */
  readonly inviteCodes: InviteCodeDto[];
  readonly referrals: ReferralRowDto[];
  readonly qualifiedCount: number;
  /** Current band (referral-page ticket 03); tier 0 means no rate yet. */
  readonly band: ReferralBand;
  /** The next, higher band; null at the top band (11+). */
  readonly nextBand: ReferralBand | null;
  /** referral-page ticket 04: atomic Ticket amounts. `uncapped` is what the
   *  Referrer would get without their own Principal capping it; the web
   *  shows the capped-hint state only when it's greater than `amount`.
   *  `bonusYesterday` is gone (spec.md "Referrals API response"). */
  readonly bonusToday: { amount: bigint; uncapped: bigint };
}

/**
 * Builds GET /referrals/:wallet's response (ticket 11; `referralCode` added
 * by ADR 0014 / docs/plan/referral-page ticket 01; `inviteCodes` by ticket
 * 07) from already-fetched rows: this wallet's own ReferralCode, its owned InviteCodes, its
 * Referrals, and today's ReferralGrant `{amount, uncapped}` (both 0n when
 * the job has not granted today yet — referral-page ticket 04).
 * `band`/`nextBand` (referral-page ticket 03) come straight from
 * `bandForCount`.
 */
export function buildReferralsResponse(
  referralCode: string | null,
  inviteCodes: readonly InviteCodeInput[],
  referrals: readonly ReferralInput[],
  now: bigint,
  qualifySeconds: number,
  bonusToday: { amount: bigint; uncapped: bigint },
): ReferralsResponse {
  const qualifiedCount = referrals.filter((referral) =>
    isQualified(referral.aboveSince, now, qualifySeconds),
  ).length;
  const { band, nextBand } = bandForCount(qualifiedCount);

  return {
    referralCode,
    inviteCodes: inviteCodes.map((invite) => ({
      code: invite.code,
      redeemed: invite.uses >= invite.maxUses,
    })),
    referrals: referrals.map((referral) => ({
      wallet: maskWallet(referral.referee),
      qualified: isQualified(referral.aboveSince, now, qualifySeconds),
      daysToQualify: daysToQualify(referral.aboveSince, now, qualifySeconds),
    })),
    qualifiedCount,
    band,
    nextBand,
    bonusToday,
  };
}
