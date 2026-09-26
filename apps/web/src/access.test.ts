import { describe, expect, it } from "vitest";

import {
  accessMessage,
  accessRetryDelayMs,
  checkErrorMessage,
  classifyRedeemError,
  gateDecision,
  inviteCodeFromSearch,
  normalizeInviteCode,
} from "./access.js";

describe("normalizeInviteCode", () => {
  it("trims and upper-cases, matching the backend", () => {
    expect(normalizeInviteCode("  abc123xy ")).toBe("ABC123XY");
  });
});

describe("accessMessage", () => {
  it("matches the backend's exact wire format", () => {
    expect(accessMessage("Ai1ce", "ABC123XY")).toBe("HEXO access: Ai1ce ABC123XY");
  });

  it("carries a referral code inside the same message when given (ticket 02)", () => {
    expect(accessMessage("Ai1ce", "ABC123XY", "REFC2345")).toBe(
      "HEXO access: Ai1ce ABC123XY ref:REFC2345",
    );
  });
});

describe("inviteCodeFromSearch", () => {
  it("prefills from ?invite=CODE", () => {
    expect(inviteCodeFromSearch("?invite=abc123xy")).toBe("abc123xy");
  });

  it("is empty with no query string", () => {
    expect(inviteCodeFromSearch("")).toBe("");
  });

  it("ignores unrelated params", () => {
    expect(inviteCodeFromSearch("?ref=someone")).toBe("");
  });
});

describe("gateDecision", () => {
  it("asks to connect first, even before any access check has run", () => {
    expect(gateDecision(false, null)).toBe("connect");
    expect(gateDecision(false, { allowed: true, reason: "x" })).toBe("connect");
  });

  it("shows checking while GET /access is in flight", () => {
    expect(gateDecision(true, null)).toBe("checking");
  });

  it("blocks with the code input until access is allowed", () => {
    expect(gateDecision(true, { allowed: false, reason: "no invite code redeemed" })).toBe(
      "redeem",
    );
  });

  it("hides once access is allowed", () => {
    expect(gateDecision(true, { allowed: true, reason: "invite code redeemed" })).toBe("hidden");
  });

  it("reports a failed check instead of checking forever", () => {
    // Pre-mainnet review: `fetchAccess` answering `ok: false` used to leave
    // the gate on "Checking…" with no error and no retry.
    expect(gateDecision(true, null, "Could not check…")).toBe("failed");
  });

  it("keeps an answer already in hand over a later failed re-check", () => {
    expect(gateDecision(true, { allowed: true, reason: "x" }, "network down")).toBe("hidden");
    expect(gateDecision(true, { allowed: false, reason: "x" }, "network down")).toBe("redeem");
  });

  it("still asks to connect first, even after a failed check", () => {
    expect(gateDecision(false, null, "network down")).toBe("connect");
  });
});

describe("checkErrorMessage", () => {
  it("names the reason and says it is retrying", () => {
    expect(checkErrorMessage("HTTP 502")).toBe(
      "Could not check this wallet's access (HTTP 502). Retrying…",
    );
  });

  it("fills in an empty reason", () => {
    expect(checkErrorMessage("")).toContain("server unreachable");
  });
});

describe("accessRetryDelayMs", () => {
  it("doubles from 2s and caps at 15s", () => {
    expect(accessRetryDelayMs(0)).toBe(2_000);
    expect(accessRetryDelayMs(1)).toBe(4_000);
    expect(accessRetryDelayMs(2)).toBe(8_000);
    expect(accessRetryDelayMs(3)).toBe(15_000);
    expect(accessRetryDelayMs(10)).toBe(15_000);
  });

  it("treats a negative attempt as the first", () => {
    expect(accessRetryDelayMs(-1)).toBe(2_000);
  });
});

describe("classifyRedeemError", () => {
  it("maps a bad signature (400)", () => {
    expect(classifyRedeemError(400, 'That signature does not match "...".')).toBe(
      "Signature refused. Try again.",
    );
  });

  it("maps an unknown code (404)", () => {
    expect(classifyRedeemError(404, "That invite code does not exist.")).toBe("Invite code not found.");
  });

  it("tells the two 409s apart by message", () => {
    expect(classifyRedeemError(409, "That invite code has no uses left.")).toBe("This invite code has no uses left.");
    expect(classifyRedeemError(409, "This wallet has already redeemed an invite code.")).toBe(
      "This wallet already redeemed an invite code.",
    );
  });

  it("falls back to the raw reason for a network failure", () => {
    expect(classifyRedeemError(null, "network down")).toBe("network down");
  });
});
