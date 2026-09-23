// Invite code format, generation and redeem-signature verification
// (docs/plan/hexo-referrals ticket 06). Pure and DB-free so the admin CLI,
// the indexer and the API can all import it without pulling in Prisma.
import { createPublicKey, randomInt, verify as verifyEd25519 } from "node:crypto";

import type { PublicKey } from "@solana/web3.js";

/** No 0/O/1/I: none of the 32 symbols can be confused reading a code aloud
 *  or off a screenshot. */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const INVITE_CODE_LENGTH = 8;

/** A fresh 8-character code. Collisions against `INVITE_CODE_ALPHABET`'s
 *  32^8 (~1.1e12) space are not checked for: the caller's `InviteCode.code`
 *  primary key surfaces one as a clear insert failure instead. */
export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

/** Redeem is case-insensitive on input; codes are stored and compared in
 *  this canonical upper-cased, trimmed form. */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The exact bytes `POST /access/redeem` must be signed over, so the backend
 *  builds this itself rather than trusting a client-supplied message. With a
 *  `referralCode` (docs/plan/referral-page ticket 02, ADR 0014), it rides
 *  inside this same message so applying one costs no extra signature;
 *  omitted, the message is exactly what it was before ticket 02. */
export function accessMessage(wallet: string, code: string, referralCode?: string): string {
  return referralCode
    ? `HEXO access: ${wallet} ${code} ref:${referralCode}`
    : `HEXO access: ${wallet} ${code}`;
}

/**
 * True when `signature` is `wallet`'s ed25519 signature over `message`. The
 * shared verify step behind `verifyAccessSignature` and
 * `verifyApplyReferralSignature`. A Solana address doubles as an Ed25519
 * public key, so this needs no extra keypair material: Node's built-in
 * `crypto` (Ed25519 verify shipped since Node 16) is the only "dependency",
 * since neither tweetnacl nor @noble/curves is reachable from this package
 * (checked: @solana/web3.js 1.98.4 ships no runtime dependencies at all).
 */
function verifySignedMessage(wallet: PublicKey, message: string, signature: Uint8Array): boolean {
  let key;
  try {
    key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(wallet.toBytes()).toString("base64url") },
      format: "jwk",
    });
  } catch {
    return false;
  }
  try {
    return verifyEd25519(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** True when `signature` is `wallet`'s ed25519 signature over
 *  `accessMessage(wallet, code, referralCode)`. */
export function verifyAccessSignature(
  wallet: PublicKey,
  code: string,
  signature: Uint8Array,
  referralCode?: string,
): boolean {
  return verifySignedMessage(wallet, accessMessage(wallet.toBase58(), code, referralCode), signature);
}

/** The exact bytes `POST /referrals/apply` must be signed over (docs/plan/
 *  referral-page ticket 02). Distinct from `accessMessage`, per ADR 0014, so
 *  a redeem signature can't be replayed here, or vice versa. */
export function applyReferralMessage(wallet: string, code: string): string {
  return `HEXO apply referral: ${wallet} ${code}`;
}

/** True when `signature` is `wallet`'s ed25519 signature over
 *  `applyReferralMessage(wallet, code)`. */
export function verifyApplyReferralSignature(
  wallet: PublicKey,
  code: string,
  signature: Uint8Array,
): boolean {
  return verifySignedMessage(wallet, applyReferralMessage(wallet.toBase58(), code), signature);
}
