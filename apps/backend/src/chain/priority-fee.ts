// Ticket 10: the price `ChainService.send` attaches via
// `ComputeBudgetProgram.setComputeUnitPrice`, so operator transactions land
// during congestion without overpaying the rest of the time.

/**
 * The 75th percentile of the non-zero `getRecentPrioritizationFees` samples,
 * capped at `maxMicroLamports`. A zero sample means "no one paid to
 * prioritize that slot", not a real price floor, so it is dropped before the
 * percentile is taken; an empty or all-zero sample set answers 0 rather than
 * guessing a price.
 */
export function p75PriorityFeeMicroLamports(
  samples: readonly number[],
  maxMicroLamports: number,
): number {
  const nonZero = samples.filter((fee) => fee > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return 0;
  const index = Math.min(nonZero.length - 1, Math.ceil(0.75 * nonZero.length) - 1);
  // SAFETY: `nonZero.length > 0` (checked above) and `index` is clamped to
  // `[0, nonZero.length - 1]`, so this is always in bounds.
  const p75 = nonZero[index] as number;
  return Math.min(p75, maxMicroLamports);
}
