import { describe, expect, it } from "vitest";

import { HexVaultProjection, type EventEnvelope } from "./index.js";

const event = (
  name: EventEnvelope["name"],
  data: Record<string, unknown>,
  eventIndex: number,
): EventEnvelope => ({
  programId: "HexVault1111111111111111111111111111111111",
  name,
  data,
  cursor: { slot: 99n, signature: "signature-1", eventIndex },
  finality: "finalized",
});

describe("HexVaultProjection", () => {
  it("is idempotent and records matching principal/entry minting", () => {
    const projection = new HexVaultProjection();
    const deposit = event(
      "DepositRecorded",
      { owner: "alice", amount: "1000000" },
      0,
    );

    expect(projection.apply(deposit)).toBe(true);
    expect(projection.apply(deposit)).toBe(false);
    expect(projection.players.get("alice")).toMatchObject({
      principalMinted: 1_000_000n,
      entriesMinted: 1_000_000n,
      entriesSpent: 0n,
    });
  });

  it("projects immutable positions and settlement with an in-range tile", () => {
    const projection = new HexVaultProjection();
    projection.apply(
      event(
        "PositionPurchased",
        {
          owner: "alice",
          round: "round-1",
          epochId: "3",
          roundId: "7",
          totalStake: "50",
        },
        0,
      ),
    );
    projection.apply(
      event("RoundSettled", { round: "round-1", winningTile: "35" }, 1),
    );

    expect(projection.rounds.get("round-1")).toMatchObject({
      settled: true,
      winningTile: 35,
      totalStaked: 50n,
    });
    expect(projection.players.get("alice")?.entriesSpent).toBe(50n);
  });

  it("rejects a late finalized event instead of silently corrupting a checkpoint", () => {
    const projection = new HexVaultProjection();
    projection.apply(event("PrizeFunded", {}, 3));

    expect(() => projection.apply(event("PrizeFunded", {}, 2))).toThrow(
      "out-of-order",
    );
  });
});
