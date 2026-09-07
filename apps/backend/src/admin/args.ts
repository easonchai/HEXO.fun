// Argument parsing for the admin CLI, split out of index.ts so a unit test
// can import it without index.ts's chain calls running on import. Same
// reason bootstrap.ts's params live in bootstrap/params.ts.
import { parseArgs } from "node:util";

export interface SetParamsInput {
  readonly epochSeconds?: number;
  readonly roundSeconds?: number;
  readonly closeBuffer?: number;
  readonly vrfTimeout?: number;
  readonly minDeposit?: bigint;
}

export type AdminCommand =
  | { readonly kind: "pause" }
  | { readonly kind: "unpause" }
  | { readonly kind: "fund-jackpot"; readonly amount: bigint }
  | { readonly kind: "set-params"; readonly params: SetParamsInput };

export const USAGE = [
  "usage: admin <command> [flags]",
  "  set-params [--epoch-seconds N] [--round-seconds N] [--close-buffer N] [--vrf-timeout N] [--min-deposit N]",
  "  pause",
  "  unpause",
  "  fund-jackpot --amount N   (N is raw atomic hexUSDC, 6 decimals)",
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

/** No flags accepted; `pause`/`unpause` take none. */
function rejectExtra(rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"\n${USAGE}`);
  }
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

    case "fund-jackpot": {
      let values: { amount?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { amount: { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      if (values.amount === undefined) {
        throw new Error(`fund-jackpot needs --amount\n${USAGE}`);
      }
      return { kind: "fund-jackpot", amount: positiveBigInt("amount", values.amount) };
    }

    case "set-params": {
      let values: {
        "epoch-seconds"?: string;
        "round-seconds"?: string;
        "close-buffer"?: string;
        "vrf-timeout"?: string;
        "min-deposit"?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "epoch-seconds": { type: "string" },
            "round-seconds": { type: "string" },
            "close-buffer": { type: "string" },
            "vrf-timeout": { type: "string" },
            "min-deposit": { type: "string" },
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
      };
      if (Object.keys(params).length === 0) {
        throw new Error(`set-params needs at least one flag\n${USAGE}`);
      }
      return { kind: "set-params", params };
    }

    default:
      throw new Error(USAGE);
  }
}
