import { describe, expect, it } from "vitest";

import { bandProgressLabel, bpsToPercent, referralStatusLabel, shareLink } from "./referrals.js";

describe("bpsToPercent", () => {
  it("renders whole-percent basis points", () => {
    expect(bpsToPercent(200)).toBe("2%");
    expect(bpsToPercent(500)).toBe("5%");
  });
});

describe("bandProgressLabel", () => {
  // Every band edge the backend's RATE_TIERS defines (referral-bonus.ts),
  // plus 11+, matching apps/backend/src/api/referral-summary.test.ts's own table.
  it("says how many more referrals reach the next band, at each edge", () => {
    expect(bandProgressLabel(0, 1, 200)).toBe("1 more referral to reach 2%");
    expect(bandProgressLabel(200, 2, 300)).toBe("2 more referrals to reach 3%");
    expect(bandProgressLabel(200, 1, 300)).toBe("1 more referral to reach 3%");
    expect(bandProgressLabel(300, 3, 400)).toBe("3 more referrals to reach 4%");
    expect(bandProgressLabel(300, 1, 400)).toBe("1 more referral to reach 4%");
    expect(bandProgressLabel(400, 5, 500)).toBe("5 more referrals to reach 5%");
    expect(bandProgressLabel(400, 1, 500)).toBe("1 more referral to reach 5%");
  });

  it("says the top band is reached at 11+, with no next band", () => {
    expect(bandProgressLabel(500, null, null)).toBe("top band (5%)");
  });
});

describe("referralStatusLabel", () => {
  it("says qualified once the hold period is met", () => {
    expect(referralStatusLabel(true, 0)).toBe("qualified");
  });

  it("counts down days while above threshold but not yet qualified", () => {
    expect(referralStatusLabel(false, 6)).toBe("6 days to qualify");
    expect(referralStatusLabel(false, 1)).toBe("1 day to qualify");
  });

  it("says not yet above threshold when the countdown has not started", () => {
    expect(referralStatusLabel(false, null)).toBe("not yet above $50");
  });
});

describe("shareLink", () => {
  it("builds the ?invite=CODE link off the app's origin", () => {
    expect(shareLink("https://hexvault.app", "ABCD2345")).toBe(
      "https://hexvault.app/?invite=ABCD2345",
    );
  });
});
