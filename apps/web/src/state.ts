/** Chain-backed app state. Re-read from chain after every transaction. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Connection, PublicKey } from "@solana/web3.js";

import {
  acceptedAta,
  accountOf,
  epochAddress,
  playerAddress,
  poolAddress,
  receiptAta,
  toBigint,
  tokenBalance,
  type HexVaultProgram,
} from "./chain.js";
import {
  fetchPool,
  fetchRandomness,
  listEpochs,
  listPositions,
  listPools,
  listRounds,
  type EpochRow,
  type PoolLike,
  type PoolRow,
  type PositionRow,
  type RandomnessRow,
  type RoundRow,
} from "./read.js";

export interface PoolEntry {
  address: PublicKey;
  pool: PoolRow;
}

export interface Balances {
  principal: bigint;
  entries: bigint;
  accepted: bigint;
}

export interface VaultBalances {
  principalVault: bigint;
  prizeVault: bigint;
  jackpotVault: bigint;
}

export interface PlayerRow {
  lastEntryEpochId: bigint;
}

export interface VaultState {
  pools: PoolEntry[];
  pool: (PoolLike & { decimals: number }) | null;
  epochs: EpochRow[];
  rounds: RoundRow[];
  positions: Map<string, PositionRow>;
  balances: Balances;
  vaults: VaultBalances;
  epochRandomness: Map<string, RandomnessRow>;
  /** The connected wallet's per-pool refresh pointer, when present. */
  player: PlayerRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY_BALANCES: Balances = { principal: 0n, entries: 0n, accepted: 0n };
const EMPTY_VAULTS: VaultBalances = {
  principalVault: 0n,
  prizeVault: 0n,
  jackpotVault: 0n,
};

export function useVaultState(
  connection: Connection,
  program: HexVaultProgram | null,
  owner: PublicKey | undefined,
  poolId: bigint | null,
): VaultState {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const [pools, setPools] = useState<PoolEntry[]>([]);
  const [pool, setPool] = useState<PoolRow | null>(null);
  const [epochs, setEpochs] = useState<EpochRow[]>([]);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [positions, setPositions] = useState<Map<string, PositionRow>>(
    new Map(),
  );
  const [balances, setBalances] = useState<Balances>(EMPTY_BALANCES);
  const [vaults, setVaults] = useState<VaultBalances>(EMPTY_VAULTS);
  const [epochRandomness, setEpochRandomness] = useState<
    Map<string, RandomnessRow>
  >(new Map());
  const [player, setPlayer] = useState<PlayerRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setEpochs([]);
    setRounds([]);
    setPositions(new Map());
    setBalances(EMPTY_BALANCES);
    setVaults(EMPTY_VAULTS);
    setEpochRandomness(new Map());
    setPlayer(null);
  }, []);

  useEffect(() => {
    if (!program) {
      setPools([]);
      setPool(null);
      reset();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const discovered = await listPools(program);
        const selected =
          (poolId === null
            ? undefined
            : discovered.find((entry) => entry.pool.poolId === poolId)) ??
          (poolId === null ? undefined : await loadPoolById(program, poolId)) ??
          discovered[0] ??
          null;
        if (cancelled) return;
        setPools(discovered);
        setPool(selected?.pool ?? null);
        if (!selected) {
          reset();
          return;
        }

        const row = selected.pool;
        const epochRows = await listEpochs(
          program,
          selected.address,
          row.latestEpochId,
        );
        const epochKeys = epochRows.map((epoch) =>
          epochAddress(selected.address, epoch.id),
        );
        const roundRows = await listRounds(program, epochKeys);
        const positionRows = owner
          ? await listPositions(program, selected.address, owner, roundRows)
          : new Map<string, PositionRow>();

        const requests = new Map<string, RandomnessRow>();
        await Promise.all(
          epochRows.flatMap((epoch, index) => {
            const key = epoch.id.toString();
            const subject = epochKeys[index]!;
            return [1, 2].map(async (kind) => {
              const request = await fetchRandomness(
                program,
                selected.address,
                subject,
                kind,
              );
              if (request) {
                requests.set(
                  `${kind === 1 ? "prize" : "jackpot"}:${key}`,
                  request,
                );
              }
            });
          }),
        );

        const [
          principal,
          entries,
          accepted,
          principalVault,
          prizeVault,
          jackpotVault,
        ] = await Promise.all([
          owner
            ? tokenBalance(connection, receiptAta(row.principalMint, owner))
            : Promise.resolve(0n),
          owner
            ? tokenBalance(connection, receiptAta(row.entryMint, owner))
            : Promise.resolve(0n),
          owner
            ? tokenBalance(
                connection,
                acceptedAta(row.acceptedMint, owner, row.acceptedTokenProgram),
              )
            : Promise.resolve(0n),
          tokenBalance(connection, row.principalVault),
          tokenBalance(connection, row.prizeVault),
          tokenBalance(connection, row.jackpotVault),
        ]);

        let playerRow: PlayerRow | null = null;
        if (owner) {
          try {
            const decoded = (await accountOf(program, "player").fetch(
              playerAddress(selected.address, owner),
            )) as Record<string, unknown>;
            const raw = decoded.last_entry_epoch_id ?? decoded.lastEntryEpochId;
            playerRow = { lastEntryEpochId: toBigint(raw as never) };
          } catch {
            playerRow = null; // no Player account yet (never deposited)
          }
        }

        if (cancelled) return;
        setEpochs(epochRows);
        setRounds(roundRows);
        setPositions(positionRows);
        setEpochRandomness(requests);
        setPlayer(playerRow);
        setBalances({ principal, entries, accepted });
        setVaults({ principalVault, prizeVault, jackpotVault });
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, connection, owner, poolId, tick, reset]);

  return {
    pools,
    pool: pool
      ? {
          address: poolAddress(pool.poolId),
          ...pool,
          decimals: pool.acceptedDecimals,
        }
      : null,
    epochs,
    rounds,
    positions,
    balances,
    vaults,
    epochRandomness,
    player,
    loading,
    error,
    refresh,
  };
}

/** Manual pool id typed into the selector before any discovery saw it. */
async function loadPoolById(
  program: HexVaultProgram,
  poolId: bigint,
): Promise<PoolEntry | undefined> {
  const address = poolAddress(poolId);
  const row = await fetchPool(program, address);
  return row ? { address, pool: row } : undefined;
}
