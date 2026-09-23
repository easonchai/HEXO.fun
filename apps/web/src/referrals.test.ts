import { describe, expect, it } from "vitest";

import { referralHeroState, shareLink } from "./referrals.js";
import type { ReferralsDto } from "./api.js";

const dto = (referralCode: string | null): ReferralsDto => ({
  referralCode,
  ownedCodes: [],
  referrals: [],
  qualifiedCount: 0,
  rateBps: 0,
  countToNextBand: null,
  nextRateBps: null,
  bonusToday: "0",
  bonusYesterday: "0",
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
