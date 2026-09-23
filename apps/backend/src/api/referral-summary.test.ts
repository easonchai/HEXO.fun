// Pure, DB-free (docs/plan/hexo-referrals ticket 11): mirrors referral.test.ts
// and referral-bonus.test.ts's own table-test style.
import { describe, expect, it } from "vitest";

import { buildReferralsResponse, maskWallet, type ReferralInput } from "./referral-summary";

const NOW = 1_700_000_000n;
const QUALIFY_SECONDS = 604_800;
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("maskWallet", () => {
  it("keeps a short string as-is", () => {
    expect(maskWallet("short")).toBe("short");
  });

  it("masks a base58 wallet to first4…last4", () => {
    expect(maskWallet(WALLET)).toBe("9xQe…VFin");
  });
});

const NO_BONUS = { amount: 0n, uncapped: 0n };

describe("buildReferralsResponse", () => {
  it("is the empty state for a wallet with no owned codes and no referrals", () => {
    const response = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(response).toEqual({
      referralCode: null,
      ownedCodes: [],
      referrals: [],
      qualifiedCount: 0,
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      bonusToday: NO_BONUS,
    });
  });

  it("passes the wallet's own referral code through, null before its first deposit", () => {
    const withCode = buildReferralsResponse("ABCD2345", [], [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(withCode.referralCode).toBe("ABCD2345");

    const withoutCode = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(withoutCode.referralCode).toBeNull();
  });

  it("reduces owned codes to code + usesLeft, floored at 0", () => {
    const response = buildReferralsResponse(
      null,
      [
        { code: "ABCD2345", maxUses: 5, uses: 2 },
        { code: "WXYZ6789", maxUses: 5, uses: 5 },
        { code: "STUV2468", maxUses: 5, uses: 9 }, // drifted past maxUses somehow
      ],
      [],
      NOW,
      QUALIFY_SECONDS,
      NO_BONUS,
    );
    expect(response.ownedCodes).toEqual([
      { code: "ABCD2345", usesLeft: 3 },
      { code: "WXYZ6789", usesLeft: 0 },
      { code: "STUV2468", usesLeft: 0 },
    ]);
  });

  it("masks each referral's wallet and reports qualified vs. days to qualify", () => {
    const referrals: ReferralInput[] = [
      { referee: WALLET, aboveSince: NOW - BigInt(QUALIFY_SECONDS) }, // exactly qualified
      { referee: WALLET, aboveSince: NOW - 100_000n }, // above, not yet qualified
      { referee: WALLET, aboveSince: null }, // never crossed the threshold
    ];
    const response = buildReferralsResponse(null, [], referrals, NOW, QUALIFY_SECONDS, NO_BONUS);
    expect(response.referrals).toEqual([
      { wallet: "9xQe…VFin", qualified: true, daysToQualify: 0 },
      { wallet: "9xQe…VFin", qualified: false, daysToQualify: 6 },
      { wallet: "9xQe…VFin", qualified: false, daysToQualify: null },
    ]);
    expect(response.qualifiedCount).toBe(1);
  });

  it("passes today's bonus amount and uncapped through unchanged", () => {
    const response = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, {
      amount: 10_000_000n,
      uncapped: 72_000_000n,
    });
    expect(response.bonusToday).toEqual({ amount: 10_000_000n, uncapped: 72_000_000n });
  });

  // Every band edge referral-bonus.ts's RATE_TIERS defines, plus 11+, so the
  // web pure test ("N more to reach X%") has a backend-verified table to
  // match against.
  const BAND_EDGES: {
    qualifiedCount: number;
    band: { tier: number; rateBps: number; minCount: number; maxCount: number | null };
    nextBand: { tier: number; rateBps: number; minCount: number; maxCount: number | null } | null;
  }[] = [
    {
      qualifiedCount: 0,
      band: { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 },
      nextBand: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
    },
    {
      qualifiedCount: 1,
      band: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      nextBand: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
    },
    {
      qualifiedCount: 2,
      band: { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 },
      nextBand: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
    },
    {
      qualifiedCount: 3,
      band: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
      nextBand: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
    },
    {
      qualifiedCount: 5,
      band: { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 },
      nextBand: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
    },
    {
      qualifiedCount: 6,
      band: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
      nextBand: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
    },
    {
      qualifiedCount: 10,
      band: { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 },
      nextBand: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
    },
    {
      qualifiedCount: 11,
      band: { tier: 4, rateBps: 500, minCount: 11, maxCount: null },
      nextBand: null,
    },
  ];

  it.each(BAND_EDGES)(
    "bands $qualifiedCount qualified referrals as $band.tier, next $nextBand.tier",
    ({ qualifiedCount, band, nextBand }) => {
      const referrals: ReferralInput[] = Array.from({ length: qualifiedCount }, () => ({
        referee: WALLET,
        aboveSince: NOW - BigInt(QUALIFY_SECONDS), // exactly qualified
      }));
      const response = buildReferralsResponse(null, [], referrals, NOW, QUALIFY_SECONDS, NO_BONUS);
      expect(response.qualifiedCount).toBe(qualifiedCount);
      expect(response.band).toEqual(band);
      expect(response.nextBand).toEqual(nextBand);
    },
  );
});
