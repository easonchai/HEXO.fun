/**
 * Backend health as the UI shows it, derived from `GET /status`. This is the
 * one place the "is the operator alive" judgment call gets made, so both the
 * header pill and the arena's "operator paused" state read the same `stale`
 * flag instead of re-deriving it.
 *
 * Ticket 08's notes for this exact consumer: `cursor.ageSeconds` is `null`
 * when the indexer has never synced, not the same as `0`, and null should
 * read as "starting", not "fresh". The indexer backs every API read, so a
 * stalled cursor makes that data stale even if the operator is still
 * ticking; both signals gate the green state.
 */
import type { StatusDto } from "./api.js";

export interface StatusSummary {
  tone: "ok" | "warn";
  /** Short text for the header pill. */
  label: string;
  /** Full text for the pill's tooltip. */
  detail: string;
  /** True when the operator or the indexer looks stopped or unproven. */
  stale: boolean;
}

/** Ticket 11: "green when the last tick is under 10 s old and no error". */
const FRESH_SECONDS = 10;
/**
 * The indexer stamps its cursor when it ingests an event and after each 60 s
 * catch-up sweep, so on an empty Round the age climbs for most of the
 * countdown. Measured against the sweep, plus a margin for a slow RPC, the
 * age means "the sweep is running", not "an event just landed".
 */
const CURSOR_FRESH_SECONDS = 90;

const warn = (label: string, detail: string): StatusSummary => ({
  tone: "warn",
  label,
  detail,
  stale: true,
});

/** `nowMs` is injected so this stays pure and testable. */
export function summarizeStatus(
  status: StatusDto | null,
  nowMs: number,
): StatusSummary {
  if (!status) return warn("OFFLINE", "backend unreachable");

  const error = status.operator?.lastError ?? null;
  const lastTickAt = status.operator?.lastTickAt ?? null;
  if (!lastTickAt) {
    return warn(error ?? "STARTING", error ?? "operator has not ticked yet");
  }

  const tickAge = (nowMs - Date.parse(lastTickAt)) / 1000;
  const tickFresh =
    Number.isFinite(tickAge) && tickAge >= 0 && tickAge < FRESH_SECONDS;

  const cursorAge = status.cursor.ageSeconds;
  const cursorFresh = cursorAge !== null && cursorAge < CURSOR_FRESH_SECONDS;

  if (tickFresh && cursorFresh && !error) {
    return {
      tone: "ok",
      label: "LIVE",
      detail: `tick ${Math.round(tickAge)}s ago`,
      stale: false,
    };
  }
  if (error) return warn(error, error);
  if (!tickFresh) {
    return warn(
      "STALLED",
      `operator stalled (last tick ${Math.round(tickAge)}s ago)`,
    );
  }
  return warn(
    "SYNCING",
    cursorAge === null
      ? "indexer has not synced yet"
      : `indexer lag ${cursorAge}s`,
  );
}
