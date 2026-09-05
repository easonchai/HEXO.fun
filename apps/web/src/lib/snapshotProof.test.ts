import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { claimProofFromSnapshot } from "./snapshotProof.js";

/**
 * Real base58 pubkeys where base58 string order and raw 32-byte order
 * disagree (found by random sampling) — the same fixture the CLI's
 * cross-package parity test uses, so this test exercises the same
 * ordering edge case at the web layer.
 */
const OWNERS = [
  "8kVu2U35bXih1nyKAPuC7hXKcqntfFtWb5cQBKxgXYDH",
  "9bxJRVC9P46j7snshLDUztLS4jYtyegSQhjTpK6c6tek",
  "uMT1AjyUZNxWTVEAeLFHwbkqqDwF2esgSeekvxZhW8o",
  "EnpTVAQFyNkYTJ4N3UabizgqxXWrNaxRom2HmtjgVeUc",
];

describe("claimProofFromSnapshot against a CLI-built root", () => {
  it("verifies a proof built from a CLI-shaped export with 3+ players", async () => {
    const entries = OWNERS.map((owner, i) => ({
      owner,
      weight: BigInt((i + 1) * 11),
    }));

    // Dynamic import via a variable (not a string literal) so tsc does not
    // pull this cross-package file into this package's type-checked
    // program.
    const cliMerklePath = "../../../../packages/cli/src/merkle.ts";
    const cliMerkle = (await import(cliMerklePath)) as {
      buildTree: (leaves: { owner: string; weight: bigint }[]) => {
        root: string;
        totalWeight: bigint;
      };
    };
    const cliTree = cliMerkle.buildTree(entries);

    // The CLI's on-disk export shape: root + totalWeight + a players array
    // of {owner, weight, proof} (see packages/cli/src/snapshot.ts
    // buildSnapshot). The web client only needs owner + weight from it — it
    // rebuilds the proof itself from the committed root and player list.
    const cliShapedExport = {
      root: cliTree.root,
      totalWeight: cliTree.totalWeight.toString(),
      players: entries.map((e) => ({
        owner: e.owner,
        weight: e.weight.toString(),
      })),
    };

    for (const entry of entries) {
      const claim = claimProofFromSnapshot(
        cliShapedExport,
        new PublicKey(entry.owner),
        null,
      );
      expect(claim.weight).toBe(entry.weight);
      expect(claim.totalWeight).toBe(cliTree.totalWeight);
    }
  });
});
