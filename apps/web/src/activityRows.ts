/** Activity-feed row mappers: indexed history and live program events → FeedRow. */
import type { EventDto } from "./api.js";
import { eventKey } from "./chain.js";
import { displayTile, type FeedRow } from "./engine.js";
import { formatAddress, formatAtomic2 } from "./lib/money.js";
import { popcount } from "./lib/protocol.js";
import type { LiveEvent } from "./useProgramEvents.js";

/** Atomic string (6dp) → truncated two-decimal text without floats. */
export function atomicShort(text: string): string {
  const clean = text.replace(/[^0-9]/g, "") || "0";
  return formatAtomic2(BigInt(clean), 6);
}

/** Program fields arrive snake_case from the API and camelCase from a log. */
const field = (data: Record<string, unknown>, ...names: string[]): string => {
  for (const name of names) {
    const value = data[name];
    if (value !== undefined && value !== null) return String(value);
  }
  return "0";
};

/**
 * The API sends addresses as base58 strings; a decoded log hands back a
 * PublicKey object. Both reduce to the same base58 text.
 */
const addressOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  return null;
};

const whoOf = (value: unknown, owner: string | undefined): string => {
  const key = addressOf(value);
  if (!key) return "pool";
  return key === owner ? "You" : formatAddress(key);
};

/** One mapper for both sources: they differ only in how a row is keyed. */
function toRow(
  key: string,
  name: string,
  data: Record<string, unknown>,
  owner: string | undefined,
): FeedRow | null {
  const who = whoOf(data.owner, owner);
  switch (eventKey(name)) {
    case "deposited":
      return {
        key,
        who,
        action: `+${atomicShort(field(data, "amount"))} USDC`,
        tileLabel: "deposit",
      };
    case "withdrawn":
      return {
        key,
        who,
        action: `−${atomicShort(field(data, "amount"))} USDC`,
        tileLabel: "withdraw",
      };
    case "positionBought": {
      const tiles = popcount(BigInt(field(data, "tiles")));
      return {
        key,
        who,
        action: `−${atomicShort(field(data, "total"))} Tickets`,
        tileLabel: `${tiles} tiles`,
      };
    }
    case "positionSettled": {
      const reward = field(data, "reward");
      if (reward === "0") return null;
      return {
        key,
        who,
        action: `+${atomicShort(reward)} Tickets`,
        tileLabel: "round reward",
        roundId: field(data, "roundId", "round_id"),
      };
    }
    case "roundSettled":
      return {
        key,
        who: "pool",
        action: `tile ${displayTile(Number(field(data, "winningTile", "winning_tile")))}`,
        tileLabel: field(data, "forfeited") === "true" ? "no winner" : "settled",
        roundId: field(data, "roundId", "round_id"),
      };
    case "registered":
      return { key, who, action: "registered", tileLabel: "weekly draw" };
    case "jackpotPaid":
      return {
        key,
        who: whoOf(data.winner, owner),
        action: `+${atomicShort(field(data, "amount"))} USDC`,
        tileLabel: "prize",
      };
    // GET /feed sends this one, so without a case here the row count the API
    // returns and the row count the feed shows drift apart.
    case "epochRolledOver":
      return {
        key,
        who: "pool",
        action: `${atomicShort(field(data, "jackpotAmount", "jackpot_amount"))} USDC stays in the jackpot`,
        tileLabel: "rollover",
      };
    default:
      return null;
  }
}

export function eventsToRows(
  rows: EventDto[],
  owner: string | undefined,
): FeedRow[] {
  const out: FeedRow[] = [];
  for (const row of rows) {
    const mapped = toRow(
      `${row.slot}-${row.signature}-${row.index}`,
      row.name,
      row.data ?? {},
      owner,
    );
    if (mapped) out.push(mapped);
  }
  return out;
}

export const liveEventToRow = (
  event: LiveEvent,
  owner: string | undefined,
): FeedRow | null => toRow(event.key, event.name, event.data ?? {}, owner);

/** Where a row's Round stands relative to the reveal choreography (ticket 05). */
export type RevealHoldState = "pending" | "firing" | "landed" | "none";

/**
 * Pure hold predicate: whether a feed row should be visible right now. Only
 * a row carrying a `roundId` — RoundSettled, or a rewarded PositionSettled —
 * is ever held; every other row (PositionBought included) is always visible.
 * A held row stays hidden through "pending" (reveal not fired yet) and
 * "firing" (fired, before the 900 ms land), and shows at "landed" or "none"
 * (no reveal pending for its Round at all).
 */
export function isRowVisible(row: FeedRow, hold: RevealHoldState): boolean {
  if (row.roundId === undefined) return true;
  return hold === "landed" || hold === "none";
}

export function mergeFeed(live: FeedRow[], history: FeedRow[]): FeedRow[] {
  const seen = new Set<string>();
  const out: FeedRow[] = [];
  for (const row of [...live, ...history]) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}
