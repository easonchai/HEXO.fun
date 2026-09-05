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
  sendAndConfirmTransaction,
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

  epochAddress(epochId: bigint, pool: PublicKey = this.poolAddress()): PublicKey {
    return epochAddress(this.programId, pool, epochId);
  }

  roundAddress(roundId: bigint, pool: PublicKey = this.poolAddress()): PublicKey {
    return roundAddress(this.programId, pool, roundId);
  }

  playerAddress(owner: PublicKey, pool: PublicKey = this.poolAddress()): PublicKey {
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

  /** Signs with the authority keypair, sends, confirms at "confirmed". */
  async send(instructions: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...instructions);
    try {
      return await sendAndConfirmTransaction(this.connection, tx, [this.keypair], {
        commitment: "confirmed",
      });
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
