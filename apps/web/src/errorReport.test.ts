import { afterEach, describe, expect, it, vi } from "vitest";

import { track } from "./analytics.js";
import { reportError } from "./errorReport.js";

vi.mock("./analytics.js", () => ({ track: vi.fn() }));

describe("reportError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tracks only the code and page, never the message, signature or wallet", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve()),
    );
    reportError({ code: "x", message: "secret", signature: "sig", wallet: "w", page: "#vault" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("client_error", { code: "x", page: "#vault" });
  });
});
