/**
 * Ticket 07: the Indexer is the browser's read model now, not a cache in
 * front of an authoritative chain. `GET /state` (see `useStatePoll.ts`) is
 * the only source for Pool, Epoch, Round, Player and Position. The one
 * surviving direct chain read is the connected wallet's own token balance,
 * below, against the public endpoint on the visitor's own rate-limit
 * budget — nothing else in the browser touches the chain.
 */
import { useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";

import { acceptedAta } from "./chain.js";
import type { PoolDto } from "./api.js";

/**
 * What `actions.ts` needs to build instructions, and what the screens need to
 * gate the UI. All of it derives from `/state`'s `pool`: `closeBuffer` and
 * `minDeposit` are columns on the mirror (migration
 * 20260914061500_pool_close_buffer_and_min_deposit), so serving this costs
 * no chain read.
 */
export interface PoolLike {
  address: PublicKey;
  acceptedMint: PublicKey;
  closeBuffer: bigint;
  minDeposit: bigint;
  /** Share of a settled round's pot credited to the House, in basis points. */
  houseCutBps: number;
  paused: boolean;
  /** One epoch's length in seconds, for the buy-tickets draw-value preview. */
  epochSeconds: bigint;
  /** Base yield's APR on time-weighted Principal, in basis points (ADR 0011). */
  baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. */
  ticketsPerUsdc: number;
  /** Already validated and capped (`safePriorityFee`); the only fee the send
   *  helper (`actions.ts`, ticket 08) ever signs with. */
  priorityFeeMicroLamports: number;
}

/**
 * The floor the send helper signs with when `/state`'s estimate is 0 or
 * missing (a failed backend read, or genuinely no congestion) — the ticket's
 * "the web uses its own floor".
 */
const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 1_000;

/**
 * Hard ceiling on `/state`'s `priorityFeeMicroLamports` before it ever
 * reaches a signature (security review ticket 14): `/state` is
 * unauthenticated input, so this caps what a compromised or misconfigured
 * backend could make a wallet sign away in fees, independent of whatever cap
 * the backend itself applies (`PRIORITY_FEE_MAX_MICROLAMPORTS`). Matches
 * that config's own default so a correctly configured backend never gets
 * clamped a second time.
 */
const PRIORITY_FEE_CEILING_MICROLAMPORTS = 50_000;

/**
 * Validates `/state`'s `priorityFeeMicroLamports` at the boundary: a finite
 * non-negative integer, clamped to `[PRIORITY_FEE_FLOOR_MICROLAMPORTS,
 * PRIORITY_FEE_CEILING_MICROLAMPORTS]`. Anything else — `NaN`, a negative
 * number, a fraction, `Infinity` — floors to the minimum rather than signing
 * whatever the backend sent.
 */
export function safePriorityFee(raw: number): number {
  const value = Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return Math.min(
    Math.max(value, PRIORITY_FEE_FLOOR_MICROLAMPORTS),
    PRIORITY_FEE_CEILING_MICROLAMPORTS,
  );
}

/** Pure mapping from the API's decimal-string shape to the PublicKey/bigint one signing code needs. */
export function poolFromDto(
  dto: PoolDto & { closeBuffer: string; minDeposit: string },
  priorityFeeMicroLamports: number,
): PoolLike {
  return {
    address: new PublicKey(dto.address),
    acceptedMint: new PublicKey(dto.mint),
    closeBuffer: BigInt(dto.closeBuffer),
    minDeposit: BigInt(dto.minDeposit),
    houseCutBps: dto.houseCutBps,
    paused: dto.paused,
    epochSeconds: BigInt(dto.epochSeconds),
    baseRateBps: dto.baseRateBps,
    ticketsPerUsdc: dto.ticketsPerUsdc,
    priorityFeeMicroLamports: safePriorityFee(priorityFeeMicroLamports),
  };
}

/**
 * The one surviving direct chain read (spec.md "Wallet balances stay on the
 * chain"): the connected wallet's own USDC balance. `reloadKey` says when to
 * take it again, and it has to be a value that only changes when something
 * moved — pass the state poll's `data` object itself and this re-reads the
 * chain every 2 s per viewer, which is the polling the whole effort removed.
 * App.tsx passes `snapshot(state)` plus a faucet nonce.
 */
export function useWalletBalance(
  connection: Connection,
  mint: string | null,
  owner: PublicKey | undefined,
  reloadKey: unknown,
): bigint {
  const [balance, setBalance] = useState(0n);

  useEffect(() => {
    if (!mint || !owner) {
      setBalance(0n);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ata = acceptedAta(new PublicKey(mint), owner);
        const { value } = await connection.getTokenAccountBalance(ata);
        if (!cancelled) setBalance(BigInt(value.amount));
      } catch {
        // No ATA yet (never deposited) or a stuttering RPC: 0 keeps the
        // header chip rendering instead of erroring the whole screen.
        if (!cancelled) setBalance(0n);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, mint, owner, reloadKey]);

  return balance;
}
