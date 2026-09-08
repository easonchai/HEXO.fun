import { describe, expect, it } from "vitest";

import {
  addCapped,
  clampDecimals,
  estimatedYield,
  formatAddress,
  formatAtomic,
  formatAtomic2,
  formatMoney2,
  parseAtomic,
  previewBuy,
  withdrawable,
} from "./money.js";

describe("vault widget math", () => {
  it("estimates a year of yield at the APR", () => {
    expect(estimatedYield(2_400_000_000n, 500)).toBe(120_000_000n);
    expect(estimatedYield(0n, 500)).toBe(0n);
  });

  it("typed amounts stop at two decimals", () => {
    expect(clampDecimals("12.3456", 2)).toBe("12.34");
    expect(clampDecimals("1.2.3", 2)).toBe("1.23");
    expect(clampDecimals("500", 2)).toBe("500");
    expect(clampDecimals("5.", 2)).toBe("5.");
    expect(clampDecimals("abc", 2)).toBe("");
  });

  it("quick pills add and stop at the cap", () => {
    expect(addCapped(20n, 50n, 100n)).toBe(70n);
    expect(addCapped(80n, 50n, 100n)).toBe(100n);
    expect(addCapped(80n, 50n, null)).toBe(130n);
  });
});

describe("atomic formatting", () => {
  it("renders atomic units with pool decimals and never uses floats", () => {
    expect(formatAtomic(1_000_000n, 6)).toBe("1.000000");
    expect(formatAtomic(1_500_000n, 6)).toBe("1.500000");
    expect(formatAtomic(1n, 6)).toBe("0.000001");
    expect(formatAtomic(0n, 6)).toBe("0.000000");
    expect(formatAtomic(123n, 0)).toBe("123");
    expect(formatAtomic(-2_500_000n, 6)).toBe("-2.500000");
  });

  it("truncates to two decimals for display, never rounding", () => {
    expect(formatAtomic2(1_999_970_000n, 6)).toBe("1999.97");
    expect(formatAtomic2(15_000n, 6)).toBe("0.01");
    expect(formatAtomic2(0n, 6)).toBe("0.00");
    expect(formatAtomic2(-1_999_970_000n, 6)).toBe("-1999.97");
  });

  it("groups thousands for display", () => {
    expect(formatMoney2(42_759_280_000n, 6)).toBe("42,759.28");
    expect(formatMoney2(1_000_000_000n, 6)).toBe("1,000.00");
    expect(formatMoney2(999_990_000n, 6)).toBe("999.99");
    expect(formatMoney2(-1_234_567_000_000n, 6)).toBe("-1,234,567.00");
  });

  it("parses decimal text into atomic units exactly", () => {
    expect(parseAtomic("1.5", 6)).toBe(1_500_000n);
    expect(parseAtomic("12", 6)).toBe(12_000_000n);
    expect(parseAtomic(" 0.000001 ", 6)).toBe(1n);
    expect(parseAtomic("1.0000001", 6)).toBeNull();
    expect(parseAtomic("abc", 6)).toBeNull();
    expect(parseAtomic("-1", 6)).toBeNull();
    expect(parseAtomic("1.2.3", 6)).toBeNull();
    expect(parseAtomic("", 6)).toBeNull();
  });

  it("round-trips atomic -> text -> atomic", () => {
    for (const value of [0n, 1n, 999n, 1_000_000n, 123456789n]) {
      expect(parseAtomic(formatAtomic(value, 6), 6)).toBe(value);
    }
  });
});

describe("withdrawable math", () => {
  it("is the matched minimum of principal and entries", () => {
    // Entries spent on a position: principal > entries, entries binds.
    expect(withdrawable(10n, 4n)).toBe(4n);
    // Entries won in a round: principal < entries, principal binds.
    expect(withdrawable(4n, 10n)).toBe(4n);
    // Untouched since the epoch reset: equal, and both bind to the same value.
    expect(withdrawable(7n, 7n)).toBe(7n);
    expect(withdrawable(0n, 0n)).toBe(0n);
    expect(withdrawable(0n, 10n)).toBe(0n);
    expect(withdrawable(10n, 0n)).toBe(0n);
    expect(withdrawable(5_000_000n, 5_000_000n)).toBe(5_000_000n);
  });

  it("previews a board purchase before confirmation", () => {
    // 3 tiles at 1.000000 each against 5.000000 principal / 4.000000 entries.
    expect(previewBuy(5_000_000n, 4_000_000n, 3, 1_000_000n)).toEqual({
      spend: 3_000_000n,
      entriesAfter: 1_000_000n,
      withdrawableAfter: 1_000_000n,
      affordable: true,
    });
  });

  it("flags purchases that would overdraw entries", () => {
    const preview = previewBuy(5_000_000n, 2_000_000n, 3, 1_000_000n);
    expect(preview.affordable).toBe(false);
    expect(preview.entriesAfter).toBe(-1_000_000n);
    // Negative is shown on purpose: the buy would be rejected on-chain.
    expect(preview.withdrawableAfter).toBe(-1_000_000n);
  });

  it("keeps addresses short for display", () => {
    expect(formatAddress("6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB")).toBe(
      "6aDF…SGvB",
    );
    expect(formatAddress("short")).toBe("short");
  });
});
