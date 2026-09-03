/**
 * Pure round-state derivation mirroring the program's enums. No React, no
 * chain I/O — everything here is unit-testable.
 */

export const ROUND_OPEN = 0;
export const ROUND_REQUESTED = 1;
export const ROUND_SETTLED = 2;

export type Phase =
  | /** no round exists yet */ "idle"
  /** buys open: countdown to the close */
  | "mine"
  /** closed (or draw requested): waiting for the settle */
  | "settling"
  /** settled and revealed; waiting for the next round to be created */
  | "awaiting";

export interface RoundLike {
  epochId: bigint;
  id: bigint;
  startsAt: bigint;
  endsAt: bigint;
  status: number;
  winningTile: number;
  bonusEntries: bigint;
  totalStake: bigint;
  tileStakes: bigint[];
}

export interface PositionLike {
  roundId: bigint;
  tiles: bigint;
  stakePerTile: bigint;
  rewardClaimed: boolean;
}

/** Identity for a round; round ids restart in each epoch. */
export const roundKey = (epochId: bigint, roundId: bigint): string =>
  `${epochId}:${roundId}`;

/** Highest (epoch, round) pair (the live one), null if none. */
export function currentRound(rounds: RoundLike[]): RoundLike | null {
  if (rounds.length === 0) return null;
  return rounds.reduce((latest, round) =>
    round.epochId > latest.epochId ||
    (round.epochId === latest.epochId && round.id > latest.id)
      ? round
      : latest,
  );
}

/** Most recently settled round by (epochId, roundId), for reveal triggers. */
export function latestSettled(rounds: RoundLike[]): RoundLike | null {
  const settled = rounds.filter((round) => round.status === ROUND_SETTLED);
  if (settled.length === 0) return null;
  return settled.reduce((latest, round) =>
    round.epochId > latest.epochId ||
    (round.epochId === latest.epochId && round.id > latest.id)
      ? round
      : latest,
  );
}

/** Protocol buys stop `buffer` seconds before the round's ends_at. */
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

export const covers = (mask: bigint, tile: number): boolean =>
  ((mask >> BigInt(tile)) & 1n) === 1n;

/** Expected ET reward: bonus * stake / staked-on-winning-tile (floor division). */
export function expectedReward(
  round: RoundLike,
  position: PositionLike,
): bigint {
  if (!covers(position.tiles, round.winningTile)) return 0n;
  const winningTotal = round.tileStakes[round.winningTile] ?? 0n;
  if (winningTotal === 0n) return 0n;
  return (round.bonusEntries * position.stakePerTile) / winningTotal;
}

/** Seconds until buys close, clamped at zero. */
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

export interface FeedRow {
  key: string;
  /** Short address label; "you" when it is the connected wallet. */
  who: string;
  /** Orange gain column, e.g. entry spend or "+reward". */
  action: string;
  tileLabel: string;
}
