/**
 * Ticket 16: a hung backend must not freeze the Vault on stale numbers. This
 * drives `fetchHealth` (a plain `get<T>` caller) against a `fetch` stub that
 * never settles, and checks the timeout copy is the plain banner text, never
 * the browser's raw "Failed to fetch".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHealth, TIMEOUT_MESSAGE } from "./api.js";

describe("get (via fetchHealth) timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("produces the plain timeout banner text, not a raw fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("This operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );

    const pending = fetchHealth("http://api.example.com");
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: TIMEOUT_MESSAGE });
  });

  it("still reports the real reason for a non-timeout failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const result = await fetchHealth("http://api.example.com");

    expect(result).toEqual({ ok: false, reason: "network down" });
  });
});
