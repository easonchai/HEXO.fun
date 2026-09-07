import { describe, expect, it } from "vitest";

import { eventsToRows, isRowVisible, liveEventToRow } from "./activityRows.js";
import type { EventDto } from "./api.js";
import type { FeedRow } from "./engine.js";
import type { LiveEvent } from "./useProgramEvents.js";

const OWNER = "OwnerPubkey11111111111111111111111111111";

const historyRow = (
  name: string,
  data: Record<string, unknown>,
): EventDto => ({
  slot: "1",
  signature: "SIG",
  index: 0,
  name,
  data,
  blockTime: null,
});

const liveRow = (name: string, data: Record<string, unknown>): LiveEvent => ({
  key: `k-${name}`,
  name,
  slot: 1,
  signature: "SIG",
  data,
  at: 0,
});

describe("activity feed row mappers", () => {
  it("maps a Deposited history row to a feed row", () => {
    const rows = eventsToRows(
      [historyRow("Deposited", { owner: OWNER, amount: "1500000" })],
      OWNER,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tileLabel).toBe("deposit");
    expect(rows[0]?.who).toBe("you");
    expect(rows[0]?.action).toBe("+1.50 USDC");
  });

  it("maps a Withdrawn history row to a feed row", () => {
    const rows = eventsToRows(
      [historyRow("Withdrawn", { owner: OWNER, amount: "500000" })],
      OWNER,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tileLabel).toBe("withdraw");
    expect(rows[0]?.action).toContain("USDC");
  });

  it("counts the tiles in a PositionBought mask", () => {
    const rows = eventsToRows(
      [
        historyRow("PositionBought", {
          owner: OWNER,
          tiles: String((1n << 3n) | (1n << 9n) | (1n << 30n)),
          total: "3000000",
        }),
      ],
      OWNER,
    );
    expect(rows[0]?.tileLabel).toBe("3 tiles");
    expect(rows[0]?.action).toBe("−3.00 Tickets");
  });

  it("reads the same events off a live log, camelCased by Anchor", () => {
    expect(
      liveEventToRow(liveRow("deposited", { owner: OWNER, amount: "1500000" }), OWNER)
        ?.tileLabel,
    ).toBe("deposit");
    expect(
      liveEventToRow(
        liveRow("roundSettled", { winningTile: 7, pot: "10", forfeited: false }),
        OWNER,
      )?.action,
    ).toBe("tile 8");
  });

  it("renders every name GET /feed sends, in either casing", () => {
    // The backend's FEED_NAMES list, plus PositionSettled with a reward.
    const sent = [
      historyRow("Deposited", { owner: OWNER, amount: "1000000" }),
      historyRow("Withdrawn", { owner: OWNER, amount: "1000000" }),
      historyRow("PositionBought", { owner: OWNER, tiles: "1", total: "1" }),
      historyRow("RoundSettled", { winning_tile: 0, forfeited: true }),
      historyRow("JackpotPaid", { winner: OWNER, amount: "1000000" }),
      historyRow("EpochRolledOver", { epochId: "3", jackpotAmount: "12000000" }),
      historyRow("PositionSettled", { owner: OWNER, reward: "5000000" }),
    ];
    const rows = eventsToRows(sent, OWNER);
    expect(rows).toHaveLength(sent.length);
    expect(rows.map((row) => row.tileLabel)).toContain("rollover");
    expect(rows.find((row) => row.tileLabel === "rollover")?.action).toBe(
      "12.00 USDC stays in the jackpot",
    );
  });

  it("drops a zero-reward settle and anything it does not recognise", () => {
    expect(
      liveEventToRow(liveRow("positionSettled", { owner: OWNER, reward: "0" }), OWNER),
    ).toBeNull();
    expect(liveEventToRow(liveRow("paramsSet", {}), OWNER)).toBeNull();
  });

  it("carries the round id on the two rows a reveal can hold, not on others", () => {
    expect(
      liveEventToRow(
        liveRow("roundSettled", { roundId: "42", winningTile: 2, forfeited: false }),
        OWNER,
      )?.roundId,
    ).toBe("42");
    expect(
      liveEventToRow(
        liveRow("positionSettled", { owner: OWNER, roundId: "42", reward: "500" }),
        OWNER,
      )?.roundId,
    ).toBe("42");
    expect(
      liveEventToRow(
        liveRow("positionBought", { owner: OWNER, tiles: "1", total: "1" }),
        OWNER,
      )?.roundId,
    ).toBeUndefined();
  });
});

describe("isRowVisible (activity feed hold)", () => {
  const settleRow: FeedRow = {
    key: "s1",
    who: "pool",
    action: "tile 3",
    tileLabel: "settled",
    roundId: "7",
  };
  const rewardRow: FeedRow = {
    key: "p1",
    who: "you",
    action: "+1 Tickets",
    tileLabel: "round reward",
    roundId: "7",
  };
  const boughtRow: FeedRow = {
    key: "b1",
    who: "you",
    action: "−1 Tickets",
    tileLabel: "3 tiles",
  };

  it("holds a settle row while its reveal is pending", () => {
    expect(isRowVisible(settleRow, "pending")).toBe(false);
  });

  it("holds a settle row while its reveal is firing, before the land", () => {
    expect(isRowVisible(settleRow, "firing")).toBe(false);
  });

  it("releases a settle row at the land", () => {
    expect(isRowVisible(settleRow, "landed")).toBe(true);
  });

  it("never holds a settle row for a Round with no pending reveal", () => {
    expect(isRowVisible(settleRow, "none")).toBe(true);
  });

  it("holds a rewarded Position row under the same rule the settle row follows", () => {
    expect(isRowVisible(rewardRow, "pending")).toBe(false);
    expect(isRowVisible(rewardRow, "firing")).toBe(false);
    expect(isRowVisible(rewardRow, "landed")).toBe(true);
  });

  it("never holds a PositionBought row, whatever the reveal state", () => {
    expect(isRowVisible(boughtRow, "pending")).toBe(true);
    expect(isRowVisible(boughtRow, "firing")).toBe(true);
    expect(isRowVisible(boughtRow, "landed")).toBe(true);
    expect(isRowVisible(boughtRow, "none")).toBe(true);
  });
});
