/**
 * Chain reads. This module owns the three accounts the UI cannot get wrong:
 * the Pool, the connected wallet's Player, and the open Round. Everything
 * else comes from `api.ts`. Polled every 2 s and re-read immediately when a
 * `RoundSettled` event lands on the program's logs.
 */
import { BN } from "@anchor-lang/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";

import {
  accountOf,
  acceptedAta,
  decodeEventLogs,
  eventKey,
  playerAddress,
  poolAddress,
  positionAddress,
  roundAddress,
  toBigint,
  tokenBalance,
  POOL_ID,
  PROGRAM_ID,
  type HexVaultProgram,
} from "./chain.js";
import { withdrawable } from "./lib/money.js";

export { withdrawable };

export interface PoolRow {
  poolId: bigint;
  authority: PublicKey;
  acceptedMint: PublicKey;
  principalVault: PublicKey;
  jackpotVault: PublicKey;
  treasury: PublicKey;
  buybackReserve: PublicKey;
  house: PublicKey;
  epochSeconds: bigint;
  roundSeconds: bigint;
  closeBuffer: bigint;
  vrfTimeout: bigint;
  minDeposit: bigint;
  paused: boolean;
  currentEpochId: bigint;
  currentEpochStart: bigint;
  previousEpochStart: bigint;
  nextRoundId: bigint;
  /** 0 when no round is open. */
  openRoundId: bigint;
  carryPot: bigint;
  totalPrincipal: bigint;
}

/** A pool row plus its own address: what every screen needs. */
export type PoolLike = { address: PublicKey } & PoolRow;

export interface PlayerRow {
  owner: PublicKey;
  principal: bigint;
  entries: bigint;
  weightAcc: bigint;
  lastUpdate: bigint;
  epochId: bigint;
  frozenWeight: bigint;
  frozenEpoch: bigint;
  regEpoch: bigint;
  regStart: bigint;
  regEnd: bigint;
  isHouse: boolean;
}

export interface RoundRow {
  roundId: bigint;
  epochId: bigint;
  startsAt: bigint;
  endsAt: bigint;
  /** 0 Open, 1 Requested, 2 Settled, 3 Forfeited, 4 Voided. */
  status: number;
  tileTotals: bigint[];
  pot: bigint;
  requestedAt: bigint;
  winningTile: number;
}

export interface PositionRow {
  owner: PublicKey;
  round: PublicKey;
  tiles: bigint;
  stakePerTile: bigint;
}

/**
 * Anchor decodes accounts with BN for u64/u128/i64. The UI works in bigint,
 * so normalize once, here. Pubkeys are re-keyed through THIS copy of web3.js:
 * dependency hoisting can put a second copy in the bundle, and foreign
 * PublicKey instances break the spl-token helpers (`mint.toBuffer is not a
 * function`).
 */
function normalize(value: unknown): unknown {
  if (value instanceof BN) return toBigint(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof PublicKey) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function" &&
    typeof (value as { toBytes?: unknown }).toBytes === "function"
  ) {
    // Duck-type a PublicKey from any web3.js copy (they all expose both).
    return new PublicKey((value as { toBase58(): string }).toBase58());
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const camel = key.replace(/_([a-zA-Z0-9])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      out[camel] = normalize(item);
    }
    return out;
  }
  return value;
}

function decode<T>(raw: unknown): T {
  return normalize(raw) as T;
}

/** Null instead of a throw: a missing account is a normal state here. */
async function fetchAccount<T>(
  program: HexVaultProgram,
  name: string,
  address: PublicKey,
): Promise<T | null> {
  try {
    return decode<T>(await accountOf(program, name).fetch(address));
  } catch {
    return null;
  }
}

export const fetchPool = (
  program: HexVaultProgram,
  address: PublicKey,
): Promise<PoolRow | null> => fetchAccount<PoolRow>(program, "pool", address);

export const fetchPlayer = (
  program: HexVaultProgram,
  pool: PublicKey,
  owner: PublicKey,
): Promise<PlayerRow | null> =>
  fetchAccount<PlayerRow>(program, "player", playerAddress(pool, owner));

export const fetchRound = (
  program: HexVaultProgram,
  pool: PublicKey,
  roundId: bigint,
): Promise<RoundRow | null> =>
  fetchAccount<RoundRow>(program, "round", roundAddress(pool, roundId));

export interface ChainState {
  pool: PoolLike | null;
  player: PlayerRow | null;
  /** The open round, or the last one this session saw once it has settled. */
  round: RoundRow | null;
  /** The connected wallet's position in `round`, when it has one. */
  position: PositionRow | null;
  /** The wallet's own hexUSDC balance, atomic units. */
  walletBalance: bigint;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 2000;

const EMPTY: Omit<ChainState, "refresh"> = {
  pool: null,
  player: null,
  round: null,
  position: null,
  walletBalance: 0n,
  loading: false,
  error: null,
};

export function useChainState(
  connection: Connection,
  program: HexVaultProgram | null,
  owner: PublicKey | undefined,
): ChainState {
  const [state, setState] = useState(EMPTY);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  /** A settled round stops being `open_round_id`, but the reveal still needs it. */
  const lastRoundId = useRef(0n);
  const ownerKey = owner?.toBase58();

  useEffect(() => {
    if (!program) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    const address = poolAddress(POOL_ID);

    const load = async (): Promise<void> => {
      try {
        const pool = await fetchPool(program, address);
        if (cancelled) return;
        if (!pool) {
          // A missing account and a stuttering RPC look the same from here, so
          // keep the last good read on screen and say so rather than blanking.
          setState((current) => ({
            ...current,
            loading: false,
            error: `pool ${POOL_ID} not readable at ${address.toBase58()}`,
          }));
          return;
        }
        if (pool.openRoundId > 0n) lastRoundId.current = pool.openRoundId;
        const roundId = lastRoundId.current;

        const [player, round, walletBalance] = await Promise.all([
          owner ? fetchPlayer(program, address, owner) : null,
          roundId > 0n ? fetchRound(program, address, roundId) : null,
          owner
            ? tokenBalance(connection, acceptedAta(pool.acceptedMint, owner))
            : 0n,
        ]);
        const position =
          owner && round
            ? await fetchAccount<PositionRow>(
                program,
                "position",
                positionAddress(roundAddress(address, roundId), owner),
              )
            : null;
        if (cancelled) return;
        setState({
          pool: { address, ...pool },
          player,
          round,
          position,
          walletBalance,
          loading: false,
          error: null,
        });
      } catch (caught) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
      }
    };

    setState((current) => ({ ...current, loading: true }));
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);

    // A settle changes every balance at once; do not wait for the next poll.
    const subscription = connection.onLogs(
      PROGRAM_ID,
      ({ logs }) => {
        const settled = decodeEventLogs(program, logs).some(
          (event) => eventKey(event.name) === "roundSettled",
        );
        if (settled) void load();
      },
      "confirmed",
    );

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void connection.removeOnLogsListener(subscription);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerKey stands in for owner
  }, [program, connection, ownerKey, tick]);

  return { ...state, refresh };
}
