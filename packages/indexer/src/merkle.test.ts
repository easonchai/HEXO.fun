import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keccak256Concat } from "./keccak.ts";
import {
  buildPrizeTree,
  isWinningInterval,
  prizeLeafHash,
  verifyPrizeProof,
} from "./merkle.ts";

const owner = (seed: number): Buffer =>
  Buffer.from(createHash("sha256").update(String(seed)).digest());

/** Independent re-implementation of the Rust leaf/node hashing. */
const rustLeaf = (ownerBytes: Uint8Array, weight: bigint): Buffer =>
  keccak256Concat(
    Buffer.from("hexvault:prize-leaf:v1"),
    ownerBytes,
    Buffer.from(weight.toString(16).padStart(16, "0"), "hex").reverse(),
  );

const leaf = (seed: number, weight: bigint) => ({ owner: owner(seed), weight });

describe("prize merkle-sum tree", () => {
  it("matches a naive re-implementation of the Rust hashing", () => {
    for (const seed of [1, 42, 999]) {
      expect(prizeLeafHash(owner(seed), 1234n)).toEqual(
        rustLeaf(owner(seed), 1234n),
      );
    }
  });

  it("produces a hard-coded leaf digest", () => {
    // Cross-checked against @noble/hashes keccak_256.
    expect(prizeLeafHash(Buffer.alloc(32, 7), 1n).toString("hex")).toBe(
      "b35dcc9170f821df9bd2accff57638a03c9e86cf420d203ed6f9d4835fa0e4aa",
    );
  });

  it("sums every leaf into the root weight", () => {
    const leaves = [leaf(1, 10n), leaf(2, 20n), leaf(3, 30n)];
    const tree = buildPrizeTree(leaves);
    expect(tree.total).toBe(60n);
    expect(tree.levels.at(-1)).toHaveLength(1);
  });

  it("verifies every leaf proof and rejects a non-winner", () => {
    const leaves = [
      leaf(1, 5n),
      leaf(2, 7n),
      leaf(3, 11n),
      leaf(4, 13n),
      leaf(5, 17n),
    ];
    const tree = buildPrizeTree(leaves);

    // Prefixes are defined over the sorted leaf order the tree was built from.
    const ordered = [...leaves].sort((a, b) => a.owner.compare(b.owner));
    let prefix = 0n;
    for (const candidate of ordered) {
      const path = tree.proofs.get(candidate.owner.toString("hex"));
      expect(path).toBeDefined();
      const returned = verifyPrizeProof(
        tree.root,
        tree.total,
        candidate.owner,
        candidate.weight,
        path!,
      );
      expect(returned).toBe(prefix);
      expect(isWinningInterval(returned, candidate.weight, returned)).toBe(
        true,
      );
      expect(
        isWinningInterval(
          returned,
          candidate.weight,
          returned + candidate.weight,
        ),
      ).toBe(false);
      prefix += candidate.weight;
    }
  });

  it("handles odd leaf counts by promoting, never duplicating", () => {
    const leaves = [leaf(1, 1n), leaf(2, 2n), leaf(3, 3n)];
    const tree = buildPrizeTree(leaves);
    expect(tree.total).toBe(6n);

    // The leaf that sorts last is promoted at depth 0, so it has no sibling
    // there and its proof holds exactly one node: the collapsed left subtree.
    const ordered = [...leaves].sort((a, b) => a.owner.compare(b.owner));
    const last = ordered[2]!;
    const path = tree.proofs.get(last.owner.toString("hex"))!;
    expect(path).toHaveLength(1);
    expect(path[0]!.siblingIsLeft).toBe(true);
    expect(path[0]!.siblingSum).toBe(6n - last.weight);
    expect(verifyPrizeProof(tree.root, 6n, last.owner, last.weight, path)).toBe(
      ordered[0]!.weight + ordered[1]!.weight,
    );
  });

  it("is deterministic regardless of input order", () => {
    const a = buildPrizeTree([leaf(1, 4n), leaf(2, 5n), leaf(3, 6n)]);
    const b = buildPrizeTree([leaf(3, 6n), leaf(1, 4n), leaf(2, 5n)]);
    expect(a.root.equals(b.root)).toBe(true);
    expect(a.total).toBe(b.total);
  });

  it("drops zero-weight leaves and rejects duplicate owners", () => {
    const withZero = buildPrizeTree([leaf(1, 0n), leaf(2, 9n)]);
    expect(withZero.total).toBe(9n);
    expect(() => buildPrizeTree([leaf(1, 5n), leaf(1, 5n)])).toThrow(
      /duplicate/,
    );
  });

  it("rejects a proof whose weight does not match the leaf", () => {
    const leaves = [leaf(1, 8n), leaf(2, 8n)];
    const tree = buildPrizeTree(leaves);
    const path = tree.proofs.get(leaves[0]!.owner.toString("hex"))!;
    expect(() =>
      verifyPrizeProof(tree.root, tree.total, leaves[0]!.owner, 7n, path),
    ).toThrow();
    expect(() =>
      verifyPrizeProof(tree.root, 1n, leaves[0]!.owner, 8n, path),
    ).toThrow();
  });
});
