import { describe, expect, it } from "vitest";
import { hasTransactionError } from "./index.ts";

describe("transaction filtering", () => {
  it("recognizes failed and successful transaction metadata", () => {
    expect(
      hasTransactionError({
        meta: { err: { InstructionError: [0, "Custom"] } },
      }),
    ).toBe(true);
    expect(hasTransactionError({ meta: { err: null } })).toBe(false);
    expect(hasTransactionError({ meta: { err: undefined } })).toBe(false);
    expect(hasTransactionError(null)).toBe(false);
  });
});
