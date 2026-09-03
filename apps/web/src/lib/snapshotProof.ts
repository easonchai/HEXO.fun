/**
 * Client-side prize/jackpot proof building from the indexer's snapshot cache.
 * The chain verifies the proof; this module only assembles and pre-checks it
 * so a winner can claim without operator files.
 */
import { PublicKey } from "@solana/web3.js";

import type { ProofNodeJson } from "../actions.js";
import {
  buildPrizeTree,
  isWinningInterval,
  verifyPrizeProof,
} from "./merkle.js";

/** Shape of GET /snapshot/:pool/:epoch (`players` carries owner + weight). */
export interface SnapshotPayload {
  root?: string;
  totalWeight?: string | number;
  players?: { owner: string; weight: string | number }[];
}

export interface ClaimProof {
  weight: bigint;
  proof: ProofNodeJson[];
  /** Start of this owner's weight interval. */
  prefix: bigint;
  totalWeight: bigint;
  /** True when the epoch's drawn target falls inside this owner's interval. */
  isWinner: boolean;
}

const toBytes = (value: unknown): Uint8Array => {
  if (typeof value === "string") return new PublicKey(value).toBytes();
  throw new Error("snapshot leaf owner must be a base58 public key");
};

const toBig = (value: string | number | undefined): bigint =>
  BigInt(String(value ?? "0"));

/**
 * Builds the winner's weight + proof from a snapshot payload. Throws with a
 * readable message when the owner has no leaf, the snapshot is malformed, or
 * the proof does not resolve to the committed root.
 */
export function claimProofFromSnapshot(
  snapshot: SnapshotPayload,
  owner: PublicKey,
  drawnTarget: bigint | null,
): ClaimProof {
  if (!snapshot.root) throw new Error("snapshot has no committed root");
  const players = snapshot.players ?? [];
  const leaves = players.map((player) => ({
    owner: toBytes(player.owner),
    weight: toBig(player.weight),
  }));

  const self = players.find((player) => player.owner === owner.toBase58());
  if (!self) throw new Error("you have no leaf in this snapshot");
  const weight = toBig(self.weight);
  if (weight <= 0n) throw new Error("your snapshot weight is zero");

  const root = Buffer.from(snapshot.root.replace(/^0x/, ""), "hex");
  if (root.length !== 32) throw new Error("snapshot root is not 32 bytes");
  const tree = buildPrizeTree(leaves);
  const proof = tree.proofs.get(Buffer.from(owner.toBytes()).toString("hex"));
  if (!proof) throw new Error("no proof path found for your account");

  const prefix = verifyPrizeProof(
    root,
    tree.total,
    owner.toBytes(),
    weight,
    proof,
  );
  return {
    weight,
    proof: proof.map((node) => ({
      siblingHash: node.siblingHash,
      siblingSum: node.siblingSum,
      siblingIsLeft: node.siblingIsLeft,
    })),
    prefix,
    totalWeight: tree.total,
    isWinner:
      drawnTarget !== null && isWinningInterval(prefix, weight, drawnTarget),
  };
}
