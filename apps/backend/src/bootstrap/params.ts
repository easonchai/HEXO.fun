// The pool parameters bootstrap passes to `create_pool`, and the two CLI
// flags that override them. Split out of bootstrap.ts so a unit test can
// import it without the script's chain calls running on import.
import { parseArgs } from "node:util";

export interface PoolParams {
  readonly epochSeconds: number;
  /** Unix seconds. Fixes the phase of the `anchor + k * epochSeconds` grid. */
  readonly epochAnchor: number;
  readonly roundSeconds: number;
  readonly closeBuffer: number;
  readonly vrfTimeout: number;
  readonly minDeposit: bigint;
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

/** spec.md §7. */
export const DEFAULT_POOL_PARAMS: PoolParams = {
  epochSeconds: 86_400,
  epochAnchor: nextSundayAnchor(new Date()),
  roundSeconds: 60,
  closeBuffer: 5,
  vrfTimeout: 120,
  minDeposit: 1_000_000n, // 1 hexUSDC at 6 decimals
};

export const USAGE =
  "usage: bootstrap [--epoch-seconds N] [--round-seconds N] [--epoch-anchor ISO8601]";

function seconds(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `--${flag} must be a positive whole number of seconds, got "${raw}"`,
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
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "epoch-seconds": { type: "string" },
        "round-seconds": { type: "string" },
        "epoch-anchor": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }

  const epochSeconds = values["epoch-seconds"];
  const roundSeconds = values["round-seconds"];
  const epochAnchor = values["epoch-anchor"];
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
