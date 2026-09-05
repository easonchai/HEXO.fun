import { describe, expect, it } from "vitest";

import {
  buyClosesAt,
  covers,
  decideAutoRound,
  displayTile,
  expectedReward,
  hmText,
  isRevealed,
  phaseFor,
  roundKey,
  secondsLeft,
  timerText,
  type Phase,
  type PositionLike,
  type RememberedBoard,
  type RoundLike,
} from "./engine.js";

const round = (overrides: Partial<RoundLike> = {}): RoundLike => ({
  roundId: 1n,
  epochId: 1n,
  startsAt: 1000n,
  endsAt: 1060n,
  status: 0,
  winningTile: 0,
  pot: 0n,
  tileTotals: new Array(36).fill(0n),
  ...overrides,
});

const position = (overrides: Partial<PositionLike> = {}): PositionLike => ({
  tiles: 0n,
  stakePerTile: 1n,
  ...overrides,
});

describe("round engine", () => {
  it("keys a round by its pool-wide round id", () => {
    expect(roundKey(7n)).toBe("7");
  });

  it("derives phases from status and chain time", () => {
    const buffer = 5n;
    expect(phaseFor(null, 1000n, buffer)).toBe("idle");
    // Fixture round: starts 1000, ends 1060, positions close at 1055.
    expect(phaseFor(round(), 1054n, buffer)).toBe("mine");
    expect(phaseFor(round(), 1055n, buffer)).toBe("settling");
    expect(phaseFor(round({ status: 1 }), 1000n, buffer)).toBe("settling");
    expect(phaseFor(round({ status: 2 }), 1000n, buffer)).toBe("awaiting");
    expect(buyClosesAt(round(), buffer)).toBe(1055n);
    expect(secondsLeft(round(), buffer, 1040n)).toBe(15n);
    expect(secondsLeft(round(), buffer, 9999n)).toBe(0n);
  });

  it("treats Settled and Forfeited as revealed, nothing else", () => {
    expect(isRevealed(round({ status: 0 }))).toBe(false);
    expect(isRevealed(round({ status: 1 }))).toBe(false);
    expect(isRevealed(round({ status: 2 }))).toBe(true);
    expect(isRevealed(round({ status: 3 }))).toBe(true);
    expect(isRevealed(round({ status: 4 }))).toBe(false);
  });

  it("computes the round reward pro rata with floor division", () => {
    const settled = round({
      status: 2,
      winningTile: 7,
      pot: 1000n,
      tileTotals: round().tileTotals.map((_, tile) =>
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
    // A forfeited round pays nobody: the pot went to the House.
    expect(expectedReward({ ...settled, status: 3 }, winner)).toBe(0n);
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

  it("renders HH:MM for epoch-length countdowns", () => {
    expect(hmText(0n)).toBe("00:00");
    expect(hmText(59n)).toBe("00:00");
    expect(hmText(60n)).toBe("00:01");
    expect(hmText(3600n)).toBe("01:00");
    expect(hmText(90_000n)).toBe("25:00");
    // Already past: clamp, no sign.
    expect(hmText(-5n)).toBe("00:00");
  });
});

describe("decideAutoRound", () => {
  const board: RememberedBoard = { tiles: [1, 2, 3], stake: 10n };

  it.each([
    [
      "no remembered board",
      null,
      1000n,
      "mine" as Phase,
      false,
      "no remembered board",
    ],
    [
      "empty tiles",
      { tiles: [], stake: 10n },
      1000n,
      "mine" as Phase,
      false,
      "remembered board has no tiles",
    ],
    [
      "zero stake",
      { tiles: [1, 2], stake: 0n },
      1000n,
      "mine" as Phase,
      false,
      "remembered stake is zero",
    ],
    [
      "stake exceeding Entries",
      board,
      5n,
      "mine" as Phase,
      false,
      "stake exceeds Entries",
    ],
    [
      "Position already placed",
      board,
      1000n,
      "mine" as Phase,
      true,
      "position already placed this round",
    ],
    [
      "phase not mine",
      board,
      1000n,
      "settling" as Phase,
      false,
      "round is not open for positions",
    ],
  ])(
    "%s → skip",
    (_label, remembered, entries, phase, hasPosition, reason) => {
      expect(
        decideAutoRound(
          remembered as RememberedBoard | null,
          entries,
          phase,
          hasPosition,
        ),
      ).toEqual({ action: "skip", reason });
    },
  );

  it("places the remembered board when everything checks out", () => {
    expect(decideAutoRound(board, 1000n, "mine", false)).toEqual({
      action: "place",
      tiles: board.tiles,
      stake: board.stake,
    });
  });
});
