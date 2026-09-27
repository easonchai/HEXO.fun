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
 *  "First draw: not yet scheduled" with no `LAUNCH_AT` configured. */
export function launchCountdownLabel(countdown: LaunchCountdown): string {
  if (!countdown.scheduled) return "First draw: not yet scheduled";
  if (countdown.remainingSeconds === null) return "First draw in —";
  return `First draw in ${dhmsParts(countdown.remainingSeconds).join(":")}`;
}
