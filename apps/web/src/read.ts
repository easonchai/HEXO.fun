/**
 * Chain reads. This module owns the three accounts the UI cannot get wrong:
 * the Pool, the connected wallet's Player, and the open Round. Everything
 * else comes from `api.ts`. One `getMultipleAccountsInfo` every 10 s, and
 * one more per burst of program events on the logs websocket.
 */
import { BN } from "@anchor-lang/core";
import { AccountLayout } from "@solana/spl-token";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PublicKey,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";

import {
  acceptedAta,
  decodeEventLogs,
  playerAddress,
  poolAddress,
  positionAddress,
  roundAddress,
  toBigint,
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

/** Decode raw account bytes already fetched; null for a missing account. */
function decodeAccount<T>(
  program: HexVaultProgram,
  name: string,
  info: AccountInfo<Buffer> | null | undefined,
): T | null {
  if (!info) return null;
  const coder = (
    program as unknown as {
      coder: { accounts: { decode(name: string, data: Buffer): unknown } };
    }
  ).coder;
  try {
    return decode<T>(coder.accounts.decode(name, info.data));
  } catch {
    return null;
  }
}

/** SPL token balance from raw account bytes; a missing account reads as zero. */
const decodeTokenAmount = (info: AccountInfo<Buffer> | null | undefined): bigint =>
  info ? AccountLayout.decode(info.data).amount : 0n;

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

/** Fallback cadence; the logs subscription below reloads on every event. */
const POLL_MS = 10_000;
/**
 * Window that folds a burst of events (or a `refresh()`) into one read. A
 * settle sequence spans a few slots (~400 ms each), so 1 s covers it.
 */
const COALESCE_MS = 1_000;

/** What the last pool read told us the other addresses are. */
interface ReadPlan {
  mint: string;
  roundId: bigint;
}

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
  // `refresh` reaches the live scheduler through a ref so a caller's re-read
  // coalesces with the event-triggered one instead of restarting the effect
  // (which also tore down and re-opened the logs subscription).
  const scheduleRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => scheduleRef.current(), []);
  /**
   * The round and token addresses come from the pool, so the first read only
   * knows the pool; every later read fetches all six accounts in one call.
   * A settled round stops being `open_round_id`, but the reveal still needs
   * it, so `roundId` is the last open one this session saw.
   */
  const plan = useRef<ReadPlan | null>(null);
  const ownerKey = owner?.toBase58();

  useEffect(() => {
    if (!program) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    const address = poolAddress(POOL_ID);

    const load = async (followUp = true): Promise<void> => {
      try {
        const known = plan.current;
        const round =
          known && known.roundId > 0n ? roundAddress(address, known.roundId) : null;
        const wanted: [string, PublicKey | null][] = [
          ["pool", address],
          ["player", owner ? playerAddress(address, owner) : null],
          ["round", round],
          ["position", owner && round ? positionAddress(round, owner) : null],
          ["wallet", owner && known ? acceptedAta(new PublicKey(known.mint), owner) : null],
        ];
        const keys = wanted.filter(
          (entry): entry is [string, PublicKey] => entry[1] !== null,
        );
        const infos = await connection.getMultipleAccountsInfo(
          keys.map(([, key]) => key),
        );
        if (cancelled) return;
        const infoOf = (name: string): AccountInfo<Buffer> | null =>
          infos[keys.findIndex(([key]) => key === name)] ?? null;

        const pool = decodeAccount<PoolRow>(program, "pool", infoOf("pool"));
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
        const next: ReadPlan = {
          mint: pool.acceptedMint.toBase58(),
          roundId: pool.openRoundId > 0n ? pool.openRoundId : (known?.roundId ?? 0n),
        };
        const stale =
          !known || known.mint !== next.mint || known.roundId !== next.roundId;
        if (stale) {
          plan.current = next;
          // The pool named addresses this read did not ask for (first read, or
          // a new round opened): read once more, now with the full list.
          if (followUp) return load(false);
        }

        setState({
          pool: { address, ...pool },
          player: decodeAccount<PlayerRow>(program, "player", infoOf("player")),
          round: decodeAccount<RoundRow>(program, "round", infoOf("round")),
          position: decodeAccount<PositionRow>(program, "position", infoOf("position")),
          walletBalance: decodeTokenAmount(infoOf("wallet")),
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

    // Program events land in bursts (a settle sequence is several
    // transactions in one slot), and a burst per viewer is what tripped the
    // RPC's 429. One read per burst: the first event arms a short timer and
    // the rest ride on it.
    let pending: number | null = null;
    const schedule = () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        void load();
      }, COALESCE_MS);
    };
    scheduleRef.current = schedule;

    setState((current) => ({ ...current, loading: true }));
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) schedule();
    }, POLL_MS);

    // Every program event moves something on screen (a deposit, a position,
    // a settle, a new round); re-read soon instead of waiting 10 s.
    const subscription = connection.onLogs(
      PROGRAM_ID,
      ({ logs, err }) => {
        if (err) return;
        if (decodeEventLogs(program, logs).length > 0) schedule();
      },
      "confirmed",
    );

    return () => {
      cancelled = true;
      scheduleRef.current = () => {};
      if (pending !== null) window.clearTimeout(pending);
      window.clearInterval(timer);
      void connection.removeOnLogsListener(subscription);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerKey stands in for owner
  }, [program, connection, ownerKey]);

  return { ...state, refresh };
}
