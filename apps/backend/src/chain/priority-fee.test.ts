import { describe, expect, it } from "vitest";

import { p75PriorityFeeMicroLamports } from "./priority-fee";

describe("p75PriorityFeeMicroLamports", () => {
  it("takes the 75th percentile of the samples", () => {
    // Nearest-rank on 4 sorted samples: ceil(0.75 * 4) - 1 = 2, the 3rd value.
    expect(p75PriorityFeeMicroLamports([100, 400, 200, 300], 1_000_000)).toBe(300);
  });

  it("drops zero samples before taking the percentile", () => {
    // Without the zeros this is the same [100, 200, 300, 400] as above.
    expect(p75PriorityFeeMicroLamports([0, 100, 0, 400, 200, 0, 300], 1_000_000)).toBe(300);
  });

  it("caps the result at maxMicroLamports", () => {
    expect(p75PriorityFeeMicroLamports([100, 400, 200, 300], 250)).toBe(250);
  });

  it("is 0 for an empty sample set", () => {
    expect(p75PriorityFeeMicroLamports([], 50_000)).toBe(0);
  });

  it("is 0 when every sample is zero", () => {
    expect(p75PriorityFeeMicroLamports([0, 0, 0], 50_000)).toBe(0);
  });

  it("takes the single sample for a one-element set", () => {
    expect(p75PriorityFeeMicroLamports([777], 50_000)).toBe(777);
  });
});
