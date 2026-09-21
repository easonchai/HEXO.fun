import { describe, expect, it } from "vitest";

import {
  accessMessage,
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
});

describe("classifyRedeemError", () => {
  it("maps a bad signature (400)", () => {
    expect(classifyRedeemError(400, 'That signature does not match "...".')).toBe(
      "signature refused",
    );
  });

  it("maps an unknown code (404)", () => {
    expect(classifyRedeemError(404, "That invite code does not exist.")).toBe("unknown code");
  });

  it("tells the two 409s apart by message", () => {
    expect(classifyRedeemError(409, "That invite code has no uses left.")).toBe("used up");
    expect(classifyRedeemError(409, "This wallet has already redeemed an invite code.")).toBe(
      "already redeemed",
    );
  });

  it("falls back to the raw reason for a network failure", () => {
    expect(classifyRedeemError(null, "network down")).toBe("network down");
  });
});
