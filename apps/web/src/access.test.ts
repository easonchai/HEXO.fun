import { describe, expect, it } from "vitest";

import {
  accessMessage,
  classifyRedeemError,
  gateDecision,
  inviteCodeFromSearch,
  normalizeInviteCode,
  pendingStep,
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
  const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const base = { ready: true, connected: true, owner: WALLET, access: null, rememberedOwner: "" };

  it("paints nothing while the wallet layer is still restoring a session", () => {
    expect(gateDecision({ ...base, ready: false, connected: false, owner: undefined })).toBe(
      "loading",
    );
    expect(gateDecision({ ...base, ready: false, rememberedOwner: WALLET })).toBe("loading");
  });

  it("asks to connect first, even before any access check has run", () => {
    expect(gateDecision({ ...base, connected: false, owner: undefined })).toBe("connect");
    expect(
      gateDecision({ ...base, connected: false, access: { allowed: true, reason: "x" } }),
    ).toBe("connect");
    expect(
      gateDecision({ ...base, connected: false, owner: undefined, rememberedOwner: WALLET }),
    ).toBe("connect");
  });

  it("shows checking while GET /access is in flight for a wallet it has not seen pass", () => {
    expect(gateDecision(base)).toBe("checking");
    expect(gateDecision({ ...base, rememberedOwner: "someone-else" })).toBe("checking");
  });

  it("ticket 16: gate decision after a failed fetch is retry, not checking", () => {
    expect(gateDecision({ ...base, fetchFailed: true })).toBe("retry");
    expect(gateDecision({ ...base, fetchFailed: false })).toBe("checking");
  });

  it("ticket 16: a remembered wallet gets the retry control once the fetch has failed", () => {
    expect(gateDecision({ ...base, rememberedOwner: WALLET, fetchFailed: true })).toBe("retry");
  });

  it("paints nothing, not the app, while GET /access re-confirms a remembered wallet", () => {
    expect(gateDecision({ ...base, rememberedOwner: WALLET })).toBe("loading");
  });

  it("blocks with the code input until access is allowed, even for a remembered wallet", () => {
    const access = { allowed: false, reason: "no invite code redeemed" };
    expect(gateDecision({ ...base, access })).toBe("redeem");
    expect(gateDecision({ ...base, access, rememberedOwner: WALLET })).toBe("redeem");
  });

  it("hides once access is allowed", () => {
    expect(
      gateDecision({ ...base, access: { allowed: true, reason: "invite code redeemed" } }),
    ).toBe("hidden");
  });
});

describe("pendingStep", () => {
  const denied = { allowed: false, reason: "no invite code redeemed" };
  const allowed = { allowed: true, reason: "invite code redeemed" };

  it("waits until the wallet is connected and the access check has answered", () => {
    expect(pendingStep("loading", null)).toBe("wait");
    expect(pendingStep("connect", null)).toBe("wait");
    expect(pendingStep("checking", null)).toBe("wait");
    expect(pendingStep("retry", null)).toBe("wait");
  });

  it("keeps waiting on any status with no answer yet", () => {
    expect(pendingStep("hidden", null)).toBe("wait");
  });

  it("redeems once the check says this wallet needs a code", () => {
    expect(pendingStep("redeem", denied)).toBe("redeem");
  });

  it("drops the submit for a wallet that already has access", () => {
    expect(pendingStep("hidden", allowed)).toBe("drop");
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
