/** Board + state-machine helpers mirroring the program's enums and tile encoding. */

export const TILE_COUNT = 36;

/** Parse "1,7,22" into a u64 tile bitmask (tile N = bit N). */
export function tilesToMask(text: string): bigint | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (!/^\d+$/.test(piece)) return null;
    const tile = Number(piece);
    if (tile < 0 || tile >= TILE_COUNT) return null;
    seen.add(tile);
  }
  let mask = 0n;
  for (const tile of seen) mask |= 1n << BigInt(tile);
  return mask;
}

/** Inverse of tilesToMask: bitmask -> sorted tile numbers. */
export function maskToTiles(mask: bigint): number[] {
  const tiles: number[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    if ((mask >> BigInt(tile)) & 1n) tiles.push(tile);
  }
  return tiles;
}

/** Number of set bits in the u64 mask. */
export function popcount(mask: bigint): number {
  let count = 0;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    if ((mask >> BigInt(tile)) & 1n) count += 1;
  }
  return count;
}

/** 6x6 coordinate label, e.g. tile 7 -> "row 2, col 2". */
export function tileGridLabel(tile: number): string {
  const row = Math.floor(tile / 6) + 1;
  const col = (tile % 6) + 1;
  return `row ${row}, col ${col}`;
}

/** Program state enums, decoded for display. */
export const EPOCH_STATUS = [
  "Open",
  "Snapshot committed",
  "Randomness requested",
  "Prize drawn",
  "Prize claimed",
  "Prize expired",
] as const;

export const JACKPOT_STATUS = [
  "None",
  "Committed",
  "Drawn",
  "Claimed",
  "Expired",
] as const;

export const ROUND_STATUS = [
  "Open",
  "Randomness requested",
  "Settled",
] as const;

export const REQUEST_STATUS = ["Pending", "Fulfilled"] as const;

export const REQUEST_KIND = ["round", "prize", "jackpot"] as const;

function lookup(table: readonly string[], value: number): string {
  return table[value] ?? `unknown (${value})`;
}

export const labelEpochStatus = (value: number): string =>
  lookup(EPOCH_STATUS, value);
export const labelJackpotStatus = (value: number): string =>
  lookup(JACKPOT_STATUS, value);
export const labelRoundStatus = (value: number): string =>
  lookup(ROUND_STATUS, value);
export const labelRequestStatus = (value: number): string =>
  lookup(REQUEST_STATUS, value);
export const labelRequestKind = (value: number): string =>
  lookup(REQUEST_KIND, value);

/** Bytes -> "0x…" for roots and hashes. */
export function hexFromBytes(bytes: ArrayLike<number>): string {
  let out = "0x";
  for (let i = 0; i < bytes.length; i += 1)
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

/** The five epoch windows, in enforced order. */
export interface EpochWindows {
  startsAt: bigint;
  entryCutoffAt: bigint;
  endsAt: bigint;
  prizeSnapshotAt: bigint;
  claimDeadline: bigint;
}

export type MilestoneState = "past" | "active" | "pending";

export interface Milestone {
  label: string;
  at: bigint;
  state: MilestoneState;
}

const MILESTONE_LABELS = [
  "Epoch started",
  "Entry cutoff",
  "Rounds end",
  "Prize snapshot",
  "Claim deadline",
] as const;

/** Timeline with non-colour state cues (labels carry the state, not just style). */
export function epochMilestones(
  epoch: EpochWindows,
  nowSeconds: bigint,
): Milestone[] {
  const windows = [
    epoch.startsAt,
    epoch.entryCutoffAt,
    epoch.endsAt,
    epoch.prizeSnapshotAt,
    epoch.claimDeadline,
  ];
  let activeSeen = false;
  return windows.map((at, index) => {
    let state: MilestoneState = "pending";
    if (nowSeconds >= at) state = "past";
    else if (!activeSeen) {
      state = "active";
      activeSeen = true;
    }
    return { label: MILESTONE_LABELS[index] ?? `window ${index}`, at, state };
  });
}
