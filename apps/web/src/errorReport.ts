/**
 * Ticket 16: posts a decoded send failure or an error-boundary catch to the
 * backend's `POST /error-reports` (apps/backend/src/api/error-report.*), so
 * a broken money path reaches the maintainers instead of only the
 * depositor's console. Best-effort and silent: a failed report must never
 * itself surface an error to the player.
 */
import { apiBaseUrl } from "./api.js";

export interface ErrorReport {
  /** A short machine code: a decoded program error name, or "render_error"
   *  for a boundary catch. Never the raw stack trace. */
  code: string;
  message: string;
  signature?: string | undefined;
  wallet?: string | undefined;
  /** Which screen/tab this happened on, e.g. `window.location.hash`. */
  page?: string | undefined;
}

/** `window.location`'s hash or path, or undefined outside a browser (unit
 *  tests run in Node, no `window`). */
export function currentPage(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.hash || window.location.pathname;
}

export function reportError(report: ErrorReport): void {
  try {
    void fetch(`${apiBaseUrl()}/error-reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      // Best-effort: no retry, no timeout wiring — this must never hold up
      // or fail the flow that triggered it.
      keepalive: true,
    }).catch(() => {
      // Nothing to do: reporting the failure to report a failure is not
      // worth the loop.
    });
  } catch {
    // Same as above, for a synchronous throw (e.g. fetch unavailable).
  }
}
