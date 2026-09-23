import { describe, expect, it } from "vitest";

import {
  applyReferralMessage,
  bonusRateView,
  refCodeFromSearch,
  referralBonusCardState,
  referralHeroState,
  shareLink,
} from "./referrals.js";
import type { ReferralBandDto, ReferralsDto } from "./api.js";

const ZERO_BAND: ReferralBandDto = { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 };
const TIER_1: ReferralBandDto = { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 };
const TIER_2: ReferralBandDto = { tier: 2, rateBps: 300, minCount: 3, maxCount: 5 };
const TIER_3: ReferralBandDto = { tier: 3, rateBps: 400, minCount: 6, maxCount: 10 };
const TIER_4: ReferralBandDto = { tier: 4, rateBps: 500, minCount: 11, maxCount: null };

const dto = (
  referralCode: string | null,
  bonusToday: { amount: string; uncapped: string } = { amount: "0", uncapped: "0" },
): ReferralsDto => ({
  referralCode,
  ownedCodes: [],
  referrals: [],
  qualifiedCount: 0,
  band: ZERO_BAND,
  nextBand: TIER_1,
  bonusToday,
});

describe("referralHeroState", () => {
  it("is disconnected with no owner, regardless of any loaded data", () => {
    expect(referralHeroState(null, null)).toEqual({ kind: "disconnected" });
    expect(referralHeroState(undefined, dto("ABCD2345"))).toEqual({ kind: "disconnected" });
  });

  it("is no-code once connected before the poll has landed", () => {
    expect(referralHeroState("11111111111111111111111111111111", null)).toEqual({
      kind: "no-code",
    });
  });

  it("is no-code once connected with no Referral code yet (never deposited)", () => {
    expect(referralHeroState("11111111111111111111111111111111", dto(null))).toEqual({
      kind: "no-code",
    });
  });

  it("carries the code once connected with one", () => {
    expect(referralHeroState("11111111111111111111111111111111", dto("ABCD2345"))).toEqual({
      kind: "has-code",
      code: "ABCD2345",
    });
  });
});

describe("shareLink", () => {
  it("builds the ?ref=CODE link off the app's origin", () => {
    expect(shareLink("https://hexvault.app", "ABCD2345")).toBe(
      "https://hexvault.app/?ref=ABCD2345",
    );
  });
});

describe("refCodeFromSearch", () => {
  it("reads ?ref=CODE", () => {
    expect(refCodeFromSearch("?ref=abc123xy")).toBe("abc123xy");
  });

  it("is empty with no query string", () => {
    expect(refCodeFromSearch("")).toBe("");
  });

  it("ignores unrelated params", () => {
    expect(refCodeFromSearch("?invite=someone")).toBe("");
  });
});

describe("applyReferralMessage", () => {
  it("matches the backend's exact wire format", () => {
    expect(applyReferralMessage("Ai1ce", "ABC123XY")).toBe(
      "HEXO apply referral: Ai1ce ABC123XY",
    );
  });
});

const OWNER = "11111111111111111111111111111111";

const bandDto = (
  qualifiedCount: number,
  band: ReferralBandDto,
  nextBand: ReferralBandDto | null,
): ReferralsDto => ({ ...dto(null), qualifiedCount, band, nextBand });

describe("bonusRateView", () => {
  it("is disconnected with no owner, regardless of any loaded data", () => {
    expect(bonusRateView(null, null)).toEqual({ kind: "disconnected" });
    expect(bonusRateView(undefined, bandDto(4, TIER_2, TIER_3))).toEqual({ kind: "disconnected" });
  });

  it("is the zero state at 0 qualified referrals: 0%, no tier line, empty bar, points at tier 1", () => {
    expect(bonusRateView(OWNER, bandDto(0, ZERO_BAND, TIER_1))).toEqual({
      kind: "ready",
      ratePercent: "0%",
      tierLabel: null,
      progressFraction: 0,
      progressCopy: "1-2 qualified referrals unlock 2%",
    });
  });

  it("treats no data yet (poll not landed) the same as the zero state", () => {
    expect(bonusRateView(OWNER, null)).toEqual({
      kind: "ready",
      ratePercent: "0%",
      tierLabel: null,
      progressFraction: 0,
      progressCopy: "1-2 qualified referrals unlock 2%",
    });
  });

  it("mid-band: 4 qualified referrals sits in Tier 2, 2 more to unlock 4%", () => {
    expect(bonusRateView(OWNER, bandDto(4, TIER_2, TIER_3))).toEqual({
      kind: "ready",
      ratePercent: "3%",
      tierLabel: "TIER 2 (3-5 QUALIFIED REFERRALS)",
      progressFraction: 4 / 6,
      progressCopy: "4 qualified referrals · 2 more to unlock 4%",
    });
  });

  it("is full with 'Max tier' at the top tier (11+), which has no next band", () => {
    expect(bonusRateView(OWNER, bandDto(14, TIER_4, null))).toEqual({
      kind: "ready",
      ratePercent: "5%",
      tierLabel: "TIER 4 (11+ QUALIFIED REFERRALS)",
      progressFraction: 1,
      progressCopy: "14 qualified referrals · Max tier",
    });
  });
});

describe("referralBonusCardState", () => {
  const atomic = (whole: number) => String(whole * 1_000_000);

  it("is disconnected with no owner, regardless of any loaded data", () => {
    expect(referralBonusCardState(null, null)).toEqual({ kind: "disconnected" });
    expect(referralBonusCardState(undefined, dto("ABCD2345"))).toEqual({ kind: "disconnected" });
  });

  it("is not-capped at 0 before the poll has landed (no data yet)", () => {
    expect(referralBonusCardState(OWNER, null)).toEqual({ kind: "not-capped", amount: 0 });
  });

  it("is not-capped at 0 once connected with no grant today", () => {
    const data = dto("ABCD2345");
    expect(referralBonusCardState(OWNER, data)).toEqual({ kind: "not-capped", amount: 0 });
  });

  it("is not-capped when the own-Principal cap didn't bind (uncapped == amount)", () => {
    const data = dto("ABCD2345", { amount: atomic(72), uncapped: atomic(72) });
    expect(referralBonusCardState(OWNER, data)).toEqual({ kind: "not-capped", amount: 72 });
  });

  it("is capped with the hint amount when uncapped exceeds amount", () => {
    const data = dto("ABCD2345", { amount: atomic(10), uncapped: atomic(72) });
    expect(referralBonusCardState(OWNER, data)).toEqual({
      kind: "capped",
      amount: 10,
      uncapped: 72,
      hintUsdc: 62,
    });
  });

  it("truncates atomic amounts to whole Tickets", () => {
    const data = dto("ABCD2345", { amount: "10999999", uncapped: "10999999" });
    expect(referralBonusCardState(OWNER, data)).toEqual({ kind: "not-capped", amount: 10 });
  });
});
