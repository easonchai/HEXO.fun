// Argument parsing for the admin CLI, split out of index.ts so a unit test
// can import it without index.ts's chain calls running on import. Same
// reason bootstrap.ts's params live in bootstrap/params.ts.
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

import { INVITE_CODE_MAX_USES } from "../api/invite-code";
import { houseCutBps, isoSeconds, wholeUsdc } from "../bootstrap/params";

export interface SetParamsInput {
  readonly epochSeconds?: number;
  /** Unix seconds, from an ISO 8601 flag value. */
  readonly epochAnchor?: number;
  readonly roundSeconds?: number;
  readonly closeBuffer?: number;
  readonly vrfTimeout?: number;
  readonly minDeposit?: bigint;
  readonly houseCutBps?: number;
  /** Atomic units, from a whole-USDC flag value. */
  readonly minJackpot?: bigint;
  readonly registrationWindow?: number;
  readonly payoutTimeout?: number;
  readonly baseRateBps?: number;
  readonly ticketsPerUsdc?: number;
  readonly bonusCapBps?: number;
}

/** `emergency-crank`'s default batch size when `--batch` is not given
 *  (ops-and-envs ticket 08, spec.md "emergency-crank [--batch 5]"). */
export const DEFAULT_EMERGENCY_CRANK_BATCH = 5;

export type AdminCommand =
  | { readonly kind: "pause" }
  | { readonly kind: "unpause" }
  | { readonly kind: "fund-jackpot"; readonly amount: bigint }
  /** Raw atomic hexUSDC, same units as fund-jackpot. */
  | { readonly kind: "fund-yield"; readonly amount: bigint }
  /** Admin path only (uncapped); the operator path is the referral job. */
  | { readonly kind: "grant-tickets"; readonly owner: PublicKey; readonly amount: bigint }
  | { readonly kind: "set-params"; readonly params: SetParamsInput }
  /** `amount` is USDC as typed, e.g. "250" or "12.5". Scaling to atomic
   *  units needs the mint's decimals, which only the chain knows. */
  | { readonly kind: "withdraw-principal"; readonly amount: string }
  | { readonly kind: "set-operator"; readonly key: PublicKey }
  | { readonly kind: "propose-admin"; readonly key: PublicKey }
  | { readonly kind: "accept-admin" }
  /** Never touches the chain: `create-invite` writes straight to Postgres,
   *  so `main()` handles it before a ChainService is even built. */
  | {
      readonly kind: "create-invite";
      readonly maxUses: number;
      readonly owner?: PublicKey;
      readonly count: number;
    }
  /** Read-only (ops-and-envs ticket 08): prints the same figure `/status`
   *  reports, and its inputs. */
  | { readonly kind: "principal-out" }
  /** Plain SPL transfer from the admin's own ATA into the principal vault;
   *  `amount` is USDC as typed, same shape as `withdraw-principal`. */
  | { readonly kind: "return-principal"; readonly amount: string }
  /** Irreversible; refused unless `confirm` matches the configured pool. */
  | { readonly kind: "shutdown"; readonly confirm: bigint }
  /** Permissionless: any signer may run this. */
  | { readonly kind: "emergency-crank"; readonly batch: number }
  | { readonly kind: "sweep-house" };

export const USAGE = [
  "usage: admin <command> [flags]",
  "  set-params [--epoch-seconds N] [--epoch-anchor ISO8601] [--round-seconds N] [--close-buffer N] [--vrf-timeout N] [--min-deposit N] [--house-cut-bps N] [--min-jackpot USDC] [--registration-window N] [--payout-timeout N] [--base-rate-bps N] [--tickets-per-usdc N] [--bonus-cap-bps N]",
  "  pause",
  "  unpause",
  "  fund-jackpot --amount N   (N is raw atomic hexUSDC, 6 decimals)",
  "  fund-yield --amount N   (N is raw atomic hexUSDC, 6 decimals)",
  "  grant-tickets --owner PUBKEY --amount N   (admin path, uncapped; N is a whole number of tickets)",
  "  withdraw-principal --amount USDC   (whole USDC, up to 6 decimal places)",
  "  set-operator --key PUBKEY",
  "  propose-admin --key PUBKEY",
  "  accept-admin",
  `  create-invite [--max-uses N] [--owner PUBKEY] [--count K]   (max-uses defaults to ${INVITE_CODE_MAX_USES})`,
  "  principal-out",
  "  return-principal --amount USDC   (whole USDC, up to 6 decimal places)",
  "  shutdown --confirm POOL_ID   (irreversible; POOL_ID must match the configured pool)",
  `  emergency-crank [--batch N]   (permissionless; N players per transaction, default ${DEFAULT_EMERGENCY_CRANK_BATCH})`,
  "  sweep-house",
].join("\n");

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

function nonNegativeInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${flag} must be a non-negative whole number, got "${raw}"`);
  }
  return value;
}

function positiveBigInt(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`--${flag} must be a positive whole number, got "${raw}"`);
  }
  return BigInt(raw);
}

function nonNegativeBigInt(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${flag} must be a non-negative whole number, got "${raw}"`);
  }
  return BigInt(raw);
}

/** `tickets_per_usdc` is a u16 and must be > 0 (a rate of zero would divide
 *  by nothing when pricing a purchase). */
function ticketsPerUsdc(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`--${flag} must be a whole number from 1 to 65535, got "${raw}"`);
  }
  return value;
}

function pubkey(flag: string, raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch (cause) {
    throw new Error(`--${flag} must be a base58 pubkey, got "${raw}"`, { cause });
  }
}

/**
 * USDC as the operator types it, kept as a string: `admin_withdraw` takes
 * atomic units, and the scale is the mint's decimals, which the parse cannot
 * reach. Six places is the ceiling any mint this program accepts allows.
 */
function usdcAmount(flag: string, raw: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(raw) || Number(raw) === 0) {
    throw new Error(
      `--${flag} must be a positive amount of USDC with up to 6 decimal places, got "${raw}"`,
    );
  }
  return raw;
}

/** Scales a `usdcAmount` string by the mint's decimals. */
export function atomicUsdc(amount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `--amount ${amount} has more decimal places than the mint's ${decimals}`,
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/**
 * `set_params` enforces `0 <= registration_window < epoch_seconds` against
 * the epoch length the same call leaves behind, so this runs in the parse
 * when both flags are given and again in index.ts against the pool's current
 * epoch when only the window is.
 */
export function checkRegistrationWindow(
  registrationWindow: number,
  epochSeconds: number,
): void {
  if (registrationWindow >= epochSeconds) {
    throw new Error(
      `--registration-window must be under the ${epochSeconds}s epoch, got ${registrationWindow}`,
    );
  }
}

/** No flags accepted; `pause`/`unpause`/`accept-admin` take none. */
function rejectExtra(rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"\n${USAGE}`);
  }
}

/** The one required flag of a single-flag command, as written. */
function oneFlag(command: string, flag: string, rest: readonly string[]): string {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { [flag]: { type: "string" } },
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }
  const value = values[flag];
  if (typeof value !== "string") {
    throw new Error(`${command} needs --${flag}\n${USAGE}`);
  }
  return value;
}

