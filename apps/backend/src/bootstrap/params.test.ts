import { describe, expect, it } from "vitest";

import {
  DEFAULT_POOL_PARAMS,
  isoSeconds,
  nextSundayAnchor,
  parsePoolParams,
} from "./params";

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

  it("takes the anchor as an ISO 8601 time", () => {
    expect(
      parsePoolParams(["--epoch-anchor", "2026-09-13T16:00:00Z"]).epochAnchor,
    ).toBe(1_789_315_200);
    expect(() => parsePoolParams(["--epoch-anchor", "next sunday"])).toThrow(
      /ISO 8601/,
    );
  });
});

describe("nextSundayAnchor", () => {
  it("takes the following Sunday from a midweek now", () => {
    // Thursday 2026-09-10, so the anchor is Sunday the 13th at 16:00 UTC,
    // which is 00:00 MYT on Monday the 14th.
    expect(nextSundayAnchor(new Date("2026-09-10T09:41:07Z"))).toBe(
      1_789_315_200,
    );
  });

  it("keeps a now that is already on a Sunday 16:00 UTC", () => {
    expect(nextSundayAnchor(new Date("2026-09-13T16:00:00Z"))).toBe(
      1_789_315_200,
    );
  });

  it("skips to next week once that Sunday's 16:00 has gone", () => {
    expect(nextSundayAnchor(new Date("2026-09-13T16:00:01Z"))).toBe(
      1_789_315_200 + 7 * 86_400,
    );
  });
});

describe("isoSeconds", () => {
  it("round-trips an ISO string to unix seconds", () => {
    expect(isoSeconds("epoch-anchor", "2026-09-13T16:00:00Z")).toBe(
      1_789_315_200,
    );
    // A non-UTC offset is the same instant, so it resolves to the same value.
    expect(isoSeconds("epoch-anchor", "2026-09-14T00:00:00+08:00")).toBe(
      1_789_315_200,
    );
  });

  it("rejects a value Date cannot parse", () => {
    expect(() => isoSeconds("epoch-anchor", "2026-13-01")).toThrow(/ISO 8601/);
    expect(() => isoSeconds("epoch-anchor", "")).toThrow(/ISO 8601/);
  });
});
