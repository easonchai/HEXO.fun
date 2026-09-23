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

describe("buildReferralsResponse", () => {
  it("is the empty state for a wallet with no owned codes and no referrals", () => {
    const response = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, 0n, 0n);
    expect(response).toEqual({
      referralCode: null,
      ownedCodes: [],
      referrals: [],
      qualifiedCount: 0,
      rateBps: 0,
      countToNextBand: 1,
      nextRateBps: 200,
      bonusToday: 0n,
      bonusYesterday: 0n,
    });
  });

  it("passes the wallet's own referral code through, null before its first deposit", () => {
    const withCode = buildReferralsResponse("ABCD2345", [], [], NOW, QUALIFY_SECONDS, 0n, 0n);
    expect(withCode.referralCode).toBe("ABCD2345");

    const withoutCode = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, 0n, 0n);
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
      0n,
      0n,
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
    const response = buildReferralsResponse(null, [], referrals, NOW, QUALIFY_SECONDS, 0n, 0n);
    expect(response.referrals).toEqual([
      { wallet: "9xQe…VFin", qualified: true, daysToQualify: 0 },
      { wallet: "9xQe…VFin", qualified: false, daysToQualify: 6 },
      { wallet: "9xQe…VFin", qualified: false, daysToQualify: null },
    ]);
    expect(response.qualifiedCount).toBe(1);
  });

  it("passes today's and yesterday's bonus amounts through unchanged", () => {
    const response = buildReferralsResponse(null, [], [], NOW, QUALIFY_SECONDS, 72_000_000n, 50_000_000n);
    expect(response.bonusToday).toBe(72_000_000n);
    expect(response.bonusYesterday).toBe(50_000_000n);
  });

  // Every band edge referral-bonus.ts's RATE_TIERS defines, plus 11+, so the
  // web pure test ("N more to reach X%") has a backend-verified table to
  // match against.
  const BAND_EDGES: {
    qualifiedCount: number;
    rateBps: number;
    countToNextBand: number | null;
    nextRateBps: number | null;
  }[] = [
    { qualifiedCount: 0, rateBps: 0, countToNextBand: 1, nextRateBps: 200 },
    { qualifiedCount: 1, rateBps: 200, countToNextBand: 2, nextRateBps: 300 },
    { qualifiedCount: 2, rateBps: 200, countToNextBand: 1, nextRateBps: 300 },
    { qualifiedCount: 3, rateBps: 300, countToNextBand: 3, nextRateBps: 400 },
    { qualifiedCount: 5, rateBps: 300, countToNextBand: 1, nextRateBps: 400 },
    { qualifiedCount: 6, rateBps: 400, countToNextBand: 5, nextRateBps: 500 },
    { qualifiedCount: 10, rateBps: 400, countToNextBand: 1, nextRateBps: 500 },
    { qualifiedCount: 11, rateBps: 500, countToNextBand: null, nextRateBps: null },
  ];

  it.each(BAND_EDGES)(
    "bands $qualifiedCount qualified referrals as rate $rateBps, countToNextBand $countToNextBand, nextRateBps $nextRateBps",
    ({ qualifiedCount, rateBps, countToNextBand, nextRateBps }) => {
      const referrals: ReferralInput[] = Array.from({ length: qualifiedCount }, () => ({
        referee: WALLET,
        aboveSince: NOW - BigInt(QUALIFY_SECONDS), // exactly qualified
      }));
      const response = buildReferralsResponse(null, [], referrals, NOW, QUALIFY_SECONDS, 0n, 0n);
      expect(response.qualifiedCount).toBe(qualifiedCount);
      expect(response.rateBps).toBe(rateBps);
      expect(response.countToNextBand).toBe(countToNextBand);
      expect(response.nextRateBps).toBe(nextRateBps);
    },
  );
});
