import { describe, expect, it } from "vitest";

import { eventsToRows, liveEventToRow } from "./activityRows.js";
import type { EventRow } from "./api.js";
import type { LiveEvent } from "./useProgramEvents.js";

const OWNER = "OwnerPubkey11111111111111111111111111111";

const historyRow = (
  name: string,
  payload: Record<string, unknown>,
): EventRow => ({
  slot: "1",
  signature: "SIG",
  eventIndex: 0,
  name,
  pool: "PoolPubkey1111111111111111111111111111111",
  payload,
  blockTime: null,
});

describe("activity feed row mappers", () => {
  it("maps a DepositRecorded history row to a feed row", () => {
    const rows = eventsToRows(
      [historyRow("DepositRecorded", { owner: OWNER, amount: "1500000" })],
      OWNER,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tileLabel).toBe("deposit");
    expect(rows[0]?.action).toContain("USDC");
  });

  it("maps a WithdrawalRecorded history row to a feed row", () => {
    const rows = eventsToRows(
      [historyRow("WithdrawalRecorded", { owner: OWNER, amount: "500000" })],
      OWNER,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tileLabel).toBe("withdraw");
    expect(rows[0]?.action).toContain("USDC");
  });

  it("maps a DepositRecorded live event to a feed row", () => {
    const event: LiveEvent = {
      key: "k1",
      name: "DepositRecorded",
      slot: 1,
      signature: "SIG",
      data: { owner: OWNER, amount: "1500000" },
      at: 0,
    };
    const row = liveEventToRow(event, OWNER);
    expect(row?.tileLabel).toBe("deposit");
  });

  it("maps a WithdrawalRecorded live event to a feed row", () => {
    const event: LiveEvent = {
      key: "k2",
      name: "WithdrawalRecorded",
      slot: 1,
      signature: "SIG",
      data: { owner: OWNER, amount: "500000" },
      at: 0,
    };
    const row = liveEventToRow(event, OWNER);
    expect(row?.tileLabel).toBe("withdraw");
  });
});
