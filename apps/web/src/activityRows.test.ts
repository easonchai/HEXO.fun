import { describe, expect, it } from "vitest";

import { eventsToRows, liveEventToRow } from "./activityRows.js";
import type { EventDto } from "./api.js";
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
    expect(rows[0]?.action).toBe("+1.5 USDC");
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
    expect(rows[0]?.action).toBe("−3 Entries");
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
      "12 USDC held over",
    );
  });

  it("drops a zero-reward settle and anything it does not recognise", () => {
    expect(
      liveEventToRow(liveRow("positionSettled", { owner: OWNER, reward: "0" }), OWNER),
    ).toBeNull();
    expect(liveEventToRow(liveRow("paramsSet", {}), OWNER)).toBeNull();
  });
});
