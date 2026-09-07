/**
 * Money-path helpers. Everything is bigint atomic units; decimals come from the
 * pool's accepted-mint decimals. No floats ever touch these code paths.
 */

/** Render atomic units as a decimal string with `decimals` places. */
export function formatAtomic(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  if (decimals === 0) {
    return negative ? `-${digits}` : digits;
  }
  if (digits.length <= decimals) {
    return `${negative ? "-" : ""}0.${digits.padStart(decimals, "0")}`;
  }
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Render atomic units truncated (never rounded) to two decimal places, for
 * display. `1999970000` @ 6dp -> "1999.97", never "1999.98". Inputs, and
 * anything the app writes into one, use `formatAtomic` at full precision
 * instead — truncating those would make the parsed value lossy.
 */
export function formatAtomic2(value: bigint, decimals: number): string {
  const full = formatAtomic(value, decimals);
  const negative = full.startsWith("-");
  const unsigned = negative ? full.slice(1) : full;
  const dot = unsigned.indexOf(".");
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const frac = dot === -1 ? "" : unsigned.slice(dot + 1);
  const twoPlaces = `${frac}00`.slice(0, 2);
  return `${negative ? "-" : ""}${whole}.${twoPlaces}`;
}

/**
 * Keep typed amount text to digits, one dot and at most `places` decimals.
 * "12.3456" -> "12.34", "1.2.3" -> "1.23", "abc" -> "".
 */
export function clampDecimals(text: string, places: number): string {
  const clean = text.replace(/[^0-9.]/g, "");
  const dot = clean.indexOf(".");
  if (dot === -1) return clean;
  const whole = clean.slice(0, dot);
  const frac = clean.slice(dot + 1).replace(/\./g, "").slice(0, places);
  return `${whole}.${frac}`;
}

/** Parse user-entered decimal text into atomic units. Null when invalid. */
export function parseAtomic(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const raw = text.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const dot = raw.indexOf(".");
  const whole = dot === -1 ? raw : raw.slice(0, dot);
  const frac = dot === -1 ? "" : raw.slice(dot + 1);
  // Reject precision the mint cannot represent: "1.0005" at 3 decimals is lossy.
  if (frac.length > decimals) return null;
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Render a compact label for an address (first4…last4). */
export function formatAddress(address: string): string {
  return address.length <= 12
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Principal the program will let you take out right now. `withdraw(x)` needs
 * both Principal and Entries of at least x, and buying a position spends
 * Entries without touching Principal, so the ceiling is min(principal, entries).
 */
export function withdrawable(principal: bigint, entries: bigint): bigint {
  return principal < entries ? principal : entries;
}

/** Preview of the board consequence: entries spent, balances after the buy. */
export function previewBuy(
  principal: bigint,
  entries: bigint,
  tileCount: number,
  stakePerTile: bigint,
): {
  spend: bigint;
  entriesAfter: bigint;
  withdrawableAfter: bigint;
  affordable: boolean;
} {
  const spend = BigInt(tileCount) * stakePerTile;
  const entriesAfter = entries - spend;
  return {
    spend,
    entriesAfter,
    withdrawableAfter: withdrawable(principal, entriesAfter),
    affordable: entriesAfter >= 0n,
  };
}

/**
 * A year of simulated yield on `amount` at `aprBps` basis points, in atomic
 * units. Same integer math as the operator's `yieldAmount` over a full year.
 */
export function estimatedYield(amount: bigint, aprBps: number): bigint {
  return (amount * BigInt(aprBps)) / 10_000n;
}

/** `current + step`, held at `cap` when one is given (the Vault's quick pills). */
export function addCapped(current: bigint, step: bigint, cap: bigint | null): bigint {
  const next = current + step;
  return cap !== null && next > cap ? cap : next;
}

/** Preview a withdrawal in atomic units, including matched capacity before/after. */
export function previewWithdraw(
  principal: bigint,
  entries: bigint,
  amount: bigint,
): {
  principalAfter: bigint;
  entriesAfter: bigint;
  withdrawableBefore: bigint;
  withdrawableAfter: bigint;
} {
  return {
    principalAfter: principal - amount,
    entriesAfter: entries - amount,
    withdrawableBefore: withdrawable(principal, entries),
    withdrawableAfter: withdrawable(principal - amount, entries - amount),
  };
}
