// Daily referral bonus math (docs/plan/hexo-referrals ticket 08). Pure and
// DB-free, same home and reasoning as referral.ts: the operator's daily job
// imports this without pulling in Prisma, and it is table-tested on its own.
//
// spec.md "Daily referral bonus job": for each referrer with a Player and a
// Principal of their own, the qualified-referral count picks a rate tier,
// applied to the sum of those referrals' own Principal (each counted up to
// $2,500), capped at the referrer's own Principal, then scaled down
// pool-wide (floored) if the total would exceed the epoch's bonus cap.

/** Qualified-referral counts to rate tiers, in basis points: 1-2 -> 2%,
 *  3-5 -> 3%, 6-10 -> 4%, 11+ -> 5%. Checked highest `min` first so the
 *  first match wins. */
const RATE_TIERS: readonly { min: number; rateBps: number }[] = [
  { min: 11, rateBps: 500 },
  { min: 6, rateBps: 400 },
  { min: 3, rateBps: 300 },
  { min: 1, rateBps: 200 },
];

/** $2,500 at 6 decimals: a qualified referral counts toward its referrer's
 *  basis only up to this much of its own Principal. */
export const REFERRAL_BONUS_BASIS_CAP = 2_500_000_000n;

/**
 * One referrer's inputs: their own Principal (their own 1x cap) and one
 * entry per qualified referral, that referral's own Principal (for the
 * basis sum). A referrer with no Player, or a Principal of 0, gets nothing
 * either way `principal` is passed as 0n: the per-Player on-chain cap would
 * refuse them regardless.
 */
export interface ReferrerBonusInput {
  readonly referrer: string;
  readonly principal: bigint;
  readonly qualifiedReferralPrincipals: readonly bigint[];
}

export interface ReferrerBonus {
  readonly referrer: string;
  readonly amount: bigint;
  readonly qualifiedCount: number;
  readonly rateBps: number;
}

function rateBpsFor(qualifiedCount: number): number {
  return RATE_TIERS.find((tier) => qualifiedCount >= tier.min)?.rateBps ?? 0;
}

/** One referrer's bonus before the pool-wide cap scales it down. */
function preScaleBonus(input: ReferrerBonusInput): ReferrerBonus {
  const qualifiedCount = input.qualifiedReferralPrincipals.length;
  const rateBps = rateBpsFor(qualifiedCount);
  if (rateBps === 0 || input.principal <= 0n) {
    return { referrer: input.referrer, amount: 0n, qualifiedCount, rateBps };
  }
  const basis = input.qualifiedReferralPrincipals.reduce(
    (sum, principal) =>
      sum + (principal < REFERRAL_BONUS_BASIS_CAP ? principal : REFERRAL_BONUS_BASIS_CAP),
    0n,
  );
  const raw = (basis * BigInt(rateBps)) / 10_000n;
  const amount = raw < input.principal ? raw : input.principal;
  return { referrer: input.referrer, amount, qualifiedCount, rateBps };
}

/**
 * Every referrer's daily bonus (docs/plan/hexo-referrals ticket 08): each
 * one's own cap first, then a single pool-wide pro-rata scale-down (floored)
 * when the sum would exceed `totalPrincipal * capBps / 10_000`. A referrer
 * whose bonus comes out to 0, before or after scaling, is left out of the
 * result: `grant_tickets` refuses a zero amount.
 */
export function computeBonuses(
  referrers: readonly ReferrerBonusInput[],
  totalPrincipal: bigint,
  capBps: number,
): ReferrerBonus[] {
  const preScaled = referrers.map(preScaleBonus).filter((bonus) => bonus.amount > 0n);
  if (preScaled.length === 0) return [];

  const sum = preScaled.reduce((total, bonus) => total + bonus.amount, 0n);
  const cap = (totalPrincipal * BigInt(capBps)) / 10_000n;
  if (sum <= cap) return preScaled;

  return preScaled
    .map((bonus) => ({ ...bonus, amount: (bonus.amount * cap) / sum }))
    .filter((bonus) => bonus.amount > 0n);
}
