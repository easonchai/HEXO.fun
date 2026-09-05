/** Activity-feed row mappers: indexed history and live program events → FeedRow. */
import type { EventRow } from "./api.js";
import { displayTile, type FeedRow } from "./engine.js";
import { formatAddress } from "./lib/money.js";
import type { LiveEvent } from "./useProgramEvents.js";

/** Atomic string (6dp) → compact decimal text without floats. */
export function atomicShort(text: string): string {
  const clean = text.replace(/[^0-9]/g, "") || "0";
  const padded = clean.padStart(7, "0");
  const whole = padded.slice(0, padded.length - 6).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function eventsToRows(
  rows: EventRow[],
  owner: string | undefined,
): FeedRow[] {
  const out: FeedRow[] = [];
  for (const row of rows) {
    const payload = row.payload ?? {};
    const ownerText = typeof payload.owner === "string" ? payload.owner : null;
    const who = ownerText
      ? ownerText === owner
        ? "you"
        : formatAddress(ownerText)
      : "pool";
    if (row.name === "PositionPurchased") {
      const tilesMask = BigInt(String(payload.tiles ?? "0"));
      let count = 0;
      for (let tile = 0; tile < 36; tile += 1)
        if ((tilesMask >> BigInt(tile)) & 1n) count += 1;
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who,
        action: `−${atomicShort(String(payload.total_stake ?? "0"))} ET`,
        tileLabel: `${count} tiles`,
      });
    } else if (row.name === "DepositRecorded") {
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who,
        action: `+${atomicShort(String(payload.amount ?? "0"))} USDC`,
        tileLabel: "deposit",
      });
    } else if (row.name === "WithdrawalRecorded") {
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who,
        action: `−${atomicShort(String(payload.amount ?? "0"))} USDC`,
        tileLabel: "withdraw",
      });
    } else if (row.name === "RoundSettled") {
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who: "pool",
        action: `tile ${displayTile(Number(payload.winning_tile ?? 0))}`,
        tileLabel: "settled",
      });
    }
  }
  return out;
}

export function liveEventToRow(
  event: LiveEvent,
  owner: string | undefined,
): FeedRow | null {
  const data = event.data ?? {};
  const ownerKey =
    typeof data.owner === "string"
      ? data.owner
      : typeof data.user === "string"
        ? data.user
        : null;
  const who = ownerKey
    ? ownerKey === owner
      ? "you"
      : formatAddress(ownerKey)
    : "pool";
  switch (event.name) {
    case "PositionPurchased": {
      const tilesMask = BigInt(String(data.tiles ?? "0"));
      let count = 0;
      for (let tile = 0; tile < 36; tile += 1)
        if ((tilesMask >> BigInt(tile)) & 1n) count += 1;
      return {
        key: event.key,
        who,
        action: `−${atomicShort(String(data.totalStake ?? data.total_stake ?? "0"))} ET`,
        tileLabel: `${count} tiles`,
      };
    }
    case "DepositRecorded":
      return {
        key: event.key,
        who,
        action: `+${atomicShort(String(data.amount ?? "0"))} USDC`,
        tileLabel: "deposit",
      };
    case "WithdrawalRecorded":
      return {
        key: event.key,
        who,
        action: `−${atomicShort(String(data.amount ?? "0"))} USDC`,
        tileLabel: "withdraw",
      };
    case "RoundSettled":
      return {
        key: event.key,
        who: "pool",
        action: `tile ${displayTile(Number(data.winningTile ?? data.winning_tile ?? 0))}`,
        tileLabel: "settled",
      };
    case "RoundRewardClaimed":
      return {
        key: event.key,
        who,
        action: `+${atomicShort(String(data.reward ?? "0"))} ET`,
        tileLabel: "reward",
      };
    default:
      return null;
  }
}

export function mergeFeed(
  live: FeedRow[],
  history: FeedRow[],
  owner: string | undefined,
): FeedRow[] {
  void owner;
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
