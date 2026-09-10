/**
 * Indexer REST client (spec §3.5). The API is a cache; chain stays
 * authoritative. Nothing here throws: a failed call comes back as
 * `{ ok: false, reason }` so a screen can show a banner instead of crashing.
 *
 * Every u64/u128/timestamp arrives as a decimal string (spec §3.2), so these
 * types say `string` and the UI converts with BigInt where it needs to.
 *
 * These types were checked against the landed backend (ticket 08:
 * `apps/backend/src/api/`), not just the spec. Four shapes differ from a plain
 * reading of §3.5, and the backend is right in each case: `/pool` names its
 * fields `currentEpoch` and `openRound` and sends the round as a summary,
 * `/epochs/current` nests progress under `drawing`, `/leaderboard` sends a
 * subset of the Player row, and `odds` is a percentage string, not a fraction.
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
  epochAnchor: string;
  roundSeconds: string;
  paused: boolean;
  currentEpochId: string;
  currentEpochEndsAt: string;
  previousEpochEndsAt: string;
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
  /** Null until the round settles. */
  winningTile: number | null;
  tileTotals: string[];
}

/** What `GET /pool` carries for the open round: no tile totals, no winner. */
export type RoundSummaryDto = Pick<
  RoundDto,
  "id" | "epochId" | "startsAt" | "endsAt" | "status" | "pot"
>;

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
  /** Share of the epoch's live weight as a percentage, two decimals: "12.34". */
  odds: string;
}

/** `GET /leaderboard` sends a subset of the Player row, not the whole thing. */
export type LeaderboardRowDto = Pick<
  PlayerDto,
  "owner" | "principal" | "entries" | "isHouse" | "liveWeight" | "odds"
>;

export interface EventDto {
  slot: string;
  signature: string;
  index: number;
  name: string;
  data: Record<string, unknown>;
  blockTime: string | null;
}

export interface OperatorStateDto {
  id: number;
  lastTickAt: string | null;
  lastAction: string | null;
  lastError: string | null;
  registeredCount: number | null;
  registeredTotal: number | null;
}

export interface StatusDto {
  /** Null until the operator has run one tick. */
  operator: OperatorStateDto | null;
  cursor: {
    lastSlot: string | null;
    lastSignature: string | null;
    /** Null means the indexer has never synced, which is not the same as 0. */
    ageSeconds: number | null;
  };
  rpcOk: boolean;
  slot: number | null;
  /** Simulated yield rate in basis points (500 = 5% APR). */
  aprBps: number;
}

export interface PoolSummaryDto {
  pool: PoolDto;
  currentEpoch: EpochDto | null;
  openRound: RoundSummaryDto | null;
}

/** Registration and draw progress for the epoch that just ended. */
export interface DrawingProgressDto {
  epochId: string;
  registeredCount: number;
  eligible: number;
  status: StatusValue;
}

export type CurrentEpochDto = EpochDto & {
  /** Null unless the previous epoch is Registering or Drawing. */
  drawing: DrawingProgressDto | null;
};

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
): Promise<ApiResult<LeaderboardRowDto[]>> =>
  get<LeaderboardRowDto[]>(baseUrl, `/leaderboard?limit=${limit}`, signal);

/**
 * With `owner`, only that wallet's rows: the backend matches both `owner` and
 * `winner` inside the event payload, so a JackpotPaid (which has no `owner`
 * field) still reaches the winner's own history.
 */
export const fetchFeed = (
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
  owner?: string,
): Promise<ApiResult<EventDto[]>> =>
  get<EventDto[]>(
    baseUrl,
    `/feed?limit=${limit}${owner ? `&owner=${owner}` : ""}`,
    signal,
  );

/** One key per requested owner, 0 rather than a missing key when they played none. */
export interface PositionCountsDto {
  counts: Record<string, number>;
}

/**
 * How many rounds each of `owners` has played, batched: the dashboard asks for
 * a whole table of winners at once. The backend caps the list at 25.
 */
export const fetchPositionCounts = (
  baseUrl: string,
  owners: readonly string[],
  signal?: AbortSignal,
): Promise<ApiResult<PositionCountsDto>> =>
  get<PositionCountsDto>(
    baseUrl,
    `/positions/counts?owners=${owners.join(",")}`,
    signal,
  );

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
  owner: string;
  tokenAccount: string;
  /** USDC minted, atomic units, decimal string. */
  amount: string;
  signature: string;
  /** Unix seconds the same wallet may ask again. */
  nextRequestAt: string;
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
