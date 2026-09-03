import { keccak256Concat } from "../../packages/indexer/src/keccak.ts";
import type { PublicKey } from "@solana/web3.js";

/**
 * Merkle-sum snapshot tree, byte-for-byte identical to
 * programs/hex_vault/src/utils.rs::prize_leaf_hash / prize_node_hash and to
 * packages/indexer/src/merkle.ts (which has a path-recording bug for trees
 * deeper than two levels, so the tests carry their own builder).
 */

export interface ProofNode {
  siblingHash: number[];
  siblingSum: bigint;
  siblingIsLeft: boolean;
}

export interface SnapshotLeaf {
  owner: PublicKey;
  weight: bigint;
}

export interface Snapshot {
  /** Leaves in canonical (owner-byte) order, i.e. the order used for the root. */
  leaves: SnapshotLeaf[];
  root: number[];
  total: bigint;
  proofs: Map<string, ProofNode[]>;
}

interface Node {
  hash: Buffer;
  sum: bigint;
}

const LEAF_PREFIX = Buffer.from("hexvault:prize-leaf:v1", "utf8");
const NODE_PREFIX = Buffer.from("hexvault:prize-node:v1", "utf8");

const u64le = (value: bigint): Buffer => {
  if (value < 0n || value >= 1n << 64n) throw new Error("weight outside u64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

export const leafHash = (owner: Uint8Array, weight: bigint): Buffer =>
  keccak256Concat(LEAF_PREFIX, owner, u64le(weight));

export const nodeHash = (
  leftHash: Uint8Array,
  leftSum: bigint,
  rightHash: Uint8Array,
  rightSum: bigint,
): Buffer =>
  keccak256Concat(
    NODE_PREFIX,
    leftHash,
    u64le(leftSum),
    rightHash,
    u64le(rightSum),
  );

const byOwner = (a: SnapshotLeaf, b: SnapshotLeaf): number =>
  a.owner.toBuffer().compare(b.owner.toBuffer());

export function buildSnapshot(leaves: readonly SnapshotLeaf[]): Snapshot {
  const sorted = [...leaves].sort(byOwner);
  const seen = new Set<string>();
  for (const leaf of sorted) {
    const key = leaf.owner.toBase58();
    if (leaf.weight <= 0n) throw new Error(`zero weight for ${key}`);
    if (seen.has(key)) throw new Error(`duplicate snapshot leaf for ${key}`);
    seen.add(key);
  }

  const canonical: SnapshotLeaf[] = [...sorted];
  let level: Node[] = sorted.map((leaf) => ({
    hash: leafHash(leaf.owner.toBytes(), leaf.weight),
    sum: leaf.weight,
  }));
  const paths: ProofNode[][] = sorted.map(() => []);

  const levels: Node[][] = [level];
  let depth = 0;
  while (level.length > 1) {
    // A leaf's node index at `depth` is floor(leafIndex / 2**depth). A promoted
    // trailing node has no sibling, so that level is simply skipped.
    for (let leafIndex = 0; leafIndex < sorted.length; leafIndex += 1) {
      const nodeIndex = leafIndex >> depth;
      const siblingIndex = nodeIndex ^ 1;
      if (siblingIndex >= level.length) continue;
      const sibling = level[siblingIndex];
      paths[leafIndex].push({
        siblingHash: Array.from(sibling.hash),
        siblingSum: sibling.sum,
        siblingIsLeft: siblingIndex < nodeIndex,
      });
    }

    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      if (!right) {
        next.push({ hash: left.hash, sum: left.sum });
        continue;
      }
      next.push({
        hash: nodeHash(left.hash, left.sum, right.hash, right.sum),
        sum: left.sum + right.sum,
      });
    }
    level = next;
    depth += 1;
    levels.push(level);
  }

  return {
    leaves: canonical,
    root: Array.from(level[0].hash),
    total: sorted.reduce((sum, leaf) => sum + leaf.weight, 0n),
    proofs: new Map(
      sorted.map((leaf, index) => [leaf.owner.toBase58(), paths[index]]),
    ),
  };
}

/** The leaf whose [prefix, prefix+weight) interval contains `target`. */
export function ownerOfInterval(
  snapshot: Snapshot,
  target: bigint,
): { owner: PublicKey; weight: bigint; prefix: bigint } {
  let prefix = 0n;
  for (const leaf of snapshot.leaves) {
    if (target >= prefix && target < prefix + leaf.weight) {
      return { owner: leaf.owner, weight: leaf.weight, prefix };
    }
    prefix += leaf.weight;
  }
  throw new Error(`target ${target} outside snapshot total ${snapshot.total}`);
}

export const proofFor = (snapshot: Snapshot, owner: PublicKey): ProofNode[] => {
  const proof = snapshot.proofs.get(owner.toBase58());
  if (!proof) throw new Error(`no snapshot leaf for ${owner.toBase58()}`);
  return proof;
};
