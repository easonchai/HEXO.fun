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
}

/** Pure mapping from the API's decimal-string shape to the PublicKey/bigint one signing code needs. */
export function poolFromDto(
  dto: PoolDto & { closeBuffer: string; minDeposit: string },
): PoolLike {
  return {
    address: new PublicKey(dto.address),
    acceptedMint: new PublicKey(dto.mint),
    closeBuffer: BigInt(dto.closeBuffer),
    minDeposit: BigInt(dto.minDeposit),
    houseCutBps: dto.houseCutBps,
    paused: dto.paused,
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
