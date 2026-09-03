import { describe, expect, it } from "vitest";

import {
  epochMilestones,
  hexFromBytes,
  labelEpochStatus,
  labelJackpotStatus,
  labelRoundStatus,
  labelRequestKind,
  labelRequestStatus,
  maskToTiles,
  popcount,
  TILE_COUNT,
  tileGridLabel,
  tilesToMask,
} from "./protocol.js";

describe("epoch timeline", () => {
  const epoch = {
    startsAt: 100n,
    entryCutoffAt: 200n,
    endsAt: 300n,
    prizeSnapshotAt: 300n,
    claimDeadline: 400n,
  };

  it("marks each window past/active/pending from a single clock reading", () => {
    expect(epochMilestones(epoch, 250n).map((m) => [m.label, m.state])).toEqual(
      [
        ["Epoch started", "past"],
        ["Entry cutoff", "past"],
        ["Rounds end", "active"],
        ["Prize snapshot", "pending"],
        ["Claim deadline", "pending"],
      ],
    );
  });

  it("treats the last window as past once the deadline passes", () => {
    const states = epochMilestones(epoch, 400n).map((m) => m.state);
    expect(states.every((state) => state === "past")).toBe(true);
  });

  it("renders snapshot roots as hex", () => {
    expect(hexFromBytes([0, 1, 15, 255])).toBe("0x00010fff");
    expect(hexFromBytes(new Uint8Array(32)).length).toBe(66);
  });
});

describe("tile mask parsing", () => {
  it("parses '1,7,22' into a bitmask and back", () => {
    const mask = tilesToMask("1,7,22");
    expect(mask).toBe((1n << 1n) | (1n << 7n) | (1n << 22n));
    expect(maskToTiles(mask!)).toEqual([1, 7, 22]);
    expect(popcount(mask!)).toBe(3);
  });

  it("dedupes and tolerates whitespace", () => {
    expect(tilesToMask(" 5 , 5,9 ")).toBe((1n << 5n) | (1n << 9n));
    expect(maskToTiles(tilesToMask(" 5 , 5,9 ")!)).toEqual([5, 9]);
  });

  it("round-trips every tile on the 6x6 board", () => {
    expect(TILE_COUNT).toBe(36);
    const all = Array.from({ length: TILE_COUNT }, (_, tile) => tile);
    const text = all.join(",");
    expect(maskToTiles(tilesToMask(text)!)).toEqual(all);
    expect(popcount(tilesToMask(text)!)).toBe(36);
    expect(maskToTiles(0n)).toEqual([]);
    expect(tilesToMask("")).toBeNull();
  });

  it("rejects out-of-range and malformed input", () => {
    expect(tilesToMask("36")).toBeNull();
    expect(tilesToMask("-1")).toBeNull();
    expect(tilesToMask("1,")).toBeNull();
    expect(tilesToMask("1,x")).toBeNull();
    expect(tilesToMask("1.0")).toBeNull();
  });

  it("labels tiles by board coordinate", () => {
    expect(tileGridLabel(0)).toBe("row 1, col 1");
    expect(tileGridLabel(7)).toBe("row 2, col 2");
    expect(tileGridLabel(35)).toBe("row 6, col 6");
  });
});

describe("state labels", () => {
  it("names every epoch status", () => {
    expect(labelEpochStatus(0)).toBe("Open");
    expect(labelEpochStatus(1)).toBe("Snapshot committed");
    expect(labelEpochStatus(3)).toBe("Prize drawn");
    expect(labelEpochStatus(4)).toBe("Prize claimed");
    expect(labelEpochStatus(5)).toBe("Prize expired");
    expect(labelEpochStatus(99)).toBe("unknown (99)");
  });

  it("names jackpot, round and request states", () => {
    expect(labelJackpotStatus(0)).toBe("None");
    expect(labelJackpotStatus(3)).toBe("Claimed");
    expect(labelJackpotStatus(4)).toBe("Expired");
    expect(labelRoundStatus(2)).toBe("Settled");
    expect(labelRequestStatus(1)).toBe("Fulfilled");
    expect(labelRequestKind(2)).toBe("jackpot");
  });
});
