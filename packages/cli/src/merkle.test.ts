import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import type { ProofNodeJson, VerifierProofNode } from "./merkle.js";
import {
  buildTree,
  keccak256,
  leafHash,
  nodeHash,
  prefixFor,
} from "./merkle.js";
import { hex } from "./parse.js";

/** Deterministic test pubkey from a seed. */
const owner = (seed: number): string => {
  const bytes = new Uint8Array(32);
  bytes[30] = seed >> 8;
  bytes[31] = seed & 0xff;
  return new PublicKey(bytes).toBase58();
};

function toVerifier(proof: ProofNodeJson[]): VerifierProofNode[] {
  return proof.map((n) => ({
    siblingHash: Uint8Array.from(Buffer.from(n.siblingHash, "hex")),
    siblingSum: BigInt(n.siblingSum),
    siblingIsLeft: n.siblingIsLeft,
  }));
}

// Ethereum/Solana keccak-256 vectors. Guards against a future switch to
// NIST sha3-256, which has different padding and would break the root.
describe("keccak256", () => {
  it("matches the standard keccak-256 vectors", () => {
    expect(hex(keccak256([new Uint8Array(0)]))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(hex(keccak256([new TextEncoder().encode("abc")]))).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("concatenates parts before hashing", () => {
    expect(
      hex(
        keccak256([
          new TextEncoder().encode("ab"),
          new TextEncoder().encode("c"),
        ]),
      ),
    ).toBe(hex(keccak256([new TextEncoder().encode("abc")])));
  });
});

/** Mirrors the program's `verify_prize_proof` interval rule. */
const wins = (prefix: bigint, weight: bigint, target: bigint) =>
  target >= prefix && target < prefix + weight;

describe("buildTree", () => {
  it("reproduces the two-leaf root from the program's Rust test", () => {
    const a = owner(1);
    const b = owner(2);
    const leafA = leafHash(new PublicKey(a).toBytes(), 50n);
    const leafB = leafHash(new PublicKey(b).toBytes(), 100n);
    const expected = nodeHash(leafA, 50n, leafB, 100n);

    const tree = buildTree([
      { owner: b, weight: 100n },
      { owner: a, weight: 50n },
    ]);
    expect(tree.root).toBe(hex(expected));
    expect(tree.totalWeight).toBe(150n);
  });

  it("gives each player the interval its weight owns, for odd and even trees", () => {
    const weights = [7n, 11n, 13n, 17n, 19n];
    const players = weights.map((weight, i) => ({
      owner: owner(i + 3),
      weight,
    }));
    const tree = buildTree(players);

    // sorted by owner, matching buildTree's ordering
    const ordered = [...players].sort((x, y) => x.owner.localeCompare(y.owner));
    let cumulative = 0n;
    const expectedPrefixes = ordered.map((p) => {
      const prefix = cumulative;
      cumulative += p.weight;
      return { owner: p.owner, weight: p.weight, prefix };
    });

    expect(tree.totalWeight).toBe(weights.reduce((a, b) => a + b, 0n));
    for (const { owner: who, weight, prefix } of expectedPrefixes) {
      const proof = tree.proofs.get(who)!;
      expect(proof.length).toBeGreaterThan(0);
      expect(
        prefixFor(new PublicKey(who).toBytes(), weight, toVerifier(proof)),
      ).toBe(prefix);
    }
  });

  it("covers the whole weight space with no gaps or overlaps", () => {
    const players = [1n, 2n, 3n, 5n, 8n, 13n, 21n].map((weight, i) => ({
      owner: owner(i + 10),
      weight,
    }));
    const tree = buildTree(players);
    const ordered = [...players].sort((x, y) => x.owner.localeCompare(y.owner));
    const intervals = ordered.map((p) => {
      const prefix = prefixFor(
        new PublicKey(p.owner).toBytes(),
        p.weight,
        toVerifier(tree.proofs.get(p.owner)!),
      );
      return [prefix, prefix + p.weight] as const;
    });
    let at = 0n;
    for (const [start, end] of intervals) {
      expect(start).toBe(at);
      at = end;
    }
    expect(at).toBe(tree.totalWeight);
  });

  it("proves a winner and rejects a non-winner target", () => {
    const tree = buildTree([
      { owner: owner(21), weight: 50n },
      { owner: owner(22), weight: 100n },
    ]);
    const loser = owner(21);
    const winner = owner(22);
    const loserPrefix = prefixFor(
      new PublicKey(loser).toBytes(),
      50n,
      toVerifier(tree.proofs.get(loser)!),
    );
    const winnerPrefix = prefixFor(
      new PublicKey(winner).toBytes(),
      100n,
      toVerifier(tree.proofs.get(winner)!),
    );
    expect(wins(loserPrefix, 50n, 49n)).toBe(true);
    expect(wins(loserPrefix, 50n, 50n)).toBe(false);
    expect(wins(winnerPrefix, 100n, 149n)).toBe(true);
    expect(wins(winnerPrefix, 100n, 150n)).toBe(false);
  });

  it("rejects an empty snapshot", () => {
    expect(() => buildTree([])).toThrow(/no players/);
  });
});

describe("cross-package root parity", () => {
  // Real base58 pubkeys (Keypair.fromSeed-free, randomly sampled) where
  // base58 string order and raw 32-byte order disagree — sorting this exact
  // set by string vs. by bytes produces different orderings, so this catches
  // a regression back to a string sort even though most random sets happen
  // to agree by chance.
  const DIVERGING_OWNERS = [
    "8kVu2U35bXih1nyKAPuC7hXKcqntfFtWb5cQBKxgXYDH",
    "9bxJRVC9P46j7snshLDUztLS4jYtyegSQhjTpK6c6tek",
    "uMT1AjyUZNxWTVEAeLFHwbkqqDwF2esgSeekvxZhW8o",
    "EnpTVAQFyNkYTJ4N3UabizgqxXWrNaxRom2HmtjgVeUc",
    "AsFTGLN4zXGYUGDPH6SK8fK82SxyyaTFN3pCavKAW2xk",
    "HZKiwuHhDjDHdWJF35Zmvknt1zm857dKyEVzwXKvGUR4",
  ];

  it("string-sorts and byte-sorts this owner set differently (sanity check on the fixture)", () => {
    const byString = [...DIVERGING_OWNERS].sort((a, b) => a.localeCompare(b));
    const byBytes = [...DIVERGING_OWNERS].sort((a, b) =>
      Buffer.compare(new PublicKey(a).toBytes(), new PublicKey(b).toBytes()),
    );
    expect(byString).not.toEqual(byBytes);
  });

  it("matches the indexer's root for the same leaf set", async () => {
    const entries = DIVERGING_OWNERS.map((owner, i) => ({
      owner,
      weight: BigInt((i + 1) * 7),
    }));
    const cliTree = buildTree(entries);

    // Imported through a variable path, not a literal: a static import would
    // pull the indexer's merkle.ts into this package's stricter tsc program
    // (exactOptionalPropertyTypes) and fail `check` on that file's own
    // pre-existing errors. The cast below is the price.
    const indexerMerklePath = "../../indexer/src/merkle.ts";
    const indexerMerkle = (await import(indexerMerklePath)) as {
      buildPrizeTree: (leaves: { owner: Uint8Array; weight: bigint }[]) => {
        root: Buffer;
      };
    };
    const indexerTree = indexerMerkle.buildPrizeTree(
      entries.map((e) => ({
        owner: new PublicKey(e.owner).toBytes(),
        weight: e.weight,
      })),
    );

    expect(cliTree.root).toBe(indexerTree.root.toString("hex"));
  });
});
