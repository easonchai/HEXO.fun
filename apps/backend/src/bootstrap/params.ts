// The pool parameters bootstrap passes to `create_pool`, and the two CLI
// flags that override them. Split out of bootstrap.ts so a unit test can
// import it without the script's chain calls running on import.
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

export interface PoolParams {
  /** Pool admin. Absent falls back to `ADMIN_ADDRESS`, then to the signer. */
  readonly admin?: PublicKey;
  /** Pool operator. Absent falls back to the signer. */
  readonly operator?: PublicKey;
  /** An existing token account for the accepted mint to record as the
   * Treasury (CONTEXT.md: the Admin multisig's ATA on mainnet). Absent has
   * bootstrap seed a signer-owned account, which it refuses to do when the
   * mint is not under the signer's authority. */
  readonly treasury?: PublicKey;
  /** Same as `treasury`, for the Buyback reserve. */
  readonly buybackReserve?: PublicKey;
  readonly epochSeconds: number;
  /** Unix seconds. Fixes the phase of the `anchor + k * epochSeconds` grid. */
  readonly epochAnchor: number;
  readonly roundSeconds: number;
  readonly closeBuffer: number;
  readonly vrfTimeout: number;
  readonly minDeposit: bigint;
  /** Basis points of every settled round pot credited to the House, 0..=10_000. */
  readonly houseCutBps: number;
  /** Atomic units. An epoch closing with less than this in the jackpot vault
   * rolls over instead of paying out dust. */
  readonly minJackpot: bigint;
  /** Seconds past an epoch's end before `close_registration` is allowed, so
   * late registrants are never drawn past. 0 <= this < epochSeconds. */
  readonly registrationWindow: number;
  /** Seconds a Drawn epoch waits for its payout before it may roll over
   * unpaid. */
  readonly payoutTimeout: number;
  /** Base yield's APR on time-weighted Principal, in basis points. Env
   *  override BASE_RATE_BPS. */
  readonly baseRateBps: number;
  /** Tickets credited per USDC spent in `buy_tickets`. Env override
   *  TICKETS_PER_USDC. */
  readonly ticketsPerUsdc: number;
  /** Share of `total_principal`, in basis points, an operator
   * `grant_tickets` call may credit pool-wide per epoch. Env override
   * BONUS_CAP_BPS. */
  readonly bonusCapBps: number;
}

/**
 * A Sunday 16:00 UTC is 00:00 Monday in MYT, the top of an hour and the start
 * of a week, so one anchor serves the hourly, daily and weekly grids.
 */
export function nextSundayAnchor(now: Date): number {
  const anchor = new Date(now);
  anchor.setUTCHours(16, 0, 0, 0);
  // getUTCDay() is 0 on Sunday, so this walks forward to this week's Sunday
  // and stays put when today already is one.
  anchor.setUTCDate(anchor.getUTCDate() + ((7 - anchor.getUTCDay()) % 7));
  // Today's 16:00 has already gone, so take next week's.
  if (anchor.getTime() < now.getTime()) {
    anchor.setUTCDate(anchor.getUTCDate() + 7);
  }
  return Math.floor(anchor.getTime() / 1000);
}

/**
 * A numeric env override with a fallback, shared by BASE_RATE_BPS,
 * TICKETS_PER_USDC and BONUS_CAP_BPS (ADR 0011): a bad value fails bootstrap
 * immediately instead of silently keeping whatever was typed. Unset or empty
 * takes the fallback. Pure, like `env.ts`'s `solWarn`: the caller reads
 * `process.env` and hands the raw value in, so this is testable without
 * touching the environment.
 */
export function envInt(label: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative whole number, got "${raw}"`);
  }
  return value;
}

/** spec.md §7. */
export const DEFAULT_POOL_PARAMS: PoolParams = {
  epochSeconds: 86_400,
  epochAnchor: nextSundayAnchor(new Date()),
  roundSeconds: 90,
  closeBuffer: 5,
  vrfTimeout: 120,
  minDeposit: 1_000_000n, // 1 hexUSDC at 6 decimals
  houseCutBps: 600, // 6%, the rate PRD-V2 §5.4 asks for
  minJackpot: 1_000_000n, // 1 hexUSDC at 6 decimals
  registrationWindow: 600, // 10 minutes for the crank to register everyone
  payoutTimeout: 86_400, // a day before an unpayable winner rolls over
  // ~5% APY with daily compounding.
  baseRateBps: envInt("BASE_RATE_BPS", process.env.BASE_RATE_BPS, 488),
  ticketsPerUsdc: envInt("TICKETS_PER_USDC", process.env.TICKETS_PER_USDC, 10),
  // 5% of total_principal per epoch.
  bonusCapBps: envInt("BONUS_CAP_BPS", process.env.BONUS_CAP_BPS, 500),
};

export const USAGE =
  "usage: bootstrap [--epoch-seconds N] [--round-seconds N] [--epoch-anchor ISO8601] [--house-cut-bps N] [--min-jackpot USDC] [--registration-window N] [--payout-timeout N] [--admin PUBKEY] [--operator PUBKEY] [--treasury TOKEN_ACCOUNT] [--buyback-reserve TOKEN_ACCOUNT]";

/** The accepted mint is 6 decimals on every cluster we run on (bootstrap.ts
 * rejects any other), so whole USDC scales by a constant. */
const USDC_DECIMALS = 1_000_000n;

/** `--min-jackpot` is whole USDC, because dust is what the floor exists to
 * stop and nobody wants to count zeros on the command line. */
export function wholeUsdc(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${flag} must be a whole number of USDC, got "${raw}"`);
  }
  return BigInt(raw) * USDC_DECIMALS;
}

