import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";
import type { Client } from "./queries.ts";

const POOL = "Pool1111111111111111111111111111111111111111";
const OWNER = "Owner111111111111111111111111111111111111111";
const BAD = "not-an-address!";

// Route params are validated as base58, so keep every fixture inside
// [1-9A-HJ-NP-Za-km-z] (no 0, O, I or l) and pad to 44 characters.
const base58 = (seed: string): string =>
  seed
    .replace(/[0OIl]/g, "")
    .padEnd(44, "2")
    .slice(0, 44);

/** Deterministic stub of the read side; no Postgres needed. */
const rows = new Map<string, Record<string, unknown>[]>();
const stub: Client = {
  async query(sql: string) {
    const key = String(sql).replace(/\s+/g, " ").trim();
    return { rows: rows.get(key) ?? [] };
  },
};

const seed = (sql: string, result: Record<string, unknown>[]): void => {
  rows.set(sql.replace(/\s+/g, " ").trim(), result);
};

describe("api routes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    seed("SELECT * FROM pools ORDER BY pool_id", [
      {
        address: base58(POOL),
        pool_id: "1",
        accepted_mint: base58("MINT"),
        accepted_token_program: base58("TOKENPROG"),
        accepted_decimals: 6,
        principal_mint: base58("PT"),
        entry_mint: base58("ET"),
        principal_vault: base58("PV"),
        prize_vault: base58("PRV"),
        jackpot_vault: base58("JV"),
        min_deposit: "100",
        max_stake_per_tile: "500",
        max_round_bonus_entries: "3",
        min_epoch_seconds: "60",
        max_epoch_seconds: "86400",
        round_close_buffer_seconds: "5",
        latest_epoch_id: "1",
        paused: false,
        principal_minted: "1500",
        principal_withdrawn: "0",
        prize_funded: "400",
        jackpot_funded: "90",
      },
    ]);
    seed("SELECT * FROM players WHERE pool = $1 AND owner = $2", [
      {
        principal: "1000",
        entries_spent_since_refresh: "600",
        entries_rewarded_since_refresh: "50",
        last_refresh_epoch: "1",
      },
    ]);
    seed("SELECT slot::text FROM cursor WHERE id = 1", [{ slot: "42" }]);
    seed(
      "SELECT (SELECT slot::text FROM cursor WHERE id = 1) AS cursor, (SELECT updated_at FROM cursor WHERE id = 1) AS updated_at, (SELECT COUNT(*)::text FROM events) AS events",
      [{ cursor: "42", updated_at: new Date(), events: "7" }],
    );

    app = await createServer({ client: stub, logLevel: "silent" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("exposes pools with nested limits and totals", async () => {
    const response = await app.inject({ method: "GET", url: "/pools" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      pools: { address: string; totals: { principalMinted: string } }[];
    };
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0]!.totals.principalMinted).toBe("1500");
  });

  it("computes entries balance and withdrawable from the accumulators", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/players/${base58(POOL)}/${base58(OWNER)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      principal: string;
      entriesBalance: string;
      withdrawable: string;
    };
    // 1000 - 600 + 50 = 450 entries; withdrawable capped by principal at 1000.
    expect(body.entriesBalance).toBe("450");
    expect(body.withdrawable).toBe("450");
    expect(body.principal).toBe("1000");
  });

  it("returns JSON errors, never an HTML 500", async () => {
    const bad = await app.inject({ method: "GET", url: `/pools/${BAD}` });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers["content-type"]).toContain("application/json");
    expect(bad.json()).toEqual({
      error: "address must be a base58 public key",
    });

    const missing = await app.inject({
      method: "GET",
      url: `/pools/${base58("NOPE")}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "pool not found" });
  });

  it("rejects a non-numeric epoch", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/pools/${base58(POOL)}/rounds?epoch=abc`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "epoch must be a u64" });
  });

  it("reports ready only once events exist", async () => {
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect((ready.json() as { ready: boolean }).ready).toBe(true);

    const emptyHealth =
      "SELECT (SELECT slot::text FROM cursor WHERE id = 1) AS cursor, (SELECT updated_at FROM cursor WHERE id = 1) AS updated_at, (SELECT COUNT(*)::text FROM events) AS events";
    seed(emptyHealth, [{ cursor: null, updated_at: null, events: "0" }]);
    const notReady = await app.inject({ method: "GET", url: "/readyz" });
    expect(notReady.statusCode).toBe(503);
    expect((notReady.json() as { ready: boolean }).ready).toBe(false);
  });

  it("serves healthz without touching the database", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("returns an empty snapshot object when none is stored", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/snapshot/${base58(POOL)}/1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ snapshot: null });
  });

  it("serves the recent event feed newest-first", async () => {
    seed(
      "SELECT slot, signature, event_index, name, pool, payload, block_time FROM events WHERE ($1::text IS NULL OR pool = $1) ORDER BY slot DESC, signature DESC, event_index DESC LIMIT $2",
      [
        {
          slot: "120",
          signature: "sig-b",
          event_index: 0,
          name: "RoundSettled",
          pool: base58(POOL),
          payload: { winning_tile: 5 },
          block_time: "1700000100",
        },
        {
          slot: "100",
          signature: "sig-a",
          event_index: 1,
          name: "PositionPurchased",
          pool: base58(POOL),
          payload: { total_stake: "250000" },
          block_time: "1700000000",
        },
      ],
    );
    const response = await app.inject({
      method: "GET",
      url: `/events?limit=2&pool=${base58(POOL)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: { name: string; slot: string; payload: unknown }[];
    };
    expect(body.events.map((event) => event.name)).toEqual([
      "RoundSettled",
      "PositionPurchased",
    ]);
    expect(body.events[0]!.slot).toBe("120");
    expect(body.events[0]!.payload).toEqual({ winning_tile: 5 });

    const invalid = await app.inject({
      method: "GET",
      url: `/events?pool=${BAD}`,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
