import { describe, expect, it } from "vitest";

import { operatorHealthStatus } from "./health.controller";

describe("operatorHealthStatus", () => {
  it("is ok at or above the warning threshold", () => {
    expect(operatorHealthStatus(0.5, 0.5)).toBe("ok");
    expect(operatorHealthStatus(1, 0.5)).toBe("ok");
  });

  it("is degraded below the warning threshold", () => {
    expect(operatorHealthStatus(0.49, 0.5)).toBe("degraded");
    expect(operatorHealthStatus(0, 0.5)).toBe("degraded");
  });

  it("is ok on an unknown balance, rather than a false alarm", () => {
    // A failed chain read, not evidence the operator is actually dry;
    // /status's own rpcOk already flags a dead RPC.
    expect(operatorHealthStatus(null, 0.5)).toBe("ok");
  });
});
