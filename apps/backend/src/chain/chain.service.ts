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
  type SignatureResult,
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
 * How long `send` waits for a signature subscription to report before
 * falling back to one status query and one block-height read (ticket 04,
 * spec.md "A subscription still has to notice a dropped transaction"): a
 * bare subscription would wait forever for a transaction that never landed,
 * so the wait is bounded and the fallback decides pending from expired.
 */
export const CONFIRM_TIMEOUT_MS = 30_000;

/** Ceiling for a one-off RPC read that nothing else bounds: a boot check or
 *  a read behind an HTTP request. */
export const RPC_READ_TIMEOUT_MS = 10_000;

/**
 * Rejects with a named error once `ms` has passed, if `promise` has not
 * settled by then. web3.js takes no per-call timeout, so an RPC that accepts
 * the connection and then says nothing would otherwise hold a boot step or a
 * `/status` request open with no ceiling. `send` has its own bounded wait
 * (`CONFIRM_TIMEOUT_MS` above); this is for the plain reads.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Connection, Program, operator keypair, PDA helpers and a signed-send
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
  /**
   * The last Clock sysvar reading (the operator's tick takes one) and the wall
   * time it was taken at. The indexer's live log path timestamps events from
   * this instead of paying a `getBlockTime` call per event (ticket 04).
   */
  private lastChainTime: { value: bigint; observedAtMs: number } | undefined;

  constructor(
    @Inject(SOLANA_CONNECTION) connection: Connection,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.connection = connection;
    this.keypair = Keypair.fromSecretKey(
      bs58.decode(config.get("OPERATOR_KEYPAIR", { infer: true })),
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

  /** Records a Clock sysvar reading, for `lastObservedChainTime`. */
  recordChainTime(now: bigint): void {
    this.lastChainTime = { value: now, observedAtMs: Date.now() };
  }

  /**
   * The last chain time read, advanced by the wall seconds since. The operator
   * can sleep a minute between reads, and an event stamped with a minute-old
   * clock would land in the wrong Round. The advance is the only wall time in
   * it; a fast local validator's chain clock pulls ahead again on the next
   * read. Undefined until something has read the clock once.
   */
  lastObservedChainTime(): bigint | undefined {
    if (this.lastChainTime === undefined) return undefined;
    const elapsedMs = Math.max(0, Date.now() - this.lastChainTime.observedAtMs);
    return this.lastChainTime.value + BigInt(Math.floor(elapsedMs / 1000));
  }

  /**
   * Signs with `signer` (the operator unless told otherwise, as for the
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
      // SAFETY: sign() has just filled the fee payer's signature slot.
      const signature = bs58.encode(tx.signature as Buffer);
      // Subscribe before sending. The RPC only notifies a signature that lands
      // after the subscription opens, so one that confirms first never would.
      const watch = this.watchSignature(signature);
      try {
        await this.connection.sendRawTransaction(tx.serialize(), {
          preflightCommitment: "confirmed",
        });
      } catch (cause) {
        watch.cancel();
        throw cause;
      }
      await this.confirm(signature, await watch.result, lastValidBlockHeight);
      return signature;
    } catch (cause) {
      throw this.mapSendError(cause);
    }
  }

  /**
   * Confirms `signature` off a subscription instead of polling block height
   * once a second (ticket 04, spec.md "transaction confirmation to come from
   * a subscription rather than a block-height poll"): web3.js's own
   * `confirmTransaction`, given a blockhash strategy, races that very poll
   * against the subscription, so it pays for it even on the happy path.
   *
   * Bounded by `CONFIRM_TIMEOUT_MS`. Past it, one `getSignatureStatuses` plus
   * one `getBlockHeight` decide pending (the blockhash has not expired yet)
   * from expired, so a dropped send still surfaces as an error rather than a
   * hang, which is the property the block-height strategy used to provide.
   */
  private async confirm(
    signature: string,
    result: SignatureResult | "timeout",
    lastValidBlockHeight: number,
  ): Promise<void> {
    if (result !== "timeout") {
      if (result.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(result.err)}`,
        );
      }
      return;
    }
    // The subscription itself may have dropped without web3.js noticing yet
    // (it resubscribes on reconnect, but that misses a notification already
    // in flight when the socket closed), so ask directly before giving up.
    const [status] = (await this.connection.getSignatureStatuses([signature])).value;
    if (status) {
      if (status.err) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        );
      }
      return;
    }
    const blockHeight = await this.connection.getBlockHeight("confirmed");
    if (blockHeight > lastValidBlockHeight) {
      throw new Error(
        `transaction ${signature} expired: block height ${blockHeight} passed the blockhash's last valid height ${lastValidBlockHeight}`,
      );
    }
    throw new Error(
      `transaction ${signature} still pending after ${CONFIRM_TIMEOUT_MS}ms; the blockhash has not expired yet`,
    );
  }

  /** One-shot wait for `signature` to reach "confirmed", or `"timeout"` past
   *  `CONFIRM_TIMEOUT_MS` or on `cancel`. web3.js drops a signature listener
   *  itself once it fires, so only the timeout and cancel paths remove it. */
  private watchSignature(signature: string): {
    result: Promise<SignatureResult | "timeout">;
    cancel: () => void;
  } {
    let resolve!: (value: SignatureResult | "timeout") => void;
    const result = new Promise<SignatureResult | "timeout">((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => stop(), CONFIRM_TIMEOUT_MS);
    const subscriptionId = this.connection.onSignature(
      signature,
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      "confirmed",
    );
    const stop = () => {
      clearTimeout(timer);
      void this.connection.removeSignatureListener(subscriptionId);
      resolve("timeout");
    };
    return { result, cancel: stop };
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
