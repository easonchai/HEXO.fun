import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { PrismaService } from "../prisma/prisma.service";
import { accessMessage, normalizeInviteCode, verifyAccessSignature } from "./invite-code";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const parseWallet = (raw: string): PublicKey => {
  try {
    return new PublicKey(raw);
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

interface RedeemBody {
  wallet: PublicKey;
  code: string;
  signature: Uint8Array;
}

function parseRedeemBody(body: unknown): RedeemBody {
  const raw = body as
    | { wallet?: unknown; code?: unknown; signature?: unknown }
    | null
    | undefined;
  if (typeof raw?.wallet !== "string" || raw.wallet.length === 0) {
    throw new BadRequestException("Send a JSON body with a `wallet` address.");
  }
  const wallet = parseWallet(raw.wallet);
  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new BadRequestException("Send a JSON body with an invite `code`.");
  }
  if (typeof raw.signature !== "string" || raw.signature.length === 0) {
    throw new BadRequestException("Send a JSON body with a base58 `signature`.");
  }
  let signature: Uint8Array;
  try {
    signature = bs58.decode(raw.signature);
  } catch {
    throw new BadRequestException("`signature` must be base58.");
  }
  if (signature.length !== 64) {
    throw new BadRequestException("`signature` must be a 64-byte ed25519 signature.");
  }
  return { wallet, code: normalizeInviteCode(raw.code), signature };
}

const isUniqueConstraintViolation = (cause: unknown): boolean =>
  cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002";

/**
 * The private-beta gate (docs/plan/hexo-referrals ticket 06). The program
 * itself is not gated; this is UI-only. Throttled in api.module.ts like
 * FaucetController, since redeem is the one endpoint here a script could
 * hammer trying codes.
 */
@Controller("access")
export class AccessController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":wallet")
  async getAccess(@Param("wallet") walletRaw: string) {
    const wallet = parseWallet(walletRaw).toBase58();
    const [redemption, player] = await Promise.all([
      this.prisma.inviteRedemption.findUnique({ where: { wallet } }),
      this.prisma.player.findUnique({ where: { owner: wallet } }),
    ]);
    if (redemption !== null) {
      return { allowed: true, reason: "invite code redeemed" };
    }
    if (player !== null) {
      return { allowed: true, reason: "existing depositor" };
    }
    return { allowed: false, reason: "no invite code redeemed" };
  }

  /**
   * Verifies `signature` is `wallet`'s own ed25519 signature over
   * `accessMessage(wallet, code)` (see invite-code.ts), then spends one use
   * of `code` and binds it to `wallet`, so nobody can redeem on someone
   * else's wallet and no wallet can redeem twice.
   *
   * The use count only increments inside a conditional `updateMany` (`uses <
   * maxUses`), so two requests racing for a code's last use both run, but
   * Postgres serializes the two UPDATEs on that row: only the first commits
   * with the count still under the limit, and the second re-reads it already
   * at `maxUses` and updates zero rows. The wallet's own uniqueness is the
   * `InviteRedemption` primary key: a losing race there surfaces as a
   * Postgres unique-violation (P2002), caught below.
   *
   * When the code has an owner, the owner is not the redeemer (no
   * self-referral) and the redeemer has no Player yet (binding only before a
   * first deposit), this also writes the `Referral` (ticket 07). It is never
   * updated after that: a wallet redeems at most once, so this branch runs
   * at most once per referee.
   */
  @Post("redeem")
  async redeem(@Body() body: unknown) {
    const { wallet, code, signature } = parseRedeemBody(body);
    if (!verifyAccessSignature(wallet, code, signature)) {
      throw new BadRequestException(
        `That signature does not match "${accessMessage(wallet.toBase58(), code)}".`,
      );
    }
    const address = wallet.toBase58();

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.inviteRedemption.findUnique({ where: { wallet: address } });
        if (existing !== null) {
          throw new ConflictException("This wallet has already redeemed an invite code.");
        }
        const invite = await tx.inviteCode.findUnique({ where: { code } });
        if (invite === null) {
          throw new NotFoundException("That invite code does not exist.");
        }
        const updated = await tx.inviteCode.updateMany({
          where: { code, uses: { lt: invite.maxUses } },
          data: { uses: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw new ConflictException("That invite code has no uses left.");
        }
        await tx.inviteRedemption.create({
          data: { wallet: address, code, redeemedAt: nowSeconds() },
        });
        if (invite.ownerWallet !== null && invite.ownerWallet !== address) {
          const player = await tx.player.findUnique({ where: { owner: address } });
          if (player === null) {
            await tx.referral.create({
              data: { referee: address, referrer: invite.ownerWallet, code, boundAt: nowSeconds() },
            });
          }
        }
      });
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) {
        throw new ConflictException("This wallet has already redeemed an invite code.");
      }
      throw cause;
    }

    return { allowed: true, reason: "invite code redeemed" };
  }
}
