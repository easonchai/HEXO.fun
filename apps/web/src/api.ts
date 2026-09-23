/**
 * Indexer REST client (spec §3.5). Ticket 07: the Indexer is the browser's
 * read model, the only path by which it learns about the protocol — a read
 * model may not be bypassed, unlike a cache, and the chain stays
 * authoritative behind it. Nothing here throws: a failed call comes back as
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
  admin: string;
  operator: string;
  pendingAdmin: string | null;
  mint: string;
  epochSeconds: string;
  epochAnchor: string;
  roundSeconds: string;
  /** Seconds before a Round's end that Positions close. */
  closeBuffer: string;
  minDeposit: string;
  /** Share of a settled round's pot credited to the House, in basis points. */
  houseCutBps: number;
  /** Base yield's APR on time-weighted Principal, in basis points (ADR 0011). */
  baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. */
  ticketsPerUsdc: number;
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
  /** Entries the House took from the pot at settlement; "0" until then. */
  houseCut: string;
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
  /** Requested but unpaid Principal, atomic units. "0" when nothing is pending. */
  pendingWithdraw: string;
  /** Epoch the pending amount was requested in; it pays out after that one ends. */
  pendingEpoch: string;
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

/**
 * `GET /players/:owner`: the Player row plus what `GET /state`'s embedded
 * `player` does not carry (ticket 10). The backend also sends `boughtToday`
 * and `grantedToday`; unmodeled here, since nothing in the web app reads them.
 */
export type PlayerExtrasDto = PlayerDto & {
  /** What `register` credited this owner in the epoch it last credited. */
  yieldLastEpoch: string;
  /** Every Base yield credit this owner has ever received. */
  yieldToDate: string;
  /** USDC still spendable in `buy_tickets` today, capped at Principal. */
  buyAllowanceLeft: string;
};

/** 404s with a human reason until the wallet has a Player (deposited once). */
export const fetchPlayer = (
  baseUrl: string,
  owner: string,
  signal?: AbortSignal,
): Promise<ApiResult<PlayerExtrasDto>> =>
  get<PlayerExtrasDto>(baseUrl, `/players/${owner}`, signal);

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
  /** When the crank plans to look again. It sleeps to a deadline, so a gap
   *  between ticks is only a stall once this has passed. */
  nextWakeAt: string | null;
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
  /** Irreversible once true (ops-and-envs ticket 08); false before the pool
   *  is indexed. See `shutdown.ts` for what the web does with this. */
  shutdown: boolean;
  /** Principal pulled out and not yet returned; null when the pool or the
   *  vault balance is not known yet. Not surfaced in this app's UI. */
  principalOut: string | null;
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

/** The caller's Position in `GET /state`'s tracked Round; see `StateDto.position`. */
export interface PositionDto {
  tiles: string;
  stakePerTile: string;
}

/**
 * Ticket 07: `GET /state`, the browser's one poll. `openRound` stays filtered
 * to Open/Requested; `round` is whichever Round the `round=` query asked
 * about, any status, so the browser can keep watching the same Round (and
 * `position` inside it) straight through settlement without a chain read of
 * its own.
 */
export interface StateDto {
  pool: PoolDto;
  currentEpoch: CurrentEpochDto;
  openRound: RoundSummaryDto | null;
  round: RoundDto | null;
  player: PlayerDto | null;
  position: PositionDto | null;
  status: StatusDto;
  /** Chain time as the backend last observed it, extrapolated to now (decimal, unix seconds). */
  chainTime: string;
  /**
   * Ticket 08: the backend's cached priority-fee estimate (production-
   * hardening ticket 04) over the pool's hot writable accounts, in
   * micro-lamports per compute unit. Untrusted the moment it arrives here —
   * `/state` is unauthenticated input — so nothing signs with it directly;
   * `read.ts`'s `poolFromDto` validates and caps it before the send helper
   * ever sees it.
   */
  priorityFeeMicroLamports: number;
}

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

/**
 * Ticket 07: the one poll every screen reads from (see `useStatePoll.ts`).
 * `round`, when given, names whichever Round the caller wants the full state
 * of, whatever its status — pass the last Round seen open, so the browser
 * keeps watching it straight through settlement.
 */
