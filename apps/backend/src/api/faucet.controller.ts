import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  type OnModuleInit,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

const parseOwner = (body: unknown): PublicKey => {
  const raw = (body as { owner?: unknown } | null | undefined)?.owner;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BadRequestException(
      "Send a JSON body with an `owner` wallet address.",
    );
  }
  let owner: PublicKey;
  try {
    owner = new PublicKey(raw);
  } catch (cause) {
    throw new BadRequestException(
      "That is not a valid Solana wallet address.",
      { cause },
    );
  }
  // An off-curve address has no associated token account, so the mint would
  // fail on chain after we had already recorded the request.
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    throw new BadRequestException(
      "That address cannot hold tokens. Connect a wallet and try again.",
    );
  }
  return owner;
};

/**
 * The one write route in the API. It mints straight to the caller's
 * associated token account, which only works while the operator key is the
 * mint authority: true of the test mint on devnet, never of real USDC. The
 * route is resolved once at boot and answers 404 when it is not, so a
 * mainnet deployment has no faucet at all rather than a broken one.
 */
@Controller("faucet")
export class FaucetController implements OnModuleInit {
  private readonly logger = new Logger(FaucetController.name);
  private readonly mint: PublicKey;
  private readonly amount: bigint;
  private readonly intervalSeconds: bigint;
  /** Resolved once in `onModuleInit`; public only so a test can flip it. */
  isMintAuthority = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.mint = new PublicKey(config.get("ACCEPTED_MINT", { infer: true }));
    this.amount = BigInt(config.get("FAUCET_AMOUNT", { infer: true }));
    this.intervalSeconds = BigInt(
      config.get("FAUCET_INTERVAL_SECONDS", { infer: true }),
    );
  }

  /** A mint this key cannot mint leaves the route off, and so does a read
   *  that failed: an unknown authority is not permission to try. */
  async onModuleInit(): Promise<void> {
    const operator = this.chain.keypair.publicKey;
    try {
      const mint = await getMint(this.chain.connection, this.mint);
      this.isMintAuthority = mint.mintAuthority?.equals(operator) ?? false;
    } catch (cause) {
      this.logger.warn(
        `could not read mint ${this.mint.toBase58()}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (!this.isMintAuthority) {
      this.logger.log(
        `${operator.toBase58()} is not the authority of mint ${this.mint.toBase58()}; the faucet is off`,
      );
    }
  }

  @Post()
  async request(@Body() body: unknown) {
    if (!this.isMintAuthority) {
      throw new NotFoundException("There is no faucet on this network.");
    }
    const owner = parseOwner(body);
    const address = owner.toBase58();
    const now = BigInt(Math.floor(Date.now() / 1000));

    // ponytail: read-then-write, so two simultaneous requests for the same
    // owner can both mint. Costs 1000 units of test money; swap in a
    // conditional updateMany guard if that ever matters.
    const previous = await this.prisma.faucetClaim.findUnique({
      where: { owner: address },
    });
    if (previous !== null) {
      const elapsed = now - previous.lastClaimAt;
      if (elapsed < this.intervalSeconds) {
        const retryAfterSeconds = Number(this.intervalSeconds - elapsed);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: "Too Many Requests",
            message: `This wallet already received hexUSDC. Try again in ${Math.ceil(
              retryAfterSeconds / 60,
            )} minute(s).`,
            retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const tokenAccount = getAssociatedTokenAddressSync(this.mint, owner);
    const authority = this.chain.keypair.publicKey;
    let signature: string;
    try {
      signature = await this.chain.send([
        createAssociatedTokenAccountIdempotentInstruction(
          authority,
          tokenAccount,
          owner,
          this.mint,
        ),
        createMintToInstruction(this.mint, tokenAccount, authority, this.amount),
      ]);
    } catch (cause) {
      // The cause holds the RPC url and program logs; those stay here.
      this.logger.error(`faucet mint failed for ${address}`, cause);
      throw new ServiceUnavailableException(
        "The faucet could not send hexUSDC right now. Try again in a minute.",
        { cause },
      );
    }

    // Only after the mint landed, so a failed send does not cost the caller
    // an hour of waiting.
    await this.prisma.faucetClaim.upsert({
      where: { owner: address },
      create: { owner: address, lastClaimAt: now },
      update: { lastClaimAt: now },
    });

    return {
      owner: address,
      tokenAccount: tokenAccount.toBase58(),
      amount: this.amount,
      signature,
      nextRequestAt: now + this.intervalSeconds,
    };
  }
}
