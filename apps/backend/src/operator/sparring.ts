// The Sparring player: a backend-owned wallet that buys one Position in every
// Round so a lone human is never the whole pot (docs/plan/sparring-player).
// It is an ordinary Player, not the House and not the Operator, and signs its
// own placements with its own keypair.
//
// Same shape as the operator crank: `playSparring` is pure over a fabricated
// chain state, and the service below is plumbing.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import {
  ROUND_STATUS,
  clockUnixTimestamp,
  decodePlayer,
  decodePool,
  decodeRound,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";

/** One whole Ticket per tile, matching the web app's default input. */
export const STAKE_PER_TILE = 1_000_000n;
export const MIN_TILES = 6;
export const MAX_TILES = 8;
/** Program's board size (`constants::TILE_COUNT`), bits 0..35 of the mask. */
const TILES = 36;
/** Stop this many seconds before `buy_position` starts refusing, so a slow
 *  confirmation does not land inside the close buffer. */
const MARGIN = 2n;
const TICK_MS = 2_000;

export interface SparringContext {
  /** Chain clock, not wall time, as everywhere else in this module. */
  readonly now: bigint;
  readonly pool: PoolState;
  /** The Round at `pool.openRoundId`, null when none is open. */
  readonly openRound: RoundState | null;
  readonly owner: PublicKey;
  /** The Sparring Player's Tickets, in atomic units. */
  readonly entries: bigint;
  /** Does a Position for this owner already exist in `openRound`? */
  readonly hasPosition: boolean;
  readonly ix: OperatorInstructions;
  send(instructions: TransactionInstruction[]): Promise<string>;
}

/** Six to eight of the 36, uniform and without replacement, as a bitmask. */
function pickTiles(): { tiles: bigint; count: number } {
  const count = MIN_TILES + Math.floor(Math.random() * (MAX_TILES - MIN_TILES + 1));
  let tiles = 0n;
  for (let picked = 0; picked < count; ) {
    const bit = 1n << BigInt(Math.floor(Math.random() * TILES));
    if (tiles & bit) continue; // already covered; draw again
    tiles |= bit;
    picked += 1;
  }
  return { tiles, count };
}

/** Buys one Position, or does nothing. Returns whether it bought. */
export async function playSparring(ctx: SparringContext): Promise<boolean> {
  const { pool, openRound } = ctx;
  if (!openRound || openRound.status !== ROUND_STATUS.OPEN) return false;
  if (ctx.hasPosition) return false;
  if (ctx.now > openRound.endsAt - pool.closeBuffer - MARGIN) return false;

  const { tiles, count } = pickTiles();
  if (ctx.entries < STAKE_PER_TILE * BigInt(count)) return false;

  await ctx.send(
    await ctx.ix.buyPosition(
      pool,
      openRound.roundId,
      ctx.owner,
      tiles,
      STAKE_PER_TILE,
    ),
  );
  return true;
}

/**
 * Lost races, not failures: the Round closed between the read and the send, or
 * this tick's Position landed twice (the second `init` reports the account as
 * already in use, a raw Solana message rather than an IDL error name).
 */
const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  "RoundClosed",
  "RoundNotOpen",
]);
const isLostRace = (message: string): boolean =>
  EXPECTED_ERRORS.has(message) || message.includes("already in use");

@Injectable()
export class SparringService {
  private readonly logger = new Logger(SparringService.name);
  private readonly instructions: OperatorInstructions;
  /** Null switches the whole service off (no `SPARRING_KEYPAIR`). */
  private readonly keypair: Keypair | null;
  /** Single-flight: a pass that overruns the interval skips the next one. */
  private running = false;

  constructor(
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    const secret = config.get("SPARRING_KEYPAIR", { infer: true });
    this.keypair = secret ? Keypair.fromSecretKey(bs58.decode(secret)) : null;
    this.logger.log(
      this.keypair
        ? `sparring player on: ${this.keypair.publicKey.toBase58()}`
        : "sparring player off",
    );
    // `buy_position` is permissionless and touches no randomness, so neither
    // the authority nor the test-vrf flag reaches the instruction it builds.
    this.instructions = new OperatorInstructions(
      chain.program,
      chain.programId,
      chain.keypair.publicKey,
      false,
    );
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    const keypair = this.keypair;
    if (!keypair || this.running) return;
    this.running = true;
    try {
      await this.playOnce(keypair);
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error(String(cause), { cause });
      // Either way the Round is skipped; the next tick re-reads the chain.
      if (isLostRace(error.message)) {
        this.logger.debug(`skipped: ${error.message}`);
      } else {
        this.logger.error(`sparring play failed: ${error.message}`, error.stack);
      }
    } finally {
      this.running = false;
    }
  }

  /** Two account reads: pool + clock + Player, then Round + Position. */
  private async playOnce(keypair: Keypair): Promise<void> {
    const owner = keypair.publicKey;
    const poolKey = this.chain.poolAddress();
    const [poolInfo, clockInfo, playerInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        poolKey,
        SYSVAR_CLOCK_PUBKEY,
        this.chain.playerAddress(owner),
      ]);
    if (!poolInfo) {
      this.logger.debug("pool does not exist; run bootstrap first");
      return;
    }
    if (!playerInfo) {
      this.logger.debug("sparring player has not deposited; run sparring-setup");
      return;
    }
    const pool = decodePool(this.chain.program, poolKey, poolInfo.data);
    if (pool.openRoundId === 0n) return;

    const roundKey = this.chain.roundAddress(pool.openRoundId);
    const [roundInfo, positionInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        roundKey,
        this.chain.positionAddress(roundKey, owner),
      ]);

    const bought = await playSparring({
      now: clockUnixTimestamp(clockInfo?.data),
      pool,
      openRound: roundInfo
        ? decodeRound(this.chain.program, roundInfo.data)
        : null,
      owner,
      entries: decodePlayer(this.chain.program, playerInfo.data).entries,
      hasPosition: positionInfo !== null,
      ix: this.instructions,
      send: (instructions) => this.chain.send(instructions, keypair),
    });
    if (bought) this.logger.log(`bought a position in round ${pool.openRoundId}`);
  }
}
