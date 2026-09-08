/** Program id, env, PDA derivation. The chain is authoritative. */
import idl from "./idl/hex_vault.json";
import { BN, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, type Transaction } from "@solana/web3.js";

export type HexVaultProgram = Program<Idl>;

/** Builder returned by `program.methods.<name>(...)`. */
export interface TxBuilder {
  accounts(accounts: Record<string, unknown>): TxBuilder;
  preInstructions(instructions: unknown[]): TxBuilder;
  rpc(options?: { commitment?: string }): Promise<string>;
  /** Unsigned legacy transaction; fee payer and blockhash left unset. */
  transaction(): Promise<Transaction>;
}

/** Decoded-account accessor for one account type. */
export interface AccountApi {
  fetch(address: PublicKey): Promise<unknown>;
  fetchMultiple(addresses: PublicKey[]): Promise<(unknown | null)[]>;
}

/**
 * Loosely-typed view of the Anchor client: we drive it by IDL name instead of
 * generated types, so the app needs no codegen step.
 */
export interface ProgramApi {
  readonly methods: Record<string, (...args: unknown[]) => TxBuilder>;
  readonly account: Record<string, AccountApi>;
}

const apiOf = (program: HexVaultProgram): ProgramApi =>
  program as unknown as ProgramApi;

/**
 * Instruction builder by IDL name; fails loudly on a stale IDL copy. The
 * Anchor client camelCases the IDL on construction, so `buy_position` is
 * reached as `buyPosition` and the `Player` account as `player`.
 */
export const method = (
  program: HexVaultProgram,
  name: string,
): ((...args: unknown[]) => TxBuilder) => {
  const build = apiOf(program).methods[name];
  if (!build)
    throw new Error(`IDL has no instruction "${name}" (re-run sync-idl)`);
  return build;
};

/** Decoded-account accessor by IDL name. */
export const accountOf = (
  program: HexVaultProgram,
  name: string,
): AccountApi => {
  const api = apiOf(program).account[name];
  if (!api) throw new Error(`IDL has no account "${name}" (re-run sync-idl)`);
  return api;
};

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
}

const DATA_PREFIXES = ["Program data: ", "Program log: "];

/**
 * One spelling for an event name. The Anchor client camelCases the IDL, so a
 * decoded log says `roundSettled` while the IDL (and possibly the API's
 * `/feed`) says `RoundSettled`. Compare through this.
 */
export const eventKey = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Anchor's `emit!` writes the event as base64 behind `Program data:`, so the
 * name never appears in plain text — every log reader has to decode. One
 * helper serves both the activity feed and read.ts's settle trigger.
 */
export function decodeEventLogs(
  program: HexVaultProgram,
  logs: readonly string[],
): DecodedEvent[] {
  const coder = (
    program as unknown as {
      coder: { events: { decode(log: string): DecodedEvent | null } };
    }
  ).coder;
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const prefix = DATA_PREFIXES.find((value) => line.startsWith(value));
    if (!prefix) continue;
    try {
      const event = coder.events.decode(line.slice(prefix.length));
      if (event) out.push(event);
    } catch {
      // Not one of ours, or a truncated log line. Skip it.
    }
  }
  return out;
}

const env = (key: string): string | undefined => {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value?.trim() || undefined;
};

/** VITE_PROGRAM_ID wins so one bundle can point at a redeployed program. */
export const PROGRAM_ID = new PublicKey(env("VITE_PROGRAM_ID") ?? idl.address);

/** The single pool this build talks to; the demo runs pool 1. */
export const POOL_ID = BigInt(env("VITE_POOL_ID") ?? "1");

export const RPC_URL = env("VITE_RPC_URL") ?? "http://127.0.0.1:8899";

export const API_URL = env("VITE_API_URL") ?? "http://127.0.0.1:8080";

export const bn = (value: bigint | number | string): BN =>
  new BN(value.toString());

export const toBigint = (value: BN): bigint => BigInt(value.toString());

const pda = (seeds: (Uint8Array | Buffer)[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const le8 = (value: bigint): Buffer => bn(value).toArrayLike(Buffer, "le", 8);

export const poolAddress = (poolId: bigint): PublicKey =>
  pda([Buffer.from("pool"), le8(poolId)]);

export const epochAddress = (pool: PublicKey, epochId: bigint): PublicKey =>
  pda([Buffer.from("epoch"), pool.toBuffer(), le8(epochId)]);

/** Round ids are global to the pool now: no epoch id in the seeds. */
export const roundAddress = (pool: PublicKey, roundId: bigint): PublicKey =>
  pda([Buffer.from("round"), pool.toBuffer(), le8(roundId)]);

export const playerAddress = (pool: PublicKey, owner: PublicKey): PublicKey =>
  pda([Buffer.from("player"), pool.toBuffer(), owner.toBuffer()]);

/** Keyed by round, not pool: one position per wallet per round. */
export const positionAddress = (
  round: PublicKey,
  owner: PublicKey,
): PublicKey =>
  pda([Buffer.from("position"), round.toBuffer(), owner.toBuffer()]);

export const principalVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("principal"), pool.toBuffer()]);

export const jackpotVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("jackpot"), pool.toBuffer()]);

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

/** USDC is a classic SPL Token mint, so the ATA is the classic one. */
export const acceptedAta = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
