import { describe, expect, it } from "vitest";

import { hashForTab, hashSyncAction, tabFromHash } from "./tabs.js";

describe("tabFromHash / hashForTab", () => {
  it("round-trips every listed hash, any case", () => {
    expect(tabFromHash("#play")).toBe("MINE");
    expect(tabFromHash("#PLAY")).toBe("MINE");
    expect(hashForTab(tabFromHash("#referrals"))).toBe("#referrals");
  });

  it("falls back to HOME for an empty or unknown hash", () => {
    expect(tabFromHash("")).toBe("HOME");
    expect(tabFromHash("#nope")).toBe("HOME");
  });
});

describe("hashSyncAction", () => {
  // Pre-mainnet review: the initial sync on `/` assigned `location.hash =
  // "#home"`, pushing a spurious history entry so the first Back press
  // bounced to `/` instead of leaving the app.
  it("replaces in place when the URL has no hash yet", () => {
    expect(hashSyncAction("", "HOME")).toEqual({ kind: "replace", hash: "#home" });
    expect(hashSyncAction("#", "HOME")).toEqual({ kind: "replace", hash: "#home" });
  });

  it("replaces in place when the hash is not a tab (a typo'd link)", () => {
    expect(hashSyncAction("#nope", "HOME")).toEqual({ kind: "replace", hash: "#home" });
  });

  it("does nothing when the hash already names the tab, any case", () => {
    expect(hashSyncAction("#play", "MINE")).toEqual({ kind: "none" });
    expect(hashSyncAction("#PLAY", "MINE")).toEqual({ kind: "none" });
  });

  it("pushes a history entry for a real tab change", () => {
    expect(hashSyncAction("#home", "MINE")).toEqual({ kind: "push", hash: "#play" });
    expect(hashSyncAction("#play", "REFERRALS")).toEqual({ kind: "push", hash: "#referrals" });
  });
});
