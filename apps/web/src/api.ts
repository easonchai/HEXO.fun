/** Indexer REST client. The API is a cache; chain stays authoritative. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

const DEFAULT_API_URL = "http://localhost:8081";

export const apiBaseUrl = (env: Record<string, string | undefined>): string =>
  env.VITE_API_URL?.trim() || DEFAULT_API_URL;

async function get(
  path: string,
  signal?: AbortSignal | null,
): Promise<ApiResult<unknown>> {
  try {
    const response = await fetch(path, {
      signal: signal ?? null,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "indexer offline",
    };
  }
}

/** Snapshot export shape written by `hexvault snapshot export`. */
export interface SnapshotFile {
  epochId?: string;
  poolId?: string;
  root?: string;
  totalEntryWeight?: string | number;
  prizeAmount?: string | number;
  weight?: string | number;
  owner?: string;
  proof?: unknown[];
}

export async function fetchHealth(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ApiResult<unknown>> {
  return get(`${baseUrl}/healthz`, signal);
}

export async function fetchSnapshot(
  baseUrl: string,
  pool: string,
  epochId: bigint,
  signal?: AbortSignal,
): Promise<ApiResult<unknown>> {
  return get(`${baseUrl}/snapshot/${pool}/${epochId.toString()}`, signal);
}

/** Row of GET /events — the activity feed's history source. */
export interface EventRow {
  slot: string;
  signature: string;
  eventIndex: number;
  name: string;
  pool: string;
  payload: Record<string, unknown>;
  blockTime: string | null;
}

export async function fetchEvents(
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<EventRow[]>> {
  const result = await get(`${baseUrl}/events?limit=${limit}`, signal);
  if (!result.ok) return result;
  const events = (result.data as { events?: EventRow[] }).events;
  return Array.isArray(events)
    ? { ok: true, data: events }
    : { ok: false, reason: "unexpected /events shape" };
}

/** Normalise whatever the API or an uploaded file gave us into the UI shape. */
export function asSnapshotFile(value: unknown): SnapshotFile | null {
  if (!value || typeof value !== "object") return null;
  return value as SnapshotFile;
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