export const fetchState = (
  baseUrl: string,
  owner: string | undefined,
  round: string | undefined,
  signal?: AbortSignal,
): Promise<ApiResult<StateDto>> => {
  const params = new URLSearchParams();
  if (owner) params.set("owner", owner);
  if (round) params.set("round", round);
  const query = params.toString();
  return get<StateDto>(baseUrl, `/state${query ? `?${query}` : ""}`, signal);
};

export const fetchHealth = (
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ ok: true }>> =>
  get<{ ok: true }>(baseUrl, "/healthz", signal);

/** Ticket 09: the private-beta gate. `reason` is a short human sentence, not a code. */
export interface AccessDto {
  allowed: boolean;
  reason: string;
}

export const fetchAccess = (
  baseUrl: string,
  wallet: string,
  signal?: AbortSignal,
): Promise<ApiResult<AccessDto>> =>
  get<AccessDto>(baseUrl, `/access/${wallet}`, signal);

/**
 * `POST /access/redeem`. "no uses left" and "wallet already redeemed" are
 * both a 409, so telling them apart needs the backend's message text, not
 * just the status: this returns its own result shape (carrying `status`)
 * instead of the shared `ApiResult`, same as `FaucetResult` below.
 */
export type RedeemAccessResult =
  | { ok: true; data: AccessDto }
  | { ok: false; status: number | null; reason: string };

export async function redeemAccess(
  baseUrl: string,
  wallet: string,
  code: string,
  signature: string,
  referralCode?: string,
  signal?: AbortSignal,
): Promise<RedeemAccessResult> {
  try {
    const response = await fetch(`${baseUrl}/access/redeem`, {
      method: "POST",
      signal: signal ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ wallet, code, signature, ...(referralCode ? { referralCode } : {}) }),
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<AccessDto> & { message?: string })
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: body?.message ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, data: { allowed: body?.allowed ?? true, reason: body?.reason ?? "" } };
  } catch (error) {
    return {
      ok: false,
      status: null,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}

/** `POST /referrals/apply` (ticket 02): applies a `?ref=CODE` for a wallet
 *  already past the beta gate. `applied: false` is never an error and never
 *  shown to the user (spec.md "?ref= capture"): `ok: false` here only means
 *  the request itself failed to reach the server. */
export async function applyReferral(
  baseUrl: string,
  wallet: string,
  code: string,
  signature: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ applied: boolean; reason: string }>> {
  try {
    const response = await fetch(`${baseUrl}/referrals/apply`, {
      method: "POST",
      signal: signal ?? null,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ wallet, code, signature }),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: (await response.json()) as { applied: boolean; reason: string } };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}

/** One owned InviteCode, reduced to what the share-link list needs. */
export interface OwnedCodeDto {
  code: string;
  usesLeft: number;
}

/** One Referral row, wallet already masked server-side. */
export interface ReferralRowDto {
  wallet: string;
  qualified: boolean;
  /** Whole days left before qualifying; null while Principal has never
   *  crossed the $50 threshold (nothing counting down yet). */
  daysToQualify: number | null;
}

/** A referral rate tier (referral-page ticket 03): tier 0 means no rate yet;
 *  `maxCount` is null at the top tier (11+), which has no upper bound. */
export interface ReferralBandDto {
  tier: number;
  rateBps: number;
  minCount: number;
  maxCount: number | null;
}

/** `GET /referrals/:wallet` (ticket 11). */
export interface ReferralsDto {
  /** The wallet's own Referral code (referral-page ticket 01); null before
   *  its first deposit, since the indexer mints one on the first Deposited
   *  event. */
  referralCode: string | null;
  ownedCodes: OwnedCodeDto[];
  referrals: ReferralRowDto[];
  qualifiedCount: number;
  /** Current band (referral-page ticket 03). */
  band: ReferralBandDto;
  /** The next, higher band; null at the top band (11+). */
  nextBand: ReferralBandDto | null;
  bonusToday: string;
  bonusYesterday: string;
}

export const fetchReferrals = (
  baseUrl: string,
  wallet: string,
  signal?: AbortSignal,
): Promise<ApiResult<ReferralsDto>> => get<ReferralsDto>(baseUrl, `/referrals/${wallet}`, signal);

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
