import { describe, expect, it } from "vitest";

import { DEFAULT_POOL_PARAMS, parsePoolParams } from "./params";

describe("parsePoolParams", () => {
  it("returns the spec §7 defaults with no flags", () => {
    expect(parsePoolParams([])).toEqual(DEFAULT_POOL_PARAMS);
  });

  it("overrides only the flags given", () => {
    expect(parsePoolParams(["--epoch-seconds", "120"])).toEqual({
      ...DEFAULT_POOL_PARAMS,
      epochSeconds: 120,
    });
    expect(
      parsePoolParams(["--epoch-seconds=120", "--round-seconds=20"]),
    ).toEqual({ ...DEFAULT_POOL_PARAMS, epochSeconds: 120, roundSeconds: 20 });
  });

  it("rejects values create_pool would reject", () => {
    expect(() => parsePoolParams(["--round-seconds", "0"])).toThrow(/positive/);
    expect(() => parsePoolParams(["--epoch-seconds", "1.5"])).toThrow(/whole/);
    // close_buffer is 5, so a 4 second round cannot satisfy
    // close_buffer < round_seconds.
    expect(() => parsePoolParams(["--round-seconds", "4"])).toThrow(
      /close buffer/,
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parsePoolParams(["--pool-id", "2"])).toThrow(/usage/);
  });
});
