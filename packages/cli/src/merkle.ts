import { keccak_256 } from "@noble/hashes/sha3.js";
import { PublicKey } from "@solana/web3.js";

import { usage } from "./errors.js";
import { hex } from "./parse.js";

/**
 * Program-identical Merkle-sum hashing. The Anchor program uses
 * `solana_keccak_hasher::hashv` (programs/hex_vault/src/utils.rs): standard
 * keccak-256, which is exactly `keccak_256` from @noble/hashes.
 */
export function keccak256(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return keccak_256(buf);
}

const LEAF_TAG = Buffer.from("hexvault:prize-leaf:v1", "utf8");
const NODE_TAG = Buffer.from("hexvault:prize-node:v1", "utf8");

function sumToBytes(sum: bigint): Uint8Array {
  const b = new Uint8Array(8);
  Buffer.from(b.buffer).writeBigUInt64LE(sum);
  return b;
}

export function leafHash(owner: Uint8Array, weight: bigint): Uint8Array {
  return keccak256([LEAF_TAG, owner, sumToBytes(weight)]);
}

export function nodeHash(
  leftHash: Uint8Array,
  leftSum: bigint,
  rightHash: Uint8Array,
  rightSum: bigint,
): Uint8Array {
  return keccak256([
    NODE_TAG,
    leftHash,
    sumToBytes(leftSum),
    rightHash,
    sumToBytes(rightSum),
  ]);
}

export interface SnapshotEntry {
  owner: string;
  weight: bigint;
}

export interface ProofNodeJson {
  siblingHash: string;
  siblingSum: string;
  siblingIsLeft: boolean;
}

export interface SnapshotTree {
  root: string;
  totalWeight: bigint;
  /** owner base58 -> proof nodes, leaf to root. */
  proofs: Map<string, ProofNodeJson[]>;
}

interface TreeNode {
  hash: Uint8Array;
  sum: bigint;
  /** Leaf nodes only: owners (base58) whose proof must receive a sibling here. */
  owners: string[];
}

/**
 * Builds the tree the program verifies against; odd nodes are promoted, never
 * duplicated. Leaves sort by raw 32-byte public key ascending, not base58
 * string order, matching packages/indexer/src/merkle.ts exactly — the two
 * orders disagree, so a string sort here would produce a different root.
 */
export function buildTree(entries: SnapshotEntry[]): SnapshotTree {
  if (entries.length === 0) throw usage("snapshot has no players");
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(
      new PublicKey(a.owner).toBytes(),
      new PublicKey(b.owner).toBytes(),
    ),
  );

  let level: TreeNode[] = sorted.map((e) => {
    const owner = new PublicKey(e.owner).toBytes();
    return {
      hash: leafHash(new Uint8Array(owner), e.weight),
      sum: e.weight,
      owners: [e.owner],
    };
  });

  const proofs = new Map<string, ProofNodeJson[]>();
  for (const entry of sorted) proofs.set(entry.owner, []);

  while (level.length > 1) {
    const next: TreeNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        // Odd count at this level: promote unchanged, so no sibling is recorded.
        next.push(left);
        continue;
      }
      next.push({
        hash: nodeHash(left.hash, left.sum, right.hash, right.sum),
        sum: left.sum + right.sum,
        owners: [...left.owners, ...right.owners],
      });
      for (const owner of left.owners) {
        proofs.get(owner)!.push({
          siblingHash: hex(right.hash),
          siblingSum: right.sum.toString(),
          siblingIsLeft: false,
        });
      }
      for (const owner of right.owners) {
        proofs.get(owner)!.push({
          siblingHash: hex(left.hash),
          siblingSum: left.sum.toString(),
          siblingIsLeft: true,
        });
      }
    }
    level = next;
  }

  return { root: hex(level[0]!.hash), totalWeight: level[0]!.sum, proofs };
}

export interface VerifierProofNode {
  siblingHash: Uint8Array;
  siblingSum: bigint;
  siblingIsLeft: boolean;
}

/**
 * Same walk the program performs; returns the interval prefix so callers can
 * check `prefix <= target < prefix + weight`.
 */
export function prefixFor(
  owner: Uint8Array,
  weight: bigint,
  proof: VerifierProofNode[],
): bigint {
  let hash = leafHash(owner, weight);
  let prefix = 0n;
  let sum = weight;
  for (const node of proof) {
    const isLeft = node.siblingIsLeft;
    hash = isLeft
      ? nodeHash(node.siblingHash, node.siblingSum, hash, sum)
      : nodeHash(hash, sum, node.siblingHash, node.siblingSum);
    sum += node.siblingSum;
    if (isLeft) prefix += node.siblingSum;
  }
  return prefix;
}
