// The pool parameters bootstrap passes to `create_pool`, and the two CLI
// flags that override them. Split out of bootstrap.ts so a unit test can
// import it without the script's chain calls running on import.
import { parseArgs } from "node:util";

export interface PoolParams {
  readonly epochSeconds: number;
  readonly roundSeconds: number;
  readonly closeBuffer: number;
  readonly vrfTimeout: number;
  readonly minDeposit: bigint;
}

/** spec.md §7. */
export const DEFAULT_POOL_PARAMS: PoolParams = {
  epochSeconds: 86_400,
  roundSeconds: 60,
  closeBuffer: 5,
  vrfTimeout: 120,
  minDeposit: 1_000_000n, // 1 hexUSDC at 6 decimals
};

export const USAGE = "usage: bootstrap [--epoch-seconds N] [--round-seconds N]";

function seconds(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `--${flag} must be a positive whole number of seconds, got "${raw}"`,
    );
  }
  return value;
}

/** Takes argv without the node and script entries. */
export function parsePoolParams(argv: readonly string[]): PoolParams {
  let values: { "epoch-seconds"?: string; "round-seconds"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "epoch-seconds": { type: "string" },
        "round-seconds": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }

  const epochSeconds = values["epoch-seconds"];
  const roundSeconds = values["round-seconds"];
  const params: PoolParams = {
    ...DEFAULT_POOL_PARAMS,
    ...(epochSeconds === undefined
      ? {}
      : { epochSeconds: seconds("epoch-seconds", epochSeconds) }),
    ...(roundSeconds === undefined
      ? {}
      : { roundSeconds: seconds("round-seconds", roundSeconds) }),
  };

  // create_pool requires close_buffer < round_seconds, so a too-fast demo
  // pool fails here with a readable message instead of InvalidParameter
  // after the mint and both token accounts have already been created.
  if (params.closeBuffer >= params.roundSeconds) {
    throw new Error(
      `--round-seconds must be greater than the ${params.closeBuffer}s close buffer`,
    );
  }
  return params;
}
