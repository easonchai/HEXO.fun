/**
 * Canonical Merkle-sum prize tree — copied verbatim from
 * packages/indexer/src/merkle.ts so the browser builds byte-identical roots
 * and proofs from the API's snapshot cache. Any change here must land in the
 * indexer copy in the same commit.
 */
import { keccak256Concat } from "./keccak.js";

/** Mirrors programs/hex_vault/src/state.rs MerkleProofNode. */
export interface MerkleProofNode {
  readonly siblingHash: Uint8Array; // 32 bytes
  readonly siblingSum: bigint;
  readonly siblingIsLeft: boolean;
}

export interface MerkleNode {
  readonly hash: Buffer;
  readonly sum: bigint;
}

export interface PrizeLeaf {
  readonly owner: Uint8Array; // 32 bytes
  readonly weight: bigint;
}

export interface PrizeTree {
  readonly root: Buffer;
  readonly total: bigint;
  /** levels[0] = leaves, last = [root]. */
  readonly levels: MerkleNode[][];
  readonly proofs: Map<string, MerkleProofNode[]>;
}

const LEAF_PREFIX = Buffer.from("hexvault:prize-leaf:v1", "utf8");
const NODE_PREFIX = Buffer.from("hexvault:prize-node:v1", "utf8");

const u64le = (value: bigint): Buffer => {
  if (value < 0n || value >= 1n << 64n) throw new Error("value outside u64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

/**
 * Identical to programs/hex_vault/src/utils.rs::prize_leaf_hash.
 */
export const prizeLeafHash = (owner: Uint8Array, weight: bigint): Buffer =>
  keccak256Concat(LEAF_PREFIX, owner, u64le(weight));

/**
 * Identical to programs/hex_vault/src/utils.rs::prize_node_hash.
 */
export const prizeNodeHash = (
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

const promote = (node: MerkleNode): MerkleNode => ({
  hash: node.hash,
  sum: node.sum,
});

/**
 * Builds the canonical Merkle-sum tree. Leaves are sorted by owner bytes so the
 * root is reproducible across indexer restarts and off-chain producers. Zero
 * weights are dropped (the program rejects weight == 0 claims anyway) and an
 * odd trailing node is promoted unchanged, never duplicated — matching the
 * on-chain verifier, which only inspects the supplied sibling path.
 */
export function buildPrizeTree(leaves: readonly PrizeLeaf[]): PrizeTree {
  const sorted = leaves
    .filter((leaf) => leaf.weight > 0n)
    .map((leaf) => ({ owner: Buffer.from(leaf.owner), weight: leaf.weight }))
    .sort((a, b) => a.owner.compare(b.owner));

  if (sorted.length === 0)
    throw new Error("cannot build a prize tree with no leaves");

  const seen = new Set<string>();
  let level: MerkleNode[] = sorted.map((leaf) => {
    const key = leaf.owner.toString("hex");
    if (seen.has(key)) throw new Error(`duplicate snapshot leaf for ${key}`);
    seen.add(key);
    return { hash: prizeLeafHash(leaf.owner, leaf.weight), sum: leaf.weight };
  });

  const levels: MerkleNode[][] = [level];
  const paths: MerkleProofNode[][] = sorted.map(() => []);

  let depth = 0;
  while (level.length > 1) {
    // Record this depth's sibling for every leaf before collapsing the level.
    for (let leafIndex = 0; leafIndex < sorted.length; leafIndex += 1) {
      const nodeIndex = leafIndex >> depth;
      const siblingIndex = nodeIndex ^ 1;
      // A promoted trailing node has no sibling at this depth, so the proof
      // simply skips the level — the on-chain verifier walks node by node.
      if (siblingIndex >= level.length) continue;
      const sibling = level[siblingIndex]!;
      paths[leafIndex]!.push({
        siblingHash: sibling.hash,
        siblingSum: sibling.sum,
        siblingIsLeft: siblingIndex < nodeIndex,
      });
    }

    const next: MerkleNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (!right) {
        next.push(promote(left));
        continue;
      }
      next.push({
        hash: prizeNodeHash(left.hash, left.sum, right.hash, right.sum),
        sum: left.sum + right.sum,
      });
    }
    level = next;
    depth += 1;
    levels.push(level);
  }

  const proofs = new Map<string, MerkleProofNode[]>(
    sorted.map((leaf, index) => [leaf.owner.toString("hex"), paths[index]!]),
  );

  return {
    root: level[0]!.hash,
    total: levels[0]!.reduce((sum, node) => sum + node.sum, 0n),
    levels,
    proofs,
  };
}

/**
 * Mirror of programs/hex_vault/src/utils.rs::verify_prize_proof. Returns the
 * winning interval prefix; throws when the proof is invalid.
 */
export function verifyPrizeProof(
  root: Uint8Array,
  expectedTotal: bigint,
  owner: Uint8Array,
  weight: bigint,
  proof: readonly MerkleProofNode[],
): bigint {
  if (weight <= 0n || proof.length > 32)
    throw new Error("invalid merkle proof");

  let hash = prizeLeafHash(owner, weight);
  let sum = weight;
  let prefix = 0n;

  for (const node of proof) {
    const combined = sum + node.siblingSum;
    if (node.siblingIsLeft) {
      prefix += node.siblingSum;
      hash = prizeNodeHash(node.siblingHash, node.siblingSum, hash, sum);
    } else {
      hash = prizeNodeHash(hash, sum, node.siblingHash, node.siblingSum);
    }
    sum = combined;
  }

  if (
    sum !== expectedTotal ||
    Buffer.compare(Buffer.from(hash), Buffer.from(root)) !== 0
  ) {
    throw new Error("merkle proof does not resolve to the committed root");
  }
  return prefix;
}

/** True when [prefix, prefix + weight) contains the drawn target. */
export const isWinningInterval = (
  prefix: bigint,
  weight: bigint,
  target: bigint,
): boolean => target >= prefix && target < prefix + weight;
