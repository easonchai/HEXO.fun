// Pure translation between the chain's shapes and Postgres rows: Anchor
// decoded accounts to Prisma inputs, `Program data:` log lines to event rows,
// and the `register` weight rule from spec §2.3 that the operator asks for.
//
// Nothing here touches the network or Prisma, so every rule is unit-testable
// without a validator.
import { BN, EventParser } from "@anchor-lang/core";
import type { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";

/** `Epoch::status` and `Round::status`, mirroring constants.rs. */
export const EPOCH_STATUS = {
  OPEN: 0,
  REGISTERING: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
} as const;

export const ROUND_STATUS = {
  OPEN: 0,
  REQUESTED: 1,
  SETTLED: 2,
  FORFEITED: 3,
  VOIDED: 4,
} as const;

/** Round statuses in which `winning_tile` holds a drawn value. */
const TILE_DECIDED: number[] = [ROUND_STATUS.SETTLED, ROUND_STATUS.FORFEITED];

/** A round the operator may still act on: no other round can be created. */
export const LIVE_ROUND_STATUSES: number[] = [ROUND_STATUS.OPEN, ROUND_STATUS.REQUESTED];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// The Anchor coder hands back BN, PublicKey and plain arrays. Postgres jsonb
// takes none of them, and a u64 does not survive a JSON number, so every
// integer becomes a decimal string and every key its base58.
export function jsonify(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonify);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonify(item)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

export interface DecodedEvent {
  name: string;
  data: JsonValue;
}

/**
 * Every event this program emitted in one transaction, in emission order.
 *
 * `EventParser` tracks the CPI stack, so an event a called program emitted
 * with a colliding discriminator is not mistaken for one of ours.
 */
export function decodeEventLogs(parser: EventParser, logs: string[]): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  try {
    for (const event of parser.parseLogs(logs)) {
      events.push({ name: declaredName(event.name), data: jsonify(event.data) });
    }
  } catch (cause) {
    throw new Error(`cannot parse program logs: ${logs[0] ?? "<empty>"}`, { cause });
  }
  return events;
}

/**
 * Anchor's `Program` camelCases the IDL before building its coder, so the
 * coder calls the event `roundSettled`. Rows keep the name the program
 * declares and spec §2.6 lists, `RoundSettled`, because that is what the API
 * and the frontend feed filter on. `decode.test.ts` checks every event name
 * against the IDL, so a casing rule that stops round-tripping fails there.
 */
const declaredName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

const big = (value: BN): bigint => BigInt(value.toString());
const isUnset = (key: PublicKey): boolean => key.equals(PublicKey.default);

// The coder throws on a wrong discriminator or a layout that does not fit the
// bytes, so these interfaces describe an already-validated account rather than
// asserting a shape onto unchecked input. Only the fields Postgres stores are
// listed; the rest of each account is decoded and dropped.
export interface DecodedPool {
  poolId: BN;
  authority: PublicKey;
  acceptedMint: PublicKey;
  epochSeconds: BN;
  epochAnchor: BN;
  roundSeconds: BN;
  houseCutBps: number;
  paused: boolean;
  currentEpochId: BN;
  currentEpochEndsAt: BN;
  previousEpochEndsAt: BN;
  totalPrincipal: BN;
  carryPot: BN;
}

export interface DecodedEpoch {
  epochId: BN;
  startsAt: BN;
  endsAt: BN;
  status: number;
  registeredWeight: BN;
  registeredCount: number;
  jackpotAmount: BN;
  target: BN;
  winner: PublicKey;
}

export interface DecodedRound {
  roundId: BN;
  epochId: BN;
  startsAt: BN;
  endsAt: BN;
  status: number;
  tileTotals: BN[];
  pot: BN;
  houseCut: BN;
  winningTile: number;
}

export interface DecodedPlayer {
  owner: PublicKey;
  principal: BN;
  entries: BN;
  weightAcc: BN;
  lastUpdate: BN;
  epochId: BN;
  frozenWeight: BN;
  frozenEpoch: BN;
  regEpoch: BN;
  regStart: BN;
  regEnd: BN;
  isHouse: boolean;
}

export interface DecodedPosition {
  owner: PublicKey;
  round: PublicKey;
  tiles: BN;
  stakePerTile: BN;
}

