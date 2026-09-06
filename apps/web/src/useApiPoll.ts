/**
 * Polls one `api.ts` fetcher on an interval and keeps the last good value on
 * screen if a poll fails, matching `read.ts`'s "never blank the screen"
 * convention. Used by the header status pill and the WeeklyDraw/Leaderboard
 * screens, which all poll aggregate API state on the same 2 s cadence ticket
 * 10 established for chain reads.
 *
 * ponytail: no backoff beyond the plain interval tick. Add one if the API
 * proves flaky enough under load to need it.
 */
import { useEffect, useState } from "react";
import type { ApiResult } from "./api.js";

export interface ApiPollState<T> {
  data: T | null;
  error: string | null;
}

export function useApiPoll<T>(
  load: (signal: AbortSignal) => Promise<ApiResult<T>>,
  intervalMs: number,
): ApiPollState<T> {
  const [state, setState] = useState<ApiPollState<T>>({
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      const result = await load(controller.signal);
      if (cancelled) return;
      setState((current) =>
        result.ok
          ? { data: result.data, error: null }
          : { data: current.data, error: result.reason },
      );
    };

    void run();
    const timer = window.setInterval(() => {
      if (!document.hidden) void run();
    }, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, intervalMs]);

  return state;
}
