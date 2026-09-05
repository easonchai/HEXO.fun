/**
 * Indexer REST client (spec §3.5). The API is a cache; chain stays
 * authoritative. Nothing here throws: a failed call comes back as
 * `{ ok: false, reason }` so a screen can show a banner instead of crashing.
 *
 * Every u64/u128/timestamp arrives as a decimal string (spec §3.2), so these
 * types say `string` and the UI converts with BigInt where it needs to.
 */
import { API_URL } from "./chain.js";
import type { StatusValue } from "./lib/protocol.js";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** VITE_API_URL, or the local backend's default port. */
export const apiBaseUrl = (): string => API_URL;

async function get<T>(
  baseUrl: string,
  path: string,
  signal?: AbortSignal | null,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: signal ?? null,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}

export interface PoolDto {
  address: string;
  poolId: string;
  authority: string;
  mint: string;
  epochSeconds: string;
  roundSeconds: string;
  paused: boolean;
  currentEpochId: string;
  totalPrincipal: string;
  carryPot: string;
  updatedSlot: string;
}

export interface EpochDto {
  id: string;
  startsAt: string;
  endsAt: string;
  status: StatusValue;
  registeredWeight: string;
  registeredCount: number;
  jackpotAmount: string;
  target: string;
  winner: string | null;
}

export interface RoundDto {
  id: string;
  epochId: string;
  startsAt: string;
  endsAt: string;
  status: StatusValue;
  pot: string;
  winningTile: number;
  tileTotals: string[];
}

export interface PlayerDto {
  owner: string;
  principal: string;
  entries: string;
  weightAcc: string;
  lastUpdate: string;
  epochId: string;
  frozenWeight: string;
  frozenEpoch: string;
  regEpoch: string;
  regStart: string;
  regEnd: string;
  isHouse: boolean;
  /** weightAcc + entries × (now − lastUpdate). */
  liveWeight: string;
  /** liveWeight / epoch registered weight, 0..1. */
  odds: number;
}

export interface EventDto {
  slot: string;
  signature: string;
  index: number;
  name: string;
  data: Record<string, unknown>;
  blockTime: string | null;
}

export interface StatusDto {
  operator: {
    lastTickAt: string | null;
    lastAction: string | null;
    lastError: string | null;
    registeredCount: number;
    registeredTotal: number;
  };
  cursor: {
    lastSlot: string | null;
    lastSignature: string | null;
    ageSeconds: number;
  };
  rpcOk: boolean;
}

export interface PoolSummaryDto {
  pool: PoolDto;
  epoch: EpochDto | null;
  round: RoundDto | null;
}

export type CurrentEpochDto = EpochDto & { eligibleCount: number };

export const fetchPoolSummary = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<PoolSummaryDto>> =>
  get<PoolSummaryDto>(baseUrl, "/pool", signal);

export const fetchEpochs = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<EpochDto[]>> =>
  get<EpochDto[]>(baseUrl, `/epochs?limit=${limit}`, signal);

export const fetchCurrentEpoch = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<CurrentEpochDto>> =>
  get<CurrentEpochDto>(baseUrl, "/epochs/current", signal);

export const fetchRounds = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<RoundDto[]>> =>
  get<RoundDto[]>(baseUrl, `/rounds?limit=${limit}`, signal);

export const fetchRound = (
  baseUrl: string,
  roundId: bigint | string,
  signal?: AbortSignal,
): Promise<ApiResult<RoundDto>> =>
  get<RoundDto>(baseUrl, `/rounds/${roundId}`, signal);

export const fetchPlayer = (
  baseUrl: string,
  owner: string,
  signal?: AbortSignal,
): Promise<ApiResult<PlayerDto>> =>
  get<PlayerDto>(baseUrl, `/players/${owner}`, signal);

export const fetchLeaderboard = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<PlayerDto[]>> =>
  get<PlayerDto[]>(baseUrl, `/leaderboard?limit=${limit}`, signal);

export const fetchFeed = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<EventDto[]>> =>
  get<EventDto[]>(baseUrl, `/feed?limit=${limit}`, signal);

export const fetchStatus = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<StatusDto>> => get<StatusDto>(baseUrl, "/status", signal);

export const fetchHealth = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ ok: true }>> =>
  get<{ ok: true }>(baseUrl, "/healthz", signal);

export interface FaucetGrant {
  signature: string;
  /** hexUSDC minted, atomic units, decimal string. */
  amount: string;
}

/**
 * The faucet is rate limited per owner. A 429 is not a failure to report as
 * "offline": it carries the wait, so the Vault can count down.
 */
export type FaucetResult =
  | { ok: true; data: FaucetGrant }
  | { ok: false; retryAfterSeconds: number }
  | { ok: false; reason: string };

export async function requestFaucet(
  baseUrl: string,
  owner: string,
  signal?: AbortSignal,
): Promise<FaucetResult> {
  try {
    const response = await fetch(`${baseUrl}/faucet`, {
      method: "POST",
      signal: signal ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ owner }),
    });
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        retryAfterSeconds?: number;
      };
      return { ok: false, retryAfterSeconds: body.retryAfterSeconds ?? 3600 };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as FaucetGrant };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}
