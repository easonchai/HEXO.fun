import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { adminMode, encodeForSquads } from "./squads";

const local = Keypair.generate().publicKey;
const multisig = Keypair.generate().publicKey;
// Any blockhash-shaped base58 does; nothing here talks to a cluster.
const blockhash = Keypair.generate().publicKey.toBase58();

/** Stand-in for an admin-gated instruction: one signer, the admin. */
const adminIx = (admin: PublicKey): TransactionInstruction =>
  new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [{ pubkey: admin, isSigner: true, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });

describe("adminMode", () => {
  it("stays local when ADMIN_ADDRESS is unset or is the loaded key", () => {
    expect(adminMode(undefined, local)).toEqual({ signer: local, multisig: false });
    expect(adminMode("", local)).toEqual({ signer: local, multisig: false });
    expect(adminMode(local.toBase58(), local)).toEqual({
      signer: local,
      multisig: false,
    });
  });

  it("switches to multisig when ADMIN_ADDRESS is someone else", () => {
    const mode = adminMode(multisig.toBase58(), local);
    expect(mode.multisig).toBe(true);
    expect(mode.signer.equals(multisig)).toBe(true);
  });

  it("rejects an ADMIN_ADDRESS that is not a pubkey", () => {
    expect(() => adminMode("not-a-key", local)).toThrow(/base58 pubkey/);
  });
});

describe("encodeForSquads", () => {
  it("round-trips through Transaction.from with the admin as the only signer", () => {
    const encoded = encodeForSquads([adminIx(multisig)], multisig, blockhash);
    expect(encoded).not.toMatch(/\s/); // one line, so `| pbcopy` works

    const tx = Transaction.from(bs58.decode(encoded));
    expect(tx.feePayer?.toBase58()).toBe(multisig.toBase58());
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([
      multisig.toBase58(),
    ]);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
  });

  it("keeps a prepended instruction, as withdraw-principal's ATA creation is", () => {
    const encoded = encodeForSquads(
      [adminIx(multisig), adminIx(multisig)],
      multisig,
      blockhash,
    );
    expect(Transaction.from(bs58.decode(encoded)).instructions).toHaveLength(2);
  });
});
