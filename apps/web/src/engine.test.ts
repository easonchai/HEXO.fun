import { describe, expect, it } from "vitest";

import {
  buyClosesAt,
  covers,
  decideAutoRound,
  decideReveal,
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
    // Fixture round: starts 1000, ends 1060, positions close at 1055.
    expect(phaseFor(null, 1000n, buffer)).toBe("idle");
    // mine: right up to the close.
    expect(phaseFor(round(), 1000n, buffer)).toBe("mine");
    expect(phaseFor(round(), 1054n, buffer)).toBe("mine");
    // locked: from the close (inclusive) up to ends_at (exclusive).
    expect(phaseFor(round(), 1055n, buffer)).toBe("locked");
    expect(phaseFor(round(), 1059n, buffer)).toBe("locked");
    // Requested (randomness in flight) is still "locked" before ends_at —
    // the draw now starts at the close, not at ends_at.
    expect(phaseFor(round({ status: 1 }), 1057n, buffer)).toBe("locked");
    // settling: from ends_at (inclusive) while still open or requested.
    expect(phaseFor(round(), 1060n, buffer)).toBe("settling");
    expect(phaseFor(round(), 9999n, buffer)).toBe("settling");
    expect(phaseFor(round({ status: 1 }), 1060n, buffer)).toBe("settling");
    // A Round Settled early still counts down: the clock decides the phase
    // before ends_at, so the build-up keeps playing and the reveal fires at
    // zero instead of the stage blanking the moment the draw lands.
    expect(phaseFor(round({ status: 2 }), 1057n, buffer)).toBe("locked");
    expect(phaseFor(round({ status: 3 }), 1057n, buffer)).toBe("locked");
    // awaiting: revealed or Voided, from ends_at onwards.
    expect(phaseFor(round({ status: 2 }), 1060n, buffer)).toBe("awaiting");
    expect(phaseFor(round({ status: 3 }), 9999n, buffer)).toBe("awaiting");
    expect(phaseFor(round({ status: 4 }), 9999n, buffer)).toBe("awaiting");
    expect(buyClosesAt(round(), buffer)).toBe(1055n);
  });

  it("counts seconds left down to ends_at through mine and locked, zero elsewhere", () => {
    const buffer = 5n;
    // mine: counts to ends_at (1060), not to the close.
    expect(secondsLeft(round(), buffer, 1040n)).toBe(20n);
    expect(secondsLeft(round(), buffer, 1054n)).toBe(6n);
    // locked: the same countdown continues past the close.
    expect(secondsLeft(round(), buffer, 1055n)).toBe(5n);
    expect(secondsLeft(round(), buffer, 1059n)).toBe(1n);
    // settling: holds at zero rather than going negative.
    expect(secondsLeft(round(), buffer, 1060n)).toBe(0n);
    expect(secondsLeft(round(), buffer, 9999n)).toBe(0n);
    // A Round Settled early keeps its countdown: the timer runs to zero and
    // the laser fires there, so the draw landing early is invisible.
    expect(secondsLeft(round({ status: 2 }), buffer, 1057n)).toBe(3n);
    // awaiting (revealed or Voided, past ends_at): nothing left to count.
    expect(secondsLeft(round({ status: 2 }), buffer, 1060n)).toBe(0n);
    expect(secondsLeft(round({ status: 3 }), buffer, 9999n)).toBe(0n);
    expect(secondsLeft(round({ status: 4 }), buffer, 9999n)).toBe(0n);
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
      "phase settling",
      board,
      1000n,
      "settling" as Phase,
      false,
      "round is not open for positions",
    ],
    [
      "phase locked",
      board,
      1000n,
      "locked" as Phase,
      false,
      "round is not open for positions",
    ],
  ])("%s → skip", (_label, remembered, entries, phase, hasPosition, reason) => {
    expect(
      decideAutoRound(
        remembered as RememberedBoard | null,
        entries,
        phase,
        hasPosition,
      ),
    ).toEqual({ action: "skip", reason });
  });

  it("places the remembered board when everything checks out", () => {
    expect(decideAutoRound(board, 1000n, "mine", false)).toEqual({
      action: "place",
      tiles: board.tiles,
      stake: board.stake,
    });
  });
});

describe("decideReveal", () => {
  // Fixture: a remembered, revealed round with ends_at 1060.
  const remembered = round({ roundId: 3n, endsAt: 1060n, status: 2 });
  const noPlayed: ReadonlySet<string> = new Set();

  it("waits with no remembered result yet, whatever the clock reads", () => {
    expect(decideReveal(null, 1000n, 1060n, noPlayed)).toBe("wait");
    expect(decideReveal(null, 1060n, 1060n, noPlayed)).toBe("wait");
    expect(decideReveal(null, 9999n, 1060n, noPlayed)).toBe("wait");
  });

  it("waits while the result is known and the clock is before ends_at", () => {
    expect(decideReveal(remembered, 1000n, 1060n, noPlayed)).toBe("wait");
    expect(decideReveal(remembered, 1059n, 1060n, noPlayed)).toBe("wait");
  });

  it("fires at ends_at when the result is known earlier", () => {
    expect(decideReveal(remembered, 1060n, 1060n, noPlayed)).toBe("fire");
  });

  it("fires on arrival when the result is checked after ends_at has passed", () => {
    // The result only just became known (this is the first non-null call for
    // it), but the clock has already moved past ends_at — draw was slow.
    expect(decideReveal(remembered, 1075n, 1060n, noPlayed)).toBe("fire");
  });

  it("does nothing for a round already played, before or after ends_at", () => {
    const played = new Set([roundKey(remembered.roundId)]);
    expect(decideReveal(remembered, 1000n, 1060n, played)).toBe("nothing");
    expect(decideReveal(remembered, 1060n, 1060n, played)).toBe("nothing");
    expect(decideReveal(remembered, 9999n, 1060n, played)).toBe("nothing");
  });

  it("keys the played set by round id, not by object identity", () => {
    // A different round id in the played set does not block this one.
    const played = new Set([roundKey(999n)]);
    expect(decideReveal(remembered, 1060n, 1060n, played)).toBe("fire");
  });
});
