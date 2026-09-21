// Argument parsing for the admin CLI, split out of index.ts so a unit test
// can import it without index.ts's chain calls running on import. Same
// reason bootstrap.ts's params live in bootstrap/params.ts.
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

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
}

export type AdminCommand =
  | { readonly kind: "pause" }
  | { readonly kind: "unpause" }
  | { readonly kind: "fund-jackpot"; readonly amount: bigint }
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
    };

export const USAGE = [
  "usage: admin <command> [flags]",
  "  set-params [--epoch-seconds N] [--epoch-anchor ISO8601] [--round-seconds N] [--close-buffer N] [--vrf-timeout N] [--min-deposit N] [--house-cut-bps N] [--min-jackpot USDC] [--registration-window N] [--payout-timeout N]",
  "  pause",
  "  unpause",
  "  fund-jackpot --amount N   (N is raw atomic hexUSDC, 6 decimals)",
  "  withdraw-principal --amount USDC   (whole USDC, up to 6 decimal places)",
  "  set-operator --key PUBKEY",
  "  propose-admin --key PUBKEY",
  "  accept-admin",
  "  create-invite --max-uses N [--owner PUBKEY] [--count K]",
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
      if (typeof maxUsesRaw !== "string") {
        throw new Error(`create-invite needs --max-uses\n${USAGE}`);
      }
      return {
        kind: "create-invite",
        maxUses: positiveInt("max-uses", maxUsesRaw),
        count: values.count !== undefined ? positiveInt("count", values.count) : 1,
        ...(values.owner !== undefined ? { owner: pubkey("owner", values.owner) } : {}),
      };
    }

    default:
      throw new Error(USAGE);
  }
}
