import { describe, expect, it } from "vitest";

import {
  buyClosesAt,
  covers,
  currentRound,
  displayTile,
  expectedReward,
  latestSettled,
  phaseFor,
  secondsLeft,
  timerText,
  type PositionLike,
  type RoundLike,
} from "./engine.js";

const round = (overrides: Partial<RoundLike> = {}): RoundLike => ({
  epochId: 1n,
  id: 1n,
  startsAt: 1000n,
  endsAt: 1120n,
  status: 0,
  winningTile: 0,
  bonusEntries: 0n,
  totalStake: 0n,
  tileStakes: new Array(36).fill(0n),
  ...overrides,
});

const position = (overrides: Partial<PositionLike> = {}): PositionLike => ({
  roundId: 1n,
  tiles: 0n,
  stakePerTile: 1n,
  rewardClaimed: false,
  ...overrides,
});

describe("round engine", () => {
  it("picks the highest round id as current", () => {
    expect(currentRound([])).toBeNull();
    expect(
      currentRound([round({ id: 3n }), round({ id: 7n }), round({ id: 5n })])!
        .id,
    ).toBe(7n);
  });

  it("picks the newest settled round across epochs", () => {
    expect(latestSettled([round({ id: 1n, status: 0 })])).toBeNull();
    const picked = latestSettled([
      round({ id: 1n, status: 2, winningTile: 4 }),
      round({ id: 2n, status: 2, winningTile: 9 }),
      round({ id: 3n, status: 0 }),
    ]);
    expect(picked!.winningTile).toBe(9);
  });

  it("derives phases from status and chain time", () => {
    const buffer = 5n;
    expect(phaseFor(null, 1000n, buffer)).toBe("idle");
    // Fixture round: starts 1000, ends 1120, buys close at 1115.
    expect(phaseFor(round(), 1114n, buffer)).toBe("mine");
    expect(phaseFor(round(), 1115n, buffer)).toBe("settling");
    expect(phaseFor(round({ status: 1 }), 1000n, buffer)).toBe("settling");
    expect(phaseFor(round({ status: 2 }), 1000n, buffer)).toBe("awaiting");
    expect(buyClosesAt(round(), buffer)).toBe(1115n);
    expect(secondsLeft(round(), buffer, 1100n)).toBe(15n);
    expect(secondsLeft(round(), buffer, 9999n)).toBe(0n);
  });

  it("computes the proportional bonus reward with floor division", () => {
    const settled = round({
      status: 2,
      winningTile: 7,
      bonusEntries: 1000n,
      tileStakes: round().tileStakes.map((_, tile) =>
        tile === 7 ? 300n : 100n,
      ),
    });
    // Covers tile 7 with 2 per tile: 1000 * 2 / 300 = 6 (floored).
    const winner = position({
      tiles: (1n << 7n) | (1n << 3n),
      stakePerTile: 2n,
    });
    expect(expectedReward(settled, winner)).toBe(6n);
    // A losing tile pays nothing even with the same stake.
    const loser = position({ tiles: 1n << 3n, stakePerTile: 2n });
    expect(expectedReward(settled, loser)).toBe(0n);
    expect(covers(winner.tiles, 7)).toBe(true);
    expect(covers(loser.tiles, 7)).toBe(false);
  });

  it("renders the timer and display tile numbers", () => {
    expect(timerText(65n)).toBe("01:05");
    expect(timerText(5n)).toBe("00:05");
    expect(timerText(0n)).toBe("00:00");
    expect(displayTile(0)).toBe(1);
    expect(displayTile(35)).toBe(36);
  });
});
