/**
 * Phone stake bar view model. Pure derivation so the bar's numbers and copy
 * cannot drift from the control panel's own inputs and cost computation
 * (`stake * tiles`, the same formula `ControlPanel` uses for "PER ROUND" /
 * "TICKETS IN").
 *
 * Phase copy for the closed state mirrors the deploy button in
 * `ControlPanel.tsx`, but those strings are inline JSX literals, not
 * exports. "SETTLING…" is reused verbatim (the button shows it for both the
 * locked and settling Round phases). Nothing in `ControlPanel` covers the
 * awaiting phase — its deploy button falls back to "DEPLOY"/"SELECT TILES"
 * because `openRound` is null once a round settles, forfeits or voids, so
 * "AWAITING…" below is new copy. Flag this for reconciliation: either give
 * the deploy button real awaiting copy too, or accept the two surfaces
 * differ here.
 */
import { formatAtomic, formatAtomic2, parseAtomic } from "../lib/money.js";
import type { Phase, PositionLike } from "../engine.js";

export type StakeBarState = "editing" | "placed" | "closed";

export interface StakeBarModel {
  state: StakeBarState;
  /** "Entries per Tile", formatted. */
  entriesPerTile: string;
  /** Tiles selected (editing/closed) or tiles in the placed Position, formatted. */
  tilesSelected: string;
  /** Total Entries in, formatted. Matches the panel's own cost computation. */
  entriesIn: string;
  /** Button label: the phase copy in the closed state, otherwise a call to action. */
  label: string;
}

const CLOSED_LABEL: Record<"locked" | "settling" | "awaiting", string> = {
  locked: "SETTLING…",
  settling: "SETTLING…",
  awaiting: "AWAITING…",
};

/** Popcount of a Position's tile bitmask — the same recipe App.tsx uses for deployedTotal. */
function tileCountOf(tiles: bigint): number {
  return tiles.toString(2).replace(/[^1]/g, "").length;
}

/** Derives the stake bar's model from the panel's own inputs and the Round phase. */
export function stakeBarModel(
  stakeText: string,
  selected: number[],
  position: PositionLike | null,
  phase: Phase,
  decimals: number,
): StakeBarModel {
  const fmt = (value: bigint): string => formatAtomic2(value, decimals);
  const fmtCount = (count: number): string => formatAtomic(BigInt(count), 0);

  const editingNumbers = (): Omit<StakeBarModel, "state" | "label"> => {
    const stake = parseAtomic(stakeText, decimals) ?? 0n;
    const tiles = Math.max(selected.length, 0);
    return {
      entriesPerTile: fmt(stake),
      tilesSelected: fmtCount(tiles),
      entriesIn: fmt(stake * BigInt(tiles)),
    };
  };

  const placedNumbers = (
    active: PositionLike,
  ): Omit<StakeBarModel, "state" | "label"> => {
    const tiles = tileCountOf(active.tiles);
    return {
      entriesPerTile: fmt(active.stakePerTile),
      tilesSelected: fmtCount(tiles),
      entriesIn: fmt(active.stakePerTile * BigInt(tiles)),
    };
  };

  if (phase === "locked" || phase === "settling" || phase === "awaiting") {
    return {
      state: "closed",
      ...(position ? placedNumbers(position) : editingNumbers()),
      label: CLOSED_LABEL[phase],
    };
  }

  if (position) {
    return { state: "placed", ...placedNumbers(position), label: "TOP UP" };
  }

  return { state: "editing", ...editingNumbers(), label: "DEPLOY" };
}
