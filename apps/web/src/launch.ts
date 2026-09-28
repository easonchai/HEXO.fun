/**
 * Ticket 05 (deposit-only launch week): pure derivation for the "first draw
 * in" countdown Home, Vault and Dashboard show while `/state`'s `currentEpoch`
 * is null. No React, no chain I/O, so it is unit-testable on its own — see
 * `engine.ts`'s `dhmsParts` for the same split on the regular draw clock.
 */
import { dhmsParts } from "./engine.js";

export interface LaunchCountdown {
  /** Whether `LAUNCH_AT` is configured at all. */
  readonly scheduled: boolean;
  /** Seconds until launch, floored at 0; null when unscheduled or the chain
   *  clock (`now`) is not known yet. */
  readonly remainingSeconds: bigint | null;
}

/** `launchAt` is `/state`'s ISO string (null once an Epoch exists, or when
 *  `LAUNCH_AT` was never configured); `now` is the chain clock, seconds. */
export function launchCountdown(
  launchAt: string | null,
  now: bigint | null,
): LaunchCountdown {
  if (launchAt === null) return { scheduled: false, remainingSeconds: null };
  if (now === null) return { scheduled: true, remainingSeconds: null };
  const launchSeconds = BigInt(Math.floor(Date.parse(launchAt) / 1000));
  const remaining = launchSeconds - now;
  return { scheduled: true, remainingSeconds: remaining > 0n ? remaining : 0n };
}

/** "First draw in DD:HH:MM:SS", "First draw in —" while `now` is unknown, or
 *  "Coming soon" with no `LAUNCH_AT` configured. */
export function launchCountdownLabel(countdown: LaunchCountdown): string {
  if (!countdown.scheduled) return "Coming soon";
  if (countdown.remainingSeconds === null) return "First draw in —";
  return `First draw in ${dhmsParts(countdown.remainingSeconds).join(":")}`;
}

export type PrizeCardState = "launch" | "paused" | "live";

/**
 * Ticket 02 (feature-gates): shared precedence for the Home and Dashboard
 * prize cards. The jackpot gate wins outright, even with a live epoch and
 * `jackpotPaused` false, and lands on the same "launch" branch the
 * deposit-only launch week already renders. Gate unset falls back to
 * today's rule: no epoch yet means launching, otherwise the chain's own
 * `jackpotPaused` switch decides.
 */
export function prizeCardState(
  gated: boolean,
  hasEpoch: boolean,
  jackpotPaused: boolean,
): PrizeCardState {
  if (gated || !hasEpoch) return "launch";
  return jackpotPaused ? "paused" : "live";
}