/** Takes argv without the node and script entries. */
export function parseAdminCommand(argv: readonly string[]): AdminCommand {
  const [command, ...rest] = argv;

  switch (command) {
    case "pause":
      rejectExtra(rest);
      return { kind: "pause" };

    case "unpause":
      rejectExtra(rest);
      return { kind: "unpause" };

    case "fund-jackpot":
      return {
        kind: "fund-jackpot",
        amount: positiveBigInt("amount", oneFlag(command, "amount", rest)),
      };

    case "fund-yield":
      return {
        kind: "fund-yield",
        amount: positiveBigInt("amount", oneFlag(command, "amount", rest)),
      };

    case "grant-tickets": {
      let values: { owner?: string; amount?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { owner: { type: "string" }, amount: { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      if (typeof values.owner !== "string") {
        throw new Error(`grant-tickets needs --owner\n${USAGE}`);
      }
      if (typeof values.amount !== "string") {
        throw new Error(`grant-tickets needs --amount\n${USAGE}`);
      }
      return {
        kind: "grant-tickets",
        owner: pubkey("owner", values.owner),
        amount: positiveBigInt("amount", values.amount),
      };
    }

    case "withdraw-principal":
      return {
        kind: "withdraw-principal",
        amount: usdcAmount("amount", oneFlag(command, "amount", rest)),
      };

    case "set-operator":
      return { kind: "set-operator", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "propose-admin":
      return { kind: "propose-admin", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "accept-admin":
      rejectExtra(rest);
      return { kind: "accept-admin" };

    case "set-params": {
      let values: {
        "epoch-seconds"?: string;
        "epoch-anchor"?: string;
        "round-seconds"?: string;
        "close-buffer"?: string;
        "vrf-timeout"?: string;
        "min-deposit"?: string;
        "house-cut-bps"?: string;
        "min-jackpot"?: string;
        "registration-window"?: string;
        "payout-timeout"?: string;
        "base-rate-bps"?: string;
        "tickets-per-usdc"?: string;
        "bonus-cap-bps"?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "epoch-seconds": { type: "string" },
            "epoch-anchor": { type: "string" },
            "round-seconds": { type: "string" },
            "close-buffer": { type: "string" },
            "vrf-timeout": { type: "string" },
            "min-deposit": { type: "string" },
            "house-cut-bps": { type: "string" },
            "min-jackpot": { type: "string" },
            "registration-window": { type: "string" },
            "payout-timeout": { type: "string" },
            "base-rate-bps": { type: "string" },
            "tickets-per-usdc": { type: "string" },
            "bonus-cap-bps": { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }

      const params: SetParamsInput = {
        ...(values["epoch-seconds"] !== undefined && {
          epochSeconds: positiveInt("epoch-seconds", values["epoch-seconds"]),
        }),
        ...(values["epoch-anchor"] !== undefined && {
          epochAnchor: isoSeconds("epoch-anchor", values["epoch-anchor"]),
        }),
        ...(values["round-seconds"] !== undefined && {
          roundSeconds: positiveInt("round-seconds", values["round-seconds"]),
        }),
        ...(values["close-buffer"] !== undefined && {
          closeBuffer: nonNegativeInt("close-buffer", values["close-buffer"]),
        }),
        ...(values["vrf-timeout"] !== undefined && {
          vrfTimeout: positiveInt("vrf-timeout", values["vrf-timeout"]),
        }),
        ...(values["min-deposit"] !== undefined && {
          minDeposit: nonNegativeBigInt("min-deposit", values["min-deposit"]),
        }),
        ...(values["house-cut-bps"] !== undefined && {
          houseCutBps: houseCutBps("house-cut-bps", values["house-cut-bps"]),
        }),
        ...(values["min-jackpot"] !== undefined && {
          minJackpot: wholeUsdc("min-jackpot", values["min-jackpot"]),
        }),
        ...(values["registration-window"] !== undefined && {
          registrationWindow: nonNegativeInt(
            "registration-window",
            values["registration-window"],
          ),
        }),
        ...(values["payout-timeout"] !== undefined && {
          payoutTimeout: positiveInt("payout-timeout", values["payout-timeout"]),
        }),
        ...(values["base-rate-bps"] !== undefined && {
          baseRateBps: houseCutBps("base-rate-bps", values["base-rate-bps"]),
        }),
        ...(values["tickets-per-usdc"] !== undefined && {
          ticketsPerUsdc: ticketsPerUsdc("tickets-per-usdc", values["tickets-per-usdc"]),
        }),
        ...(values["bonus-cap-bps"] !== undefined && {
          bonusCapBps: houseCutBps("bonus-cap-bps", values["bonus-cap-bps"]),
        }),
      };
      if (Object.keys(params).length === 0) {
        throw new Error(`set-params needs at least one flag\n${USAGE}`);
      }
      // The other half of this check needs the pool's epoch length, so it
      // waits for index.ts; this one costs nothing and fails before any env
      // or RPC access.
      if (params.registrationWindow !== undefined && params.epochSeconds !== undefined) {
        checkRegistrationWindow(params.registrationWindow, params.epochSeconds);
      }
      return { kind: "set-params", params };
    }

    case "create-invite": {
      let values: { "max-uses"?: string; owner?: string; count?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "max-uses": { type: "string" },
            owner: { type: "string" },
            count: { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      const maxUsesRaw = values["max-uses"];
      return {
        kind: "create-invite",
        // Invite codes are single use from now on (ticket 07): --max-uses
        // defaults to INVITE_CODE_MAX_USES rather than being required.
        maxUses: maxUsesRaw !== undefined ? positiveInt("max-uses", maxUsesRaw) : INVITE_CODE_MAX_USES,
        count: values.count !== undefined ? positiveInt("count", values.count) : 1,
        ...(values.owner !== undefined ? { owner: pubkey("owner", values.owner) } : {}),
      };
    }

    case "principal-out":
      rejectExtra(rest);
      return { kind: "principal-out" };

    case "return-principal":
      return {
        kind: "return-principal",
        amount: usdcAmount("amount", oneFlag(command, "amount", rest)),
      };

    case "shutdown":
      return {
        kind: "shutdown",
        confirm: nonNegativeBigInt("confirm", oneFlag(command, "confirm", rest)),
      };

    case "emergency-crank": {
      let values: { batch?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { batch: { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      return {
        kind: "emergency-crank",
        batch:
          values.batch !== undefined
            ? positiveInt("batch", values.batch)
            : DEFAULT_EMERGENCY_CRANK_BATCH,
      };
    }

    case "sweep-house":
      rejectExtra(rest);
      return { kind: "sweep-house" };

    default:
      throw new Error(USAGE);
  }
}
