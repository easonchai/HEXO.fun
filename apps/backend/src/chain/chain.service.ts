import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AnchorError,
  AnchorProvider,
  parseIdlErrors,
  Program,
  translateError,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { HexVaultEnv } from "../config/env";
import { loadIdl } from "./idl";
import {
  epochAddress,
  jackpotVaultAddress,
  playerAddress,
  poolAddress,
  positionAddress,
  principalVaultAddress,
  roundAddress,
} from "./pda";

export const SOLANA_CONNECTION = Symbol("SOLANA_CONNECTION");

/**
 * Connection, Program, authority keypair, PDA helpers and a signed-send
 * helper. No business logic (deposit/withdraw/etc calls) — that lands with
 * the operator and API tickets.
 */
@Injectable()
export class ChainService {
  readonly connection: Connection;
  readonly program: Program<Idl>;
  readonly programId: PublicKey;
  readonly keypair: Keypair;
  readonly poolId: bigint;

  private readonly errorNames: Map<number, string>;
  private readonly idlErrorMessages: Map<number, string>;

  constructor(
    @Inject(SOLANA_CONNECTION) connection: Connection,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.connection = connection;
    this.keypair = Keypair.fromSecretKey(
      bs58.decode(config.get("AUTHORITY_KEYPAIR", { infer: true })),
    );
    this.poolId = BigInt(config.get("POOL_ID", { infer: true }));
    this.programId = new PublicKey(config.get("PROGRAM_ID", { infer: true }));

    // The env-resolved program id wins over whatever address is baked into
    // the checked-in IDL snapshot, which goes stale between program builds.
    const idl = { ...loadIdl(), address: this.programId.toBase58() };
    const provider = new AnchorProvider(connection, new Wallet(this.keypair), {
      commitment: "confirmed",
    });
    this.program = new Program(idl, provider);

    this.idlErrorMessages = parseIdlErrors(idl);
    this.errorNames = new Map((idl.errors ?? []).map((e) => [e.code, e.name]));
  }

  poolAddress(poolId: bigint = this.poolId): PublicKey {
    return poolAddress(this.programId, poolId);
  }

  epochAddress(
    epochId: bigint,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return epochAddress(this.programId, pool, epochId);
  }

  roundAddress(
    roundId: bigint,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return roundAddress(this.programId, pool, roundId);
  }

  playerAddress(
    owner: PublicKey,
    pool: PublicKey = this.poolAddress(),
  ): PublicKey {
    return playerAddress(this.programId, pool, owner);
  }

  positionAddress(round: PublicKey, owner: PublicKey): PublicKey {
    return positionAddress(this.programId, round, owner);
  }

  principalVaultAddress(pool: PublicKey = this.poolAddress()): PublicKey {
    return principalVaultAddress(this.programId, pool);
  }

  jackpotVaultAddress(pool: PublicKey = this.poolAddress()): PublicKey {
    return jackpotVaultAddress(this.programId, pool);
  }

  /**
   * Signs with `signer` (the authority unless told otherwise, as for the
   * Sparring player), sends, confirms at "confirmed". The signer pays the fee.
   *
   * The blockhash is fetched at "finalized" on purpose. The RPC is a
   * load-balanced pool, and a "confirmed" blockhash from one node is not yet
   * known to a node a few slots behind, so preflight there fails with
   * "Blockhash not found". A finalized hash is ~32 slots old, which every node
   * has, and still leaves ~118 of its 150 valid slots to land.
   */
  async send(
    instructions: TransactionInstruction[],
    signer: Keypair = this.keypair,
  ): Promise<string> {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("finalized");
      const tx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: signer.publicKey,
      }).add(...instructions);
      tx.sign(signer);
      const signature = await this.connection.sendRawTransaction(
        tx.serialize(),
        {
          preflightCommitment: "confirmed",
        },
      );
      const { value } = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (value.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(value.err)}`,
        );
      }
      return signature;
    } catch (cause) {
      throw this.mapSendError(cause);
    }
  }

  /** Anchor's own logs already name the error; fall back to the IDL's error table. */
  mapSendError(cause: unknown): Error {
    const translated = translateError(cause, this.idlErrorMessages);
    if (translated instanceof AnchorError) {
      return new Error(translated.error.errorCode.code, { cause });
    }
    const code = (translated as { code?: number } | undefined)?.code;
    const name = code !== undefined ? this.errorNames.get(code) : undefined;
    if (name) return new Error(name, { cause });
    return translated instanceof Error
      ? translated
      : new Error(String(translated), { cause });
  }
}
