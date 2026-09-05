/**
 * Pure round-state derivation mirroring the program's enums. No React, no
 * chain I/O — everything here is unit-testable.
 */

export const ROUND_OPEN = 0;
export const ROUND_REQUESTED = 1;
export const ROUND_SETTLED = 2;
export const ROUND_FORFEITED = 3;
export const ROUND_VOIDED = 4;

export type Phase =
  | /** no round exists yet */ "idle"
  /** positions open: countdown to the close */
  | "mine"
  /** closed (or randomness requested): waiting for the settle */
  | "settling"
  /** settled and revealed; waiting for the next round to open */
  | "awaiting";

export interface RoundLike {
  roundId: bigint;
  epochId: bigint;
  startsAt: bigint;
  endsAt: bigint;
  status: number;
  winningTile: number;
  pot: bigint;
  tileTotals: bigint[];
}

export interface PositionLike {
  tiles: bigint;
  stakePerTile: bigint;
}

/** Identity for a round; round ids are unique per pool. */
export const roundKey = (roundId: bigint): string => roundId.toString();

/** Positions stop `buffer` seconds before the round's ends_at. */
export function buyClosesAt(round: RoundLike, bufferSeconds: bigint): bigint {
  const close = round.endsAt - bufferSeconds;
  return close > round.startsAt ? close : round.startsAt;
}

export function phaseFor(
  round: RoundLike | null,
  now: bigint,
  bufferSeconds: bigint,
): Phase {
  if (!round) return "idle";
  if (round.status === ROUND_OPEN)
    return now < buyClosesAt(round, bufferSeconds) ? "mine" : "settling";
  if (round.status === ROUND_REQUESTED) return "settling";
  return "awaiting";
}

/** True once the round has a winning tile the program will pay against. */
export const isRevealed = (round: RoundLike): boolean =>
  round.status === ROUND_SETTLED || round.status === ROUND_FORFEITED;

export const covers = (mask: bigint, tile: number): boolean =>
  ((mask >> BigInt(tile)) & 1n) === 1n;

/** Round reward in Entries: pot × stake / staked-on-winning-tile, floored. */
export function expectedReward(
  round: RoundLike,
  position: PositionLike,
): bigint {
  if (round.status !== ROUND_SETTLED) return 0n;
  if (!covers(position.tiles, round.winningTile)) return 0n;
  const winningTotal = round.tileTotals[round.winningTile] ?? 0n;
  if (winningTotal === 0n) return 0n;
  return (round.pot * position.stakePerTile) / winningTotal;
}

/** Seconds until positions close, clamped at zero. */
export function secondsLeft(
  round: RoundLike,
  bufferSeconds: bigint,
  now: bigint,
): bigint {
  const left = buyClosesAt(round, bufferSeconds) - now;
  return left > 0n ? left : 0n;
}

/** Display number 1..36 for a protocol tile index 0..35. */
export const displayTile = (tile: number): number => tile + 1;

/** MM:SS for the Syncopate timer. */
export function timerText(seconds: bigint): string {
  const total = Number(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(Math.min(59, total % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * HH:MM for a duration longer than a round: epoch countdowns and the
 * Vault's "unlocks in" note. Floors to the minute; negative (already past)
 * clamps to 00:00 rather than showing a sign.
 */
export function hmText(seconds: bigint): string {
  const total = seconds > 0n ? seconds : 0n;
  const hh = total / 3600n;
  const mm = (total % 3600n) / 60n;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

export interface FeedRow {
  key: string;
  /** Short address label; "you" when it is the connected wallet. */
  who: string;
  /** Orange gain column, e.g. Entries staked or "+reward". */
  action: string;
  tileLabel: string;
}
