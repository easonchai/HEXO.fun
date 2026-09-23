import { describe, expect, it } from "vitest";

import {
  bandForCount,
  computeBonuses,
  REFERRAL_BONUS_BASIS_CAP,
  remainingGrantCap,
  type ReferrerBonusInput,
} from "./referral-bonus";

const USDC = 1_000_000n;
/** Ample Principal so a referrer's own remaining-headroom cap never binds
 *  unless a test is specifically about it. */
const BIG_PRINCIPAL = 1_000_000n * USDC;
/** Wide enough that the pool-wide cap never binds unless a test is
 *  specifically about it. */
const NO_POOL_CAP = { totalPrincipal: 1_000_000_000n * USDC, capBps: 10_000 };

function referrer(
  referrer: string,
  qualifiedReferralPrincipals: bigint[],
  principal = BIG_PRINCIPAL,
  alreadyGrantedToday = 0n,
): ReferrerBonusInput {
  return { referrer, principal, alreadyGrantedToday, qualifiedReferralPrincipals };
}

describe("computeBonuses: rate tiers by qualified count", () => {
  it("0 qualified referrals earns nothing", () => {
    expect(
      computeBonuses([referrer("r", [])], NO_POOL_CAP.totalPrincipal, NO_POOL_CAP.capBps),
    ).toEqual([]);
  });

  it.each([
    [1, 200],
    [2, 200],
    [3, 300],
    [5, 300],
    [6, 400],
    [10, 400],
    [11, 500],
  ])("%d qualified referrals rates at %d bps", (count, rateBps) => {
    const referrals = Array.from({ length: count }, () => 10_000_000n); // 10 USDC each
    const [bonus] = computeBonuses(
      [referrer("r", referrals)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus).toMatchObject({ qualifiedCount: count, rateBps });
  });
});

describe("computeBonuses: the worked example", () => {
  it("6 referrals at 300 USDC each, rate 4%, basis 1800 USDC -> 72 USDC of tickets", () => {
    const referrals = Array.from({ length: 6 }, () => 300n * USDC);
    const [bonus] = computeBonuses(
      [referrer("r", referrals)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus?.amount).toBe(72n * USDC);
  });
});

describe("computeBonuses: the $2,500 per-referral basis cap", () => {
  it("a single referral above $2,500 only contributes $2,500 to the basis", () => {
    // Rate tier 1 (200 bps) on a lone 5,000 USDC referral: uncapped basis
    // would give 100 USDC; capped at 2,500 it gives 50.
    const [bonus] = computeBonuses(
      [referrer("r", [5_000n * USDC])],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus?.amount).toBe((REFERRAL_BONUS_BASIS_CAP * 200n) / 10_000n);
    expect(bonus?.amount).toBe(50n * USDC);
  });
});

describe("computeBonuses: the referrer's own remaining-headroom cap", () => {
  it("caps the bonus at the referrer's own Principal", () => {
    // 11+ referrals at 2,500 USDC each rates 5%: basis far exceeds a small
    // referrer's own Principal, so the payout is capped at that Principal.
    const referrals = Array.from({ length: 11 }, () => 2_500n * USDC);
    const [bonus] = computeBonuses(
      [referrer("r", referrals, 10n * USDC)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus?.amount).toBe(10n * USDC);
  });

  it("the reported worked case: $10 Principal, 11 referrals at $2,500 caps at $10, never the raw $1,375", () => {
    // 5% of Sigma min(2,500, 2,500) * 11 = 5% of 27,500 = 1,375 USDC raw;
    // the referrer only holds 10 USDC, so that is the ceiling.
    const referrals = Array.from({ length: 11 }, () => 2_500n * USDC);
    const [bonus] = computeBonuses(
      [referrer("r", referrals, 10n * USDC)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus?.amount).toBe(10n * USDC);
    expect(bonus?.amount).not.toBe(1_375n * USDC);
  });

  it("shrinks the cap by what the operator path already granted them today", () => {
    // Same referrer, 100 USDC Principal, but 90 already granted this epoch:
    // only 10 USDC of headroom is left, well under the uncapped bonus.
    const [bonus] = computeBonuses(
      [referrer("r", [1_000n * USDC], 100n * USDC, 90n * USDC)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus?.amount).toBe(10n * USDC);
  });

  it("a referrer already granted their full Principal today earns nothing more", () => {
    expect(
      computeBonuses(
        [referrer("r", [1_000n * USDC], 100n * USDC, 100n * USDC)],
        NO_POOL_CAP.totalPrincipal,
        NO_POOL_CAP.capBps,
      ),
    ).toEqual([]);
  });
});

describe("remainingGrantCap", () => {
  it("is the Principal when nothing has been granted today", () => {
    expect(remainingGrantCap(100n, 0n)).toBe(100n);
  });

  it("subtracts what has already been granted today", () => {
    expect(remainingGrantCap(100n, 40n)).toBe(60n);
  });

  it("floors at 0 rather than going negative", () => {
    expect(remainingGrantCap(100n, 150n)).toBe(0n);
  });

  it("is 0 exactly at the Principal", () => {
    expect(remainingGrantCap(100n, 100n)).toBe(0n);
  });
});

describe("computeBonuses: pool-wide pro-rata scale-down", () => {
  it("scales every bonus down proportionally, floored, when the sum exceeds the pool cap", () => {
    // Two referrers, each 3 qualified referrals of 1,000 USDC (rate 3%,
    // basis 3,000 USDC, 90 USDC bonus, 180 total), against a pool cap of
    // only 150 USDC: each should land at 75.
    const threeReferrals = Array.from({ length: 3 }, () => 1_000n * USDC);
    const inputs = [referrer("a", threeReferrals), referrer("b", threeReferrals)];
    const totalPrincipal = 3_000n * USDC; // 5% cap bps -> 150 USDC pool cap
    const bonuses = computeBonuses(inputs, totalPrincipal, 500);
    const total = bonuses.reduce((sum, bonus) => sum + bonus.amount, 0n);
    expect(total).toBeLessThanOrEqual((totalPrincipal * 500n) / 10_000n);
    expect(bonuses.map((bonus) => bonus.amount).sort()).toEqual([75n * USDC, 75n * USDC]);
  });

  it("does not scale when the sum is already within the pool cap", () => {
    const inputs = [referrer("a", [10n * USDC])];
    const bonuses = computeBonuses(inputs, NO_POOL_CAP.totalPrincipal, NO_POOL_CAP.capBps);
    expect(bonuses).toEqual([
      { referrer: "a", amount: 200_000n, uncapped: 200_000n, qualifiedCount: 1, rateBps: 200 },
    ]);
  });

  it("a scale-down that floors a small bonus to 0 leaves it out", () => {
    // A tiny bonus (shrimp) alongside a large one (whale) that is already at
    // the $2,500 basis cap: with the pool cap this small, whale's share still
    // floors to a positive number but shrimp's floors to 0 and drops out.
    const inputs = [referrer("whale", [3_000n * USDC]), referrer("shrimp", [10_000n])];
    const bonuses = computeBonuses(inputs, 10_000_000n, 1); // pool cap floors to 1,000 atomic units
    expect(bonuses.some((bonus) => bonus.referrer === "shrimp")).toBe(false);
    expect(bonuses.some((bonus) => bonus.referrer === "whale")).toBe(true);
  });
});

describe("computeBonuses: referrers who earn nothing", () => {
  it("zero qualified referrals -> nothing", () => {
    expect(
      computeBonuses(
        [referrer("r", [])],
        NO_POOL_CAP.totalPrincipal,
        NO_POOL_CAP.capBps,
      ),
    ).toEqual([]);
  });

  it("a referrer with no Player (principal 0) -> nothing", () => {
    expect(
      computeBonuses(
        [referrer("r", [10n * USDC], 0n)],
        NO_POOL_CAP.totalPrincipal,
        NO_POOL_CAP.capBps,
      ),
    ).toEqual([]);
  });

  it("mixes an eligible referrer with an ineligible one: only the eligible one is returned", () => {
    const bonuses = computeBonuses(
      [referrer("earns", [10n * USDC]), referrer("nothing", [])],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonuses.map((bonus) => bonus.referrer)).toEqual(["earns"]);
  });
});

// referral-page ticket 04: `uncapped` is `amount` before the own-Principal
// cap, with the pool-wide scale-down still applied. Four cases: neither cap
// binds, only the own cap, only the pool cap, and both.
describe("computeBonuses: uncapped", () => {
  it("not capped: uncapped equals amount when neither cap binds", () => {
    const [bonus] = computeBonuses(
      [referrer("r", [10n * USDC])],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus).toMatchObject({ amount: 200_000n, uncapped: 200_000n });
  });

  it("own-Principal cap binding: uncapped is the raw grant, amount is capped at the Principal", () => {
    // Same worked case as "the reported worked case" above: 11 referrals at
    // $2,500 (5% tier) raw to $1,375, a $10 Principal caps amount at $10.
    const referrals = Array.from({ length: 11 }, () => 2_500n * USDC);
    const [bonus] = computeBonuses(
      [referrer("r", referrals, 10n * USDC)],
      NO_POOL_CAP.totalPrincipal,
      NO_POOL_CAP.capBps,
    );
    expect(bonus).toMatchObject({ amount: 10n * USDC, uncapped: 1_375n * USDC });
  });

  it("pool-wide scale binding without an own-Principal cap: uncapped still equals amount", () => {
    // Same worked case as the pool-wide scale-down test above: both
    // referrers' own cap is ample, so their pre-scale amount and uncapped
    // are identical and the same cap/sum factor lands them on 75 USDC each.
    const threeReferrals = Array.from({ length: 3 }, () => 1_000n * USDC);
    const inputs = [referrer("a", threeReferrals), referrer("b", threeReferrals)];
    const bonuses = computeBonuses(inputs, 3_000n * USDC, 500);
    for (const bonus of bonuses) {
      expect(bonus.amount).toBe(75n * USDC);
      expect(bonus.uncapped).toBe(bonus.amount);
    }
  });

  it("both binding: the pool scale-down shrinks uncapped too, but it stays above amount", () => {
    // 11 referrals at $2,500 (5% tier, raw/uncapped pre-scale $1,375), a $100
    // Principal caps amount pre-scale at $100. A single referrer's pool
    // scale is exact (amount*cap/sum === cap since amount === sum), so a
    // $40 pool cap lands amount at exactly $40 and uncapped at exactly
    // $1,375 * 40/100 = $550.
    const referrals = Array.from({ length: 11 }, () => 2_500n * USDC);
    const [bonus] = computeBonuses(
      [referrer("r", referrals, 100n * USDC)],
      4_000n * USDC,
      100, // 1% of $4,000 = $40 pool cap
    );
    expect(bonus).toMatchObject({ amount: 40n * USDC, uncapped: 550n * USDC });
  });
});

describe("bandForCount", () => {
  it("0 qualified referrals: tier 0 (no rate), next band is tier 1 (1-2, 200 bps)", () => {
    expect(bandForCount(0)).toEqual({
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
    });
  });

  it("4 qualified referrals: tier 2 (3-5, 300 bps), next band is tier 3 (6-10, 400 bps)", () => {
    expect(bandForCount(4)).toEqual({
      band: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
      nextBand: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
    });
  });

  it.each([
    [1, { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 }, { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 }],
    [2, { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 }, { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 }],
    [3, { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 }, { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 }],
    [5, { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 }, { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 }],
    [6, { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 }, { tier: 4, rateBps: 500, minCount: 11, maxCount: null }],
    [10, { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 }, { tier: 4, rateBps: 500, minCount: 11, maxCount: null }],
  ])("%d qualified referrals bands as %o, next %o", (count, band, nextBand) => {
    expect(bandForCount(count)).toEqual({ band, nextBand });
  });

  it("the top band (11+, tier 4) has no next band", () => {
    expect(bandForCount(11)).toEqual({
      band: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
      nextBand: null,
    });
    expect(bandForCount(50)).toEqual({
      band: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
      nextBand: null,
    });
  });
});
