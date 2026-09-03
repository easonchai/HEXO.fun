import { describe, expect, it } from "vitest";

import { keccak256, keccak256Concat } from "./keccak.js";
import { buildPrizeTree, verifyPrizeProof } from "./merkle.js";

/**
 * Vector check for the web copy: these must hash identically to the indexer's
 * proven implementation, or browser-built prize proofs would not resolve
 * on-chain.
 */
const VECTORS: [string, string][] = [
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
];

describe("web keccak + merkle copies", () => {
  it("hashes the known vectors (empty + abc)", () => {
    expect(keccak256(new Uint8Array(0)).toString("hex")).toBe(VECTORS[0]![1]);
    expect(keccak256(new TextEncoder().encode("abc")).toString("hex")).toBe(
      VECTORS[1]![1],
    );
  });

  it("builds proofs that resolve to the committed root", () => {
    const owners = [
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
    ];
    const tree = buildPrizeTree(
      owners.map((owner, index) => ({
        owner: Buffer.from(owner, "hex"),
        weight: BigInt((index + 1) * 500),
      })),
    );
    const proof = tree.proofs.get(owners[1]!)!;
    const prefix = verifyPrizeProof(
      tree.root,
      tree.total,
      Buffer.from(owners[1]!, "hex"),
      1000n,
      proof,
    );
    expect(prefix).toBe(500n);
  });

  it("concatenates parts like Rust hashv", () => {
    const joined = keccak256Concat(
      Buffer.from("hexvault:prize-leaf:v1"),
      Buffer.alloc(32, 7),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    );
    const direct = keccak256(
      Buffer.concat([
        Buffer.from("hexvault:prize-leaf:v1"),
        Buffer.alloc(32, 7),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
      ]),
    );
    expect(joined.equals(direct)).toBe(true);
  });
});