export function poolRow(
  address: PublicKey,
  pool: DecodedPool,
  slot: bigint,
): Prisma.PoolCreateInput {
  return {
    address: address.toBase58(),
    poolId: big(pool.poolId),
    authority: pool.authority.toBase58(),
    mint: pool.acceptedMint.toBase58(),
    epochSeconds: big(pool.epochSeconds),
    epochAnchor: big(pool.epochAnchor),
    roundSeconds: big(pool.roundSeconds),
    houseCutBps: pool.houseCutBps,
    paused: pool.paused,
    currentEpochId: big(pool.currentEpochId),
    currentEpochEndsAt: big(pool.currentEpochEndsAt),
    previousEpochEndsAt: big(pool.previousEpochEndsAt),
    totalPrincipal: big(pool.totalPrincipal),
    carryPot: big(pool.carryPot),
    updatedSlot: slot,
  };
}

export function epochRow(epoch: DecodedEpoch): Prisma.EpochCreateInput {
  return {
    id: big(epoch.epochId),
    startsAt: big(epoch.startsAt),
    endsAt: big(epoch.endsAt),
    status: epoch.status,
    registeredWeight: epoch.registeredWeight.toString(),
    registeredCount: epoch.registeredCount,
    jackpotAmount: big(epoch.jackpotAmount),
    target: epoch.target.toString(),
    // Written only by `payout`; the default key means "no winner yet".
    winner: isUnset(epoch.winner) ? null : epoch.winner.toBase58(),
  };
}

export function roundRow(round: DecodedRound): Prisma.RoundCreateInput {
  return {
    id: big(round.roundId),
    epochId: big(round.epochId),
    startsAt: big(round.startsAt),
    endsAt: big(round.endsAt),
    status: round.status,
    pot: big(round.pot),
    houseCut: big(round.houseCut),
    // `winning_tile` is 0 on an unsettled round, which is also a real tile.
    winningTile: TILE_DECIDED.includes(round.status) ? round.winningTile : null,
    tileTotals: round.tileTotals.map((total) => total.toString()),
  };
}

export function playerRow(player: DecodedPlayer): Prisma.PlayerCreateInput {
  return {
    owner: player.owner.toBase58(),
    principal: big(player.principal),
    entries: big(player.entries),
    weightAcc: player.weightAcc.toString(),
    lastUpdate: big(player.lastUpdate),
    epochId: big(player.epochId),
    frozenWeight: player.frozenWeight.toString(),
    frozenEpoch: big(player.frozenEpoch),
    regEpoch: big(player.regEpoch),
    regStart: player.regStart.toString(),
    regEnd: player.regEnd.toString(),
    isHouse: player.isHouse,
  };
}

export function positionRow(
  address: PublicKey,
  position: DecodedPosition,
  roundId: bigint,
): Prisma.PositionCreateInput {
  return {
    address: address.toBase58(),
    owner: position.owner.toBase58(),
    roundId,
    tiles: big(position.tiles),
    stakePerTile: big(position.stakePerTile),
  };
}

/** Decimal(40, 0) columns are integers; `toFixed` never goes exponential. */
const fromDecimal = (value: { toFixed(places: number): string }): bigint =>
  BigInt(value.toFixed(0));

export interface RegistrationPlayer {
  epochId: bigint;
  weightAcc: { toFixed(places: number): string };
  entries: bigint;
  lastUpdate: bigint;
  principal: bigint;
  frozenWeight: { toFixed(places: number): string };
  frozenEpoch: bigint;
}

export interface RegistrationEpoch {
  id: bigint;
  startsAt: bigint;
  endsAt: bigint;
}

/**
 * The weight `register` would record for this player in this epoch, spec §2.3.
 * The operator skips a player whose weight is 0, because the program returns
 * Ok without registering and the transaction would be wasted.
 *
 * Clamped at 0: a negative span can only come from a row that drifted from the
 * chain, and a negative weight would make an ineligible player look eligible.
 */
export function registrationWeight(
  player: RegistrationPlayer,
  epoch: RegistrationEpoch,
): bigint {
  if (player.epochId === epoch.id) {
    const span = epoch.endsAt - player.lastUpdate;
    return max0(fromDecimal(player.weightAcc) + player.entries * max0(span));
  }
  if (player.epochId > epoch.id) {
    return player.frozenEpoch === epoch.id ? max0(fromDecimal(player.frozenWeight)) : 0n;
  }
  return max0(player.principal * max0(epoch.endsAt - epoch.startsAt));
}

const max0 = (value: bigint): bigint => (value > 0n ? value : 0n);
