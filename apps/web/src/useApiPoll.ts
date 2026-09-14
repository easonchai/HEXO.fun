/**
 * Polls one `api.ts` fetcher on an interval and keeps the last good value on
 * screen if a poll fails, matching the "never blank the screen" convention
 * `useStatePoll.ts` also follows. Ticket 07: the consolidated `GET /state`
 * poll (Pool, Epoch, Player, Round, operator status) has its own hook now;
 * this one is left for the list-data endpoints that stay on a slower,
 * independent poll — epoch history, leaderboard, the activity feed, rounds
 * played — since none of them belongs on a short interval.
 *
 * ponytail: no backoff beyond the plain interval tick. Add one if the API
 * proves flaky enough under load to need it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "./api.js";

export interface ApiPollState<T> {
  data: T | null;
  error: string | null;
  /** Re-run the fetcher now, outside the interval. */
  refresh: () => void;
}

export function useApiPoll<T>(
  load: (signal: AbortSignal) => Promise<ApiResult<T>>,
  intervalMs: number,
): ApiPollState<T> {
  const [state, setState] = useState<Omit<ApiPollState<T>, "refresh">>({
    data: null,
    error: null,
  });
  const runRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => runRef.current(), []);

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
    runRef.current = () => void run();

    void run();
    const timer = window.setInterval(() => {
      if (!document.hidden) void run();
    }, intervalMs);

    return () => {
      cancelled = true;
      runRef.current = () => {};
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, intervalMs]);

  return { ...state, refresh };
}
