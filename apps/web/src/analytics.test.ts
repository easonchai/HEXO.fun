import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  setPersonProperties: vi.fn(),
  reset: vi.fn(),
  register: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

// `enabled` is module state, so each test gets a fresh copy.
const load = () => import("./analytics.js");

describe("analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not touch posthog when no key is set", async () => {
    const { initAnalytics, track } = await load();
    initAnalytics({});
    track("x");
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("inits with the key, registers the cluster and forwards events", async () => {
    const { initAnalytics, track } = await load();
    initAnalytics({ VITE_POSTHOG_KEY: "phc_test", VITE_CLUSTER: "devnet" });
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
    expect(posthog.register).toHaveBeenCalledWith({ cluster: "devnet" });
    track("x", { a: 1 });
    expect(posthog.capture).toHaveBeenCalledWith("x", { a: 1 });
  });
});
