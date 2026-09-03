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
 * Immediately withdrawable principal: the matched (PT ∧ ET) portion. Spending
 * entries on a position lowers it without touching PT, so it is min(PT, ET).
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
