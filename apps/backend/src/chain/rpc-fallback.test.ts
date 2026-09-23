import type { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { rpcStatus, withRpcFallback } from "./rpc-fallback";

/** A minimal stand-in for `Connection`: only `rpcEndpoint` plus whichever
 *  methods a test needs, cast the same way `CountingConnection` is. */
function fakeConnection(
  rpcEndpoint: string,
  methods: Record<string, (...args: unknown[]) => unknown>,
): Connection {
  return { rpcEndpoint, ...methods } as unknown as Connection;
}

describe("withRpcFallback", () => {
  it("rejects a hanging read after the timeout", async () => {
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => new Promise(() => {}), // never resolves
    });
    const connection = withRpcFallback(primary, undefined, 20);

    await expect(connection.getSlot()).rejects.toThrow(/timed out after 20ms/);
  });

  it("fails over to the fallback on a primary 5xx and records the status fields", async () => {
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => Promise.reject(new Error("503 Service Unavailable: overloaded")),
    });
    const fallback = fakeConnection("https://fallback.example", {
      getSlot: () => Promise.resolve(42),
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    await expect(connection.getSlot()).resolves.toBe(42);
    const status = rpcStatus(connection);
    expect(status.endpoint).toBe("fallback");
    expect(status.fallbackAt).not.toBeNull();
  });

  it("fails over on a 429 too", async () => {
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => Promise.reject(new Error("429 Too Many Requests: slow down")),
    });
    const fallback = fakeConnection("https://fallback.example", {
      getSlot: () => Promise.resolve(7),
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    await expect(connection.getSlot()).resolves.toBe(7);
  });

  it("passes a primary error through unchanged with no fallback configured", async () => {
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => Promise.reject(new Error("503 Service Unavailable: overloaded")),
    });
    const connection = withRpcFallback(primary, undefined, 1_000);

    await expect(connection.getSlot()).rejects.toThrow("503 Service Unavailable: overloaded");
    expect(rpcStatus(connection)).toEqual({ endpoint: "primary", fallbackAt: null });
  });

  it("does not fail over on an ordinary program/RPC error", async () => {
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => Promise.reject(new Error("failed to get slot: custom program error: 0x1")),
    });
    const fallback = fakeConnection("https://fallback.example", {
      getSlot: () => {
        throw new Error("should never be called");
      },
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    await expect(connection.getSlot()).rejects.toThrow("custom program error: 0x1");
    expect(rpcStatus(connection).endpoint).toBe("primary");
  });

  it("tries the primary again on the next call", async () => {
    let primaryCalls = 0;
    const primary = fakeConnection("https://primary.example", {
      getSlot: () => {
        primaryCalls += 1;
        return primaryCalls === 1
          ? Promise.reject(new Error("500 Internal Server Error: boom"))
          : Promise.resolve(7);
      },
    });
    const fallback = fakeConnection("https://fallback.example", {
      getSlot: () => Promise.resolve(99),
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    await expect(connection.getSlot()).resolves.toBe(99);
    await expect(connection.getSlot()).resolves.toBe(7);
    expect(primaryCalls).toBe(2);
    expect(rpcStatus(connection).endpoint).toBe("primary");
  });

  it("leaves subscription methods pinned to the primary, unwrapped", () => {
    let calledOnPrimary = false;
    const primary = fakeConnection("https://primary.example", {
      onLogs: () => {
        calledOnPrimary = true;
        return 1;
      },
    });
    const fallback = fakeConnection("https://fallback.example", {
      onLogs: () => {
        throw new Error("fallback must never be called for a subscription");
      },
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    // SAFETY: the fake only implements `onLogs`; the real signature needs an
    // address and a callback, neither of which this stub reads.
    (connection.onLogs as (...args: unknown[]) => unknown)();

    expect(calledOnPrimary).toBe(true);
  });

  it("scrubs both endpoints' urls out of a failed-on-both-endpoints error", async () => {
    const primary = fakeConnection("https://primary.example/?api-key=SECRET1", {
      getSlot: () =>
        Promise.reject(new Error("500 https://primary.example/?api-key=SECRET1 failed")),
    });
    const fallback = fakeConnection("https://fallback.example/?api-key=SECRET2", {
      getSlot: () =>
        Promise.reject(new Error("500 https://fallback.example/?api-key=SECRET2 failed")),
    });
    const connection = withRpcFallback(primary, fallback, 1_000);

    const error = await connection.getSlot().catch((cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SECRET1");
    expect((error as Error).message).not.toContain("SECRET2");
  });
});
