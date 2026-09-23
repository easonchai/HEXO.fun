/**
 * `safePriorityFee` (ticket 08, production-hardening): `/state` is
 * unauthenticated input, so this is the one gate between whatever a
 * compromised or misbehaving backend sends and a signature.
 */
import { describe, expect, it } from "vitest";

import { safePriorityFee } from "./read.js";

const FLOOR = 1_000;
const CEILING = 50_000;

describe("safePriorityFee", () => {
  it("passes an ordinary estimate through unchanged", () => {
    expect(safePriorityFee(4_242)).toBe(4_242);
  });

  it("floors a zero or missing estimate instead of signing with no fee", () => {
    expect(safePriorityFee(0)).toBe(FLOOR);
  });

  it("caps an estimate above the ceiling, whatever the backend sent", () => {
    expect(safePriorityFee(1_000_000)).toBe(CEILING);
  });

  it("floors a negative number rather than trusting it", () => {
    expect(safePriorityFee(-5)).toBe(FLOOR);
  });

  it("floors a non-integer number rather than trusting it", () => {
    expect(safePriorityFee(1_234.5)).toBe(FLOOR);
  });

  it("floors NaN and Infinity rather than trusting them", () => {
    expect(safePriorityFee(Number.NaN)).toBe(FLOOR);
    expect(safePriorityFee(Number.POSITIVE_INFINITY)).toBe(FLOOR);
  });

  it("floors a non-number value a malformed response could send", () => {
    // `/state` is parsed with no runtime schema (api.ts), so the wire value
    // can disagree with StateDto's declared `number` type.
    expect(safePriorityFee(undefined as unknown as number)).toBe(FLOOR);
    expect(safePriorityFee("4242" as unknown as number)).toBe(FLOOR);
  });
});
