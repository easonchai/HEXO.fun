// spec.md §3.1. Vars with a listed default value fall back to it; the rest
// have none and fail the boot if missing — all of them at once, not one at a
// time, so a fresh checkout tells you everything it needs in one error.
import { Logger } from "@nestjs/common";

import { DEFAULT_REFERRAL_QUALIFY_SECONDS } from "../api/referral";

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "RPC_URL",
  "OPERATOR_KEYPAIR",
  "ACCEPTED_MINT",
  "CORS_ORIGIN",
] as const;

// The program is mid-rewrite under this ID (see ticket 05). PROGRAM_ID isn't
// in spec's "no default" column, so an unset value falls back to it rather
// than failing boot.
export const DEFAULT_PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";

/** SOL the operator is warned about falling below, in `/status` and `/healthz`. */
export const DEFAULT_OPERATOR_SOL_WARN = 0.5;

/** Ceiling on the priority fee `ChainService.send` attaches (ticket 10):
 *  `setComputeUnitPrice`'s microlamports-per-CU price, capped so a spike in
 *  `getRecentPrioritizationFees` samples cannot run the operator's fee up
 *  without a bound. */
export const DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS = 50_000;

/** Per-call ceiling every chain read and send is bounded by (production-
 *  hardening ticket 03): the RPC that accepts the connection and then says
 *  nothing would otherwise hold the operator's tick, or an HTTP request,
 *  open with no bound. */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * The indexer's unpaginated `getProgramAccounts` walk (the fallback on an
 * RPC without `getProgramAccountsV2`) is bounded by `RPC_TIMEOUT_MS` times
 * this, not by `RPC_TIMEOUT_MS` itself (pre-mainnet review): that ceiling
 * is sized for one page of a thousand accounts, and one call answering
 * every account the program owns needs proportionally more. Not its own
 * env var: one knob for "how slow is this RPC allowed to be" is enough, and
 * this keeps the two in step when it is turned.
 */
export const FULL_WALK_RPC_TIMEOUT_MULTIPLIER = 6;

/** `GET /alerts`' `OPERATOR_STALE` threshold (production-hardening ticket
 *  05): seconds since the operator's last tick before it counts as stuck. */
export const DEFAULT_ALERT_TICK_STALE_S = 300;

/** `GET /alerts`' `INDEXER_STALE` threshold: seconds since the indexer
 *  cursor last advanced before it counts as stuck. */
export const DEFAULT_ALERT_INDEXER_STALE_S = 600;

export interface HexVaultEnv {
  DATABASE_URL: string;
  RPC_URL: string;
  /** Optional second RPC (production-hardening ticket 03): a call that times
   *  out, or errors with a 5xx or a 429, on `RPC_URL` is retried once here.
   *  Absent means a failure just propagates, same as before this ticket. */
  RPC_FALLBACK_URL?: string;
  /** Per-call timeout, in ms, every chain read and send is bounded by. */
  RPC_TIMEOUT_MS: number;
  PROGRAM_ID: string;
  POOL_ID: string;
  /** The hot crank key. The admin's key is never in this env. */
  OPERATOR_KEYPAIR: string;
  /** Pool admin, base58 pubkey. Read for CLI targeting only; absent means
   * the locally loaded keypair is treated as the admin too. */
  ADMIN_ADDRESS?: string;
  /** The mint the pool takes deposits in: the test mint on devnet, real
   *  USDC on mainnet. Named HEXUSDC_MINT before the mainnet work. */
  ACCEPTED_MINT: string;
  /** SOL below which `/status` flags the operator as running out of fees.
   *  Parsed here rather than at the reader, so a typo fails the boot instead
   *  of turning into a NaN comparison that is false forever. */
  OPERATOR_SOL_WARN: number;
  /** Cap, in microlamports per compute unit, on the priority fee
   *  `ChainService.send` attaches to operator transactions. */
  PRIORITY_FEE_MAX_MICROLAMPORTS: number;
  FAUCET_AMOUNT: string;
  FAUCET_INTERVAL_SECONDS: string;
  /** Seconds a referral's Principal must stay above the qualify threshold
   *  before the daily bonus job (ticket 08) pays it. Shortened on devnet to
   *  see a referral qualify sooner. */
  REFERRAL_QUALIFY_SECONDS: number;
  /** `GET /alerts`' `OPERATOR_STALE` threshold, in seconds. */
  ALERT_TICK_STALE_S: number;
  /** `GET /alerts`' `INDEXER_STALE` threshold, in seconds. */
  ALERT_INDEXER_STALE_S: number;
  CORS_ORIGIN: string;
  PORT: string;
  /** Sparring player secret, base58. Absent switches the Sparring player off. */
  SPARRING_KEYPAIR?: string;
  /** Shared secret for `POST /access/invites`, sent as `x-admin-key`. Absent
   *  switches the route off (404). At least 32 characters when set. */
  INVITE_ADMIN_KEY?: string;
}

