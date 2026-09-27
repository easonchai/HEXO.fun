import { describe, expect, it } from "vitest";

import { launchCountdown, launchCountdownLabel } from "./launch.js";

describe("launchCountdown", () => {
  it("is unscheduled with no launch time configured", () => {
    expect(launchCountdown(null, 1_000n)).toEqual({
      scheduled: false,
      remainingSeconds: null,
    });
  });

  it("is unscheduled with no launch time even before the chain clock is known", () => {
    expect(launchCountdown(null, null)).toEqual({
      scheduled: false,
      remainingSeconds: null,
    });
  });

  it("is scheduled with an unknown remainder before the chain clock is known", () => {
    expect(launchCountdown("2026-01-01T00:00:00.000Z", null)).toEqual({
      scheduled: true,
      remainingSeconds: null,
    });
  });

  it("counts down to a future launch time", () => {
    const launchAt = new Date(1_700_003_600_000).toISOString();
    const result = launchCountdown(launchAt, 1_700_000_000n);
    expect(result.scheduled).toBe(true);
    expect(result.remainingSeconds).toBe(3_600n);
  });

  it("floors a past launch time at 0 rather than going negative", () => {
    const launchAt = new Date(1_700_000_000_000).toISOString();
    const result = launchCountdown(launchAt, 1_700_003_600n);
    expect(result.remainingSeconds).toBe(0n);
  });
});

describe("launchCountdownLabel", () => {
  it("names the unscheduled case", () => {
    expect(launchCountdownLabel(launchCountdown(null, 1_000n))).toBe(
      "First draw: not yet scheduled",
    );
  });

  it("shows a placeholder before the chain clock is known", () => {
    expect(
      launchCountdownLabel(launchCountdown("2026-01-01T00:00:00.000Z", null)),
    ).toBe("First draw in —");
  });

  it("formats the remainder as DD:HH:MM:SS", () => {
    const launchAt = new Date(1_700_003_661_000).toISOString(); // +1h 1s
    const label = launchCountdownLabel(launchCountdown(launchAt, 1_700_000_000n));
    expect(label).toBe("First draw in 00:01:01:01");
  });
});
