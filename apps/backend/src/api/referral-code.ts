// A wallet's own ReferralCode (ADR 0014): minted by the indexer on a first
// deposit, or by GET /referrals/:wallet for a wallet past the beta gate that
// has not deposited yet, so it can start referring first.
import type { Prisma } from "@prisma/client";

import { generateInviteCode } from "./invite-code";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/**
 * A fresh code, reusing InviteCode's own alphabet and length. Unlike
 * InviteCode's insert, which lets its own primary key catch a collision,
 * ReferralCode and InviteCode are separate tables: a generated code landing
 * in the other one would not fail an insert, so this checks both by hand
 * before returning one.
 */
async function generateReferralCode(tx: Prisma.TransactionClient): Promise<string> {
  for (;;) {
    const code = generateInviteCode();
    const [invite, referral] = await Promise.all([
      tx.inviteCode.findUnique({ where: { code } }),
      tx.referralCode.findUnique({ where: { code } }),
    ]);
    if (invite === null && referral === null) return code;
  }
}

/**
 * `owner`'s ReferralCode, creating it if it has none. `skipDuplicates`
 * (ON CONFLICT DO NOTHING) lets the indexer and the API race to mint the
 * same wallet's code without either one throwing: the loser re-reads the
 * winner's row.
 */
export async function ensureReferralCode(tx: Prisma.TransactionClient, owner: string): Promise<string> {
  const owned = await tx.referralCode.findUnique({ where: { owner } });
  if (owned !== null) return owned.code;
  await tx.referralCode.createMany({
    data: [{ code: await generateReferralCode(tx), owner, createdAt: nowSeconds() }],
    skipDuplicates: true,
  });
  return (await tx.referralCode.findUniqueOrThrow({ where: { owner } })).code;
}