/**
 * A SOL threshold, as a number. Unset (or set to the empty string, which is
 * how a compose file spells "not configured") takes the default; anything
 * that is not a finite amount of SOL fails the boot, because the alternative
 * is a NaN that silently reports the operator's balance as fine forever.
 */
function solWarn(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_OPERATOR_SOL_WARN;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `OPERATOR_SOL_WARN must be a non-negative number of SOL, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default cap, anything
 * else must be a non-negative whole number of microlamports.
 */
function priorityFeeMax(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `PRIORITY_FEE_MAX_MICROLAMPORTS must be a non-negative whole number of microlamports, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default timeout,
 * anything else must be a positive whole number of milliseconds.
 */
function rpcTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_RPC_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `RPC_TIMEOUT_MS must be a positive whole number of milliseconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes referral.ts's own default,
 * anything else must be a non-negative whole number of seconds.
 */
function referralQualifySeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_REFERRAL_QUALIFY_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `REFERRAL_QUALIFY_SECONDS must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/**
 * Same shape as `solWarn`: unset or empty takes the default, anything else
 * must be a non-negative whole number of seconds.
 */
function alertTickStaleSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_ALERT_TICK_STALE_S;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `ALERT_TICK_STALE_S must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/** Same shape as `alertTickStaleSeconds`. */
function alertIndexerStaleSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_ALERT_INDEXER_STALE_S;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `ALERT_INDEXER_STALE_S must be a non-negative whole number of seconds, got "${String(raw)}"`,
    );
  }
  return value;
}

/** @nestjs/config `validate` hook: runs once at boot, on the raw process.env. */
export function validateEnv(env: Record<string, unknown>): HexVaultEnv {
  if (!env.ACCEPTED_MINT && env.HEXUSDC_MINT) {
    new Logger("env").warn("HEXUSDC_MINT is deprecated; rename it to ACCEPTED_MINT");
  }
  const acceptedMint = env.ACCEPTED_MINT ?? env.HEXUSDC_MINT;
  const missing = REQUIRED_KEYS.filter((key) =>
    key === "ACCEPTED_MINT" ? !acceptedMint : !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  if (env.INVITE_ADMIN_KEY && String(env.INVITE_ADMIN_KEY).length < 32) {
    throw new Error("INVITE_ADMIN_KEY must be at least 32 characters (try `openssl rand -hex 32`)");
  }
  return {
    DATABASE_URL: String(env.DATABASE_URL),
    RPC_URL: String(env.RPC_URL),
    RPC_TIMEOUT_MS: rpcTimeoutMs(env.RPC_TIMEOUT_MS),
    PROGRAM_ID: String(env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID),
    POOL_ID: String(env.POOL_ID ?? "1"),
    OPERATOR_KEYPAIR: String(env.OPERATOR_KEYPAIR),
    ACCEPTED_MINT: String(acceptedMint),
    OPERATOR_SOL_WARN: solWarn(env.OPERATOR_SOL_WARN),
    PRIORITY_FEE_MAX_MICROLAMPORTS: priorityFeeMax(env.PRIORITY_FEE_MAX_MICROLAMPORTS),
    FAUCET_AMOUNT: String(env.FAUCET_AMOUNT ?? "1000000000"),
    FAUCET_INTERVAL_SECONDS: String(env.FAUCET_INTERVAL_SECONDS ?? "3600"),
    REFERRAL_QUALIFY_SECONDS: referralQualifySeconds(env.REFERRAL_QUALIFY_SECONDS),
    ALERT_TICK_STALE_S: alertTickStaleSeconds(env.ALERT_TICK_STALE_S),
    ALERT_INDEXER_STALE_S: alertIndexerStaleSeconds(env.ALERT_INDEXER_STALE_S),
    CORS_ORIGIN: String(env.CORS_ORIGIN),
    PORT: String(env.PORT ?? "8080"),
    // Spread rather than assigned: under `exactOptionalPropertyTypes` an
    // optional key cannot be set to `undefined`, and "absent" is the switch.
    ...(env.RPC_FALLBACK_URL ? { RPC_FALLBACK_URL: String(env.RPC_FALLBACK_URL) } : {}),
    ...(env.ADMIN_ADDRESS ? { ADMIN_ADDRESS: String(env.ADMIN_ADDRESS) } : {}),
    ...(env.SPARRING_KEYPAIR
      ? { SPARRING_KEYPAIR: String(env.SPARRING_KEYPAIR) }
      : {}),
    ...(env.INVITE_ADMIN_KEY ? { INVITE_ADMIN_KEY: String(env.INVITE_ADMIN_KEY) } : {}),
  };
}
