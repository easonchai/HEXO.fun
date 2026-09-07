import { describe, expect, it } from "vitest";

import { summarizeStatus } from "./status.js";
import type { StatusDto } from "./api.js";

const NOW = Date.parse("2026-09-06T00:00:10.000Z");

const status = (overrides: Partial<StatusDto> = {}): StatusDto => ({
  operator: {
    id: 1,
    lastTickAt: "2026-09-06T00:00:08.000Z",
    lastAction: "settleRound",
    lastError: null,
    registeredCount: null,
    registeredTotal: null,
  },
  cursor: { lastSlot: "1", lastSignature: "x", ageSeconds: 1 },
  rpcOk: true,
  slot: 1,
  aprBps: 500,
  ...overrides,
});

describe("summarizeStatus", () => {
  it("is offline when the backend never answers", () => {
    expect(summarizeStatus(null, NOW)).toEqual({
      tone: "warn",
      label: "OFFLINE",
      detail: "backend unreachable",
      stale: true,
    });
  });

  it("is starting when the operator has never ticked", () => {
    const result = summarizeStatus(status({ operator: null }), NOW);
    expect(result.tone).toBe("warn");
    expect(result.stale).toBe(true);
    expect(result.label).toBe("STARTING");
  });

  it("is live on a fresh tick with no error", () => {
    // Tick was 2 s before NOW.
    const result = summarizeStatus(status(), NOW);
    expect(result).toEqual({ tone: "ok", label: "LIVE", detail: "tick 2s ago", stale: false });
  });

  it("is stale once the tick is 10 s old or more, even with no error", () => {
    const stale = status({
      operator: {
        id: 1,
        lastTickAt: "2026-09-05T23:59:59.000Z",
        lastAction: "settleRound",
        lastError: null,
        registeredCount: null,
        registeredTotal: null,
      },
    });
    const result = summarizeStatus(stale, NOW);
    expect(result.tone).toBe("warn");
    expect(result.stale).toBe(true);
    expect(result.label).toBe("STALLED");
  });

  it("goes amber on a fresh tick that still carries an error", () => {
    const errored = status({
      operator: {
        id: 1,
        lastTickAt: "2026-09-06T00:00:09.000Z",
        lastAction: "settleRound",
        lastError: "insufficient jackpot vault balance",
        registeredCount: null,
        registeredTotal: null,
      },
    });
    const result = summarizeStatus(errored, NOW);
    expect(result.tone).toBe("warn");
    expect(result.stale).toBe(true);
    expect(result.label).toBe("insufficient jackpot vault balance");
  });

  it("treats a never-synced cursor (null, not 0) as amber even with a fresh tick", () => {
    const neverSynced = status({
      cursor: { lastSlot: null, lastSignature: null, ageSeconds: null },
    });
    const result = summarizeStatus(neverSynced, NOW);
    expect(result.tone).toBe("warn");
    expect(result.stale).toBe(true);
    expect(result.label).toBe("SYNCING");
  });

  it("stays green through a quiet round: the cursor only moves on events and the 60 s sweep", () => {
    const quietRound = status({
      cursor: { lastSlot: "1", lastSignature: "x", ageSeconds: 45 },
    });
    const result = summarizeStatus(quietRound, NOW);
    expect(result.tone).toBe("ok");
    expect(result.stale).toBe(false);
  });

  it("goes amber when the indexer cursor outlives a sweep even though the operator ticked", () => {
    const laggingCursor = status({
      cursor: { lastSlot: "1", lastSignature: "x", ageSeconds: 120 },
    });
    const result = summarizeStatus(laggingCursor, NOW);
    expect(result.tone).toBe("warn");
    expect(result.stale).toBe(true);
    expect(result.label).toBe("SYNCING");
    expect(result.detail).toBe("indexer lag 120s");
  });
});