function pubkey(flag: string, raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch (cause) {
    throw new Error(`--${flag} must be a base58 pubkey, got "${raw}"`, { cause });
  }
}

/** `min` is 0 for the one flag create_pool lets be zero, the registration
 *  window; every other duration has to be positive. */
function seconds(flag: string, raw: string, min = 1): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    const bound = min === 0 ? "non-negative" : "positive";
    throw new Error(
      `--${flag} must be a ${bound} whole number of seconds, got "${raw}"`,
    );
  }
  return value;
}

/** create_pool and set_params both cap the House cut at 10_000 bps (100%). */
export function houseCutBps(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(
      `--${flag} must be a whole number from 0 to 10000, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Unix seconds from an ISO 8601 timestamp. The program only checks that the
 * anchor is greater than zero, so a typo has to fail here instead.
 */
export function isoSeconds(flag: string, raw: string): number {
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `--${flag} must be an ISO 8601 timestamp after 1970, got "${raw}"`,
    );
  }
  return Math.floor(ms / 1000);
}

/** Takes argv without the node and script entries. */
export function parsePoolParams(argv: readonly string[]): PoolParams {
  let values: {
    "epoch-seconds"?: string;
    "round-seconds"?: string;
    "epoch-anchor"?: string;
    "house-cut-bps"?: string;
    "min-jackpot"?: string;
    "registration-window"?: string;
    "payout-timeout"?: string;
    admin?: string;
    operator?: string;
    treasury?: string;
    "buyback-reserve"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "epoch-seconds": { type: "string" },
        "round-seconds": { type: "string" },
        "epoch-anchor": { type: "string" },
        "house-cut-bps": { type: "string" },
        "min-jackpot": { type: "string" },
        "registration-window": { type: "string" },
        "payout-timeout": { type: "string" },
        admin: { type: "string" },
        operator: { type: "string" },
        treasury: { type: "string" },
        "buyback-reserve": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }

  const epochSeconds = values["epoch-seconds"];
  const roundSeconds = values["round-seconds"];
  const epochAnchor = values["epoch-anchor"];
  const houseCut = values["house-cut-bps"];
  const params: PoolParams = {
    ...DEFAULT_POOL_PARAMS,
    ...(epochSeconds === undefined
      ? {}
      : { epochSeconds: seconds("epoch-seconds", epochSeconds) }),
    ...(roundSeconds === undefined
      ? {}
      : { roundSeconds: seconds("round-seconds", roundSeconds) }),
    ...(epochAnchor === undefined
      ? {}
      : { epochAnchor: isoSeconds("epoch-anchor", epochAnchor) }),
    ...(houseCut === undefined
      ? {}
      : { houseCutBps: houseCutBps("house-cut-bps", houseCut) }),
    ...(values["min-jackpot"] === undefined
      ? {}
      : { minJackpot: wholeUsdc("min-jackpot", values["min-jackpot"]) }),
    ...(values["registration-window"] === undefined
      ? {}
      : {
          registrationWindow: seconds(
            "registration-window",
            values["registration-window"],
            0,
          ),
        }),
    ...(values["payout-timeout"] === undefined
      ? {}
      : { payoutTimeout: seconds("payout-timeout", values["payout-timeout"]) }),
    ...(values.admin === undefined
      ? {}
      : { admin: pubkey("admin", values.admin) }),
    ...(values.operator === undefined
      ? {}
      : { operator: pubkey("operator", values.operator) }),
    ...(values.treasury === undefined
      ? {}
      : { treasury: pubkey("treasury", values.treasury) }),
    ...(values["buyback-reserve"] === undefined
      ? {}
      : {
          buybackReserve: pubkey("buyback-reserve", values["buyback-reserve"]),
        }),
  };

  // create_pool requires close_buffer < round_seconds, so a too-fast demo
  // pool fails here with a readable message instead of InvalidParameter
  // after the mint and both token accounts have already been created.
  if (params.closeBuffer >= params.roundSeconds) {
    throw new Error(
      `--round-seconds must be greater than the ${params.closeBuffer}s close buffer`,
    );
  }
  // Same rule, same reason: create_pool requires registration_window <
  // epoch_seconds, and failing here costs nothing.
  if (params.registrationWindow >= params.epochSeconds) {
    throw new Error(
      `--epoch-seconds must be greater than the ${params.registrationWindow}s registration window`,
    );
  }
  return params;
}
