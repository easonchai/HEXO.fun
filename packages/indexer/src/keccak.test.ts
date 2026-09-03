import { describe, expect, it } from "vitest";
import { keccak256, keccak256Concat } from "./keccak.ts";

const pattern = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
  return bytes;
};

/**
 * Reference digests produced by @noble/hashes keccak_256 (the same primitive
 * Solana's solana_keccak_hasher wraps). Sizes bracket the 136-byte sponge rate
 * so the multi-rate padding path is exercised.
 */
const VECTORS: readonly [number, string][] = [
  [0, "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  [43, "d5bc0038e7d1859cf6c6cdf5f1bec2ad85fee1c0bad3f85c0faf65c14dcce217"],
  [136, "b8717c6e7605ca3b5a0a94a147127679778a23a4324e53b910263673d0bfb55c"],
  [137, "e2d9f409a6d575e1457f9d3f7436081485d5794bf84db179566eea07a8266e8d"],
  [272, "79cacfd52db427ce7b9a771984a13387a6e31075bcc4716a5deddff6875c4e69"],
];

describe("keccak256", () => {
  it.each(VECTORS)(
    "matches the reference digest for %i bytes",
    (length, expected) => {
      expect(keccak256(pattern(length)).toString("hex")).toBe(expected);
    },
  );

  it("hashes concatenated parts exactly like hashing the joined buffer", () => {
    const joined = Buffer.concat([
      Buffer.from("abc"),
      pattern(200),
      Buffer.from("zz"),
    ]);
    expect(
      keccak256Concat(Buffer.from("abc"), pattern(200), Buffer.from("zz")),
    ).toEqual(keccak256(joined));
  });

  it("is distinct from NIST SHA3-256", () => {
    // Keccak-256("") is well known; SHA3-256("") is a different digest.
    expect(keccak256(new Uint8Array(0)).toString("hex")).not.toBe(
      "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    );
  });
});
