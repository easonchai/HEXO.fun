// Ticket 10: the price `ChainService.send` attaches via
// `ComputeBudgetProgram.setComputeUnitPrice`, so operator transactions land
// during congestion without overpaying the rest of the time. Production-
// hardening ticket 04 adds `heliusPriorityFeeEstimate`, which `ChainService`
// now prefers: a percentile estimate over the transaction's own writable
// accounts, rather than `getRecentPrioritizationFees`'s floor.
import type { PublicKey } from "@solana/web3.js";

/** The slice of a `Connection` `heliusPriorityFeeEstimate` needs: web3.js's
 *  own private JSON-RPC transport, the same one `indexer.service.ts`'s
 *  `getProgramAccountsV2` walk reaches into, since Helius's estimator is a
 *  JSON-RPC method with no typed `Connection` method. */
export interface RpcRequester {
  _rpcRequest(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { code?: number; message: string } }>;
}

/**
 * Helius `getPriorityFeeEstimate` at the `Medium` priority level, scoped to
 * `writable` (research/report.md "Landing a transaction is a local
 * auction"). `undefined` on any failure — a non-Helius endpoint answering
 * "method not found", a network error, a timeout, or a malformed response —
 * so the caller falls back to `p75PriorityFeeMicroLamports`; this never
 * throws, the same contract the old `getRecentPrioritizationFees` read had.
 */
export async function heliusPriorityFeeEstimate(
  connection: RpcRequester,
  writable: readonly PublicKey[],
  maxMicroLamports: number,
): Promise<number | undefined> {
  try {
    const response = await connection._rpcRequest("getPriorityFeeEstimate", [
      {
        accountKeys: writable.map((pubkey) => pubkey.toBase58()),
        options: { priorityLevel: "Medium" },
      },
    ]);
    if (response.error) return undefined;
    const estimate = (response.result as { priorityFeeEstimate?: unknown } | undefined)
      ?.priorityFeeEstimate;
    if (typeof estimate !== "number" || !Number.isFinite(estimate)) return undefined;
    return Math.min(Math.round(estimate), maxMicroLamports);
  } catch {
    return undefined;
  }
}

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
