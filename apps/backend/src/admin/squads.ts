// Which key the admin-gated instructions name as signer, and the base58
// transaction Squads imports when that key is a multisig. Split out of
// index.ts so a unit test can round-trip the encoding without an RPC, a
// keypair or an env.
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

export interface AdminMode {
  /** The account every admin-gated instruction names as its signer. */
  readonly signer: PublicKey;
  /** True when that signer is not the loaded keypair, so nothing here can
   *  sign for it and the transaction has to be printed instead. */
  readonly multisig: boolean;
}

/**
 * `ADMIN_ADDRESS` absent, or equal to the loaded key, keeps the old
 * sign-and-send behaviour. Anything else is a key this process does not hold
 * (on mainnet, the Squads vault).
 */
export function adminMode(
  adminAddress: string | undefined,
  localKey: PublicKey,
): AdminMode {
  if (!adminAddress) return { signer: localKey, multisig: false };
  let signer: PublicKey;
  try {
    signer = new PublicKey(adminAddress);
  } catch (cause) {
    throw new Error(
      `ADMIN_ADDRESS must be a base58 pubkey, got "${adminAddress}"`,
      { cause },
    );
  }
  return { signer, multisig: !signer.equals(localKey) };
}

/**
 * A legacy transaction with no signatures, fee payer `feePayer`, base58 for
 * Squads' "Import base58 encoded tx". A blockhash has to be in it for Squads
 * to accept and simulate the import, and it expires in about a minute; Squads
 * re-signs with its own at execute, so the value only has to outlive the
 * paste.
 */
export function encodeForSquads(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
  blockhash: string,
): string {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  return bs58.encode(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}
