import { readdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Idl } from "@anchor-lang/core";
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { Pool as PgPool } from "pg";
import {
  createEventDecoder,
  loadIdl,
  toEventRows,
  type DecodedEvent,
  type RawLog,
} from "./decode.ts";
import type { EventRow } from "./events.ts";
import { fetchPoolAccount, decodePool, POOL_UPDATES } from "./accounts.ts";
import { METRIC_NAMES, Metrics } from "./metrics.ts";
import { Reconciler } from "./reconcile.ts";
import { SnapshotService } from "./snapshot.ts";
import { Store } from "./store.ts";

export const PROGRAM_ID = "6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB";

export const hasTransactionError = (
  transaction:
    | {
        readonly meta?: { readonly err?: unknown } | null;
      }
    | null
    | undefined,
): boolean => transaction?.meta?.err != null;

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const metrics = new Metrics();

export interface IndexerConfig {
  readonly rpcUrl: string;
  readonly databaseUrl: string;
  readonly programId: string;
  readonly idlPath: string;
  readonly migrationsDir: string;
  readonly reconcileIntervalMs: number;
}

export const configFromEnv = (): IndexerConfig => ({
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8899",
  databaseUrl: requireEnv("DATABASE_URL"),
  programId: process.env.PROGRAM_ID ?? PROGRAM_ID,
  idlPath: process.env.IDL_PATH ?? "target/idl/hex_vault.json",
  migrationsDir: process.env.MIGRATIONS_DIR ?? "packages/indexer/migrations",
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 60_000),
});

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export class Indexer {
  private readonly store: Store;
  private readonly snapshots: SnapshotService;
  private readonly connection: Connection;
  private readonly decode: (line: string) => DecodedEvent | null;
  private readonly idl: Idl;
  private readonly programKey: PublicKey;
  private readonly config: IndexerConfig;
  private readonly pg: PgPool;
  private pending: RawLog[] = [];
  private busy = false;

  constructor(config: IndexerConfig, pg: PgPool, connection?: Connection) {
    this.config = config;
    this.pg = pg;
    this.store = new Store(pg, (obj, msg) => log.info(obj, msg));
    this.snapshots = new SnapshotService(pg, (obj, msg) => log.info(obj, msg));
    this.connection =
      connection ??
      new Connection(config.rpcUrl, {
        commitment: "finalized",
      });
    this.idl = loadIdl(config.idlPath);
    this.decode = createEventDecoder(this.idl);
    this.programKey = new PublicKey(config.programId);
  }

  async start(): Promise<void> {
    await this.store.migrate(this.migrationFiles());
    log.info({ dir: this.config.migrationsDir }, "migrations applied");

    // A test validator restarted from genesis leaves the stored cursor ahead of
    // the tip; the only safe response is to re-index from scratch.
    await this.detectChainReset();

    // The validator may not be up yet; the poll below retries, so a failed
    // boot catch-up is not fatal.
    await this.catchUp().catch((error) =>
      log.warn({ error: String(error) }, "boot catch-up skipped"),
    );

    // web3.js onLogs omits the slot, which the cursor ordering needs, so the
    // transaction is fetched once per finalized signature.
    this.connection.onLogs(
      this.programKey,
      (logs) => {
        void this.ingestSignature(logs.signature).catch((error) =>
          log.error({ error: String(error) }, "ingest failed"),
        );
      },
      "finalized",
    );

    setInterval(() => {
      void this.catchUp().catch((error) =>
        log.warn({ error: String(error) }, "catch-up poll failed"),
      );
      void this.runReconciliation().catch((error) =>
        log.error({ error: String(error) }, "reconciliation failed"),
      );
    }, this.config.reconcileIntervalMs);
    log.info(
      { rpc: this.config.rpcUrl, program: this.config.programId },
      "indexer subscribed",
    );
  }

  private async detectChainReset(): Promise<void> {
    const cursor = await this.store.getCursor();
    if (!cursor) return;
    const tip = BigInt(await this.connection.getSlot("finalized"));
    if (tip >= cursor.slot) return;
    log.warn(
      { cursorSlot: cursor.slot.toString(), chainTip: tip.toString() },
      "chain reset detected",
    );
    await this.store.resetChain();
  }

  private migrationFiles(): string[] {
    return readdirSync(this.config.migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => join(this.config.migrationsDir, file));
  }

  /** Fetches one finalized transaction and feeds its logs to the store. */
  private async ingestSignature(signature: string): Promise<void> {
    const raw = await this.fetchLog(signature);
    if (raw) await this.ingest([raw]);
  }

  private async fetchLog(signature: string): Promise<RawLog | null> {
    const transaction = await this.connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (
      hasTransactionError(transaction) ||
      !transaction?.meta?.logMessages ||
      transaction.slot === undefined
    )
      return null;
    return {
      slot: BigInt(transaction.slot),
      signature,
      logs: transaction.meta.logMessages,
      blockTime: transaction.blockTime ?? null,
    };
  }

  /** Polls for anything the subscription missed (restart, dropped socket). */
  async catchUp(): Promise<void> {
    const cursor = await this.store.getCursor();
    const collected: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    // getSignaturesForAddress caps at 1000 per call; page backwards with
    // `before` until the stored cursor turns up or the chain runs out, so a
    // long outage never leaves a gap between the cursor and the newest 1000.
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(
        this.programKey,
        { before, until: cursor?.signature, limit: 1000 },
      );
      if (page.length === 0) break;
      const cursorIndex = cursor
        ? page.findIndex((entry) => entry.signature === cursor.signature)
        : -1;
      if (cursorIndex === -1) {
        collected.push(...page);
        before = page[page.length - 1]!.signature;
      } else {
        collected.push(...page.slice(0, cursorIndex));
        break;
      }
    }

    const finalized = collected.filter(
      (entry) => entry.confirmationStatus === "finalized",
    );
    if (finalized.length === 0) return;

    const batch: RawLog[] = [];
    // getSignaturesForAddress is newest-first; ingest expects ascending order.
    for (const entry of [...finalized].reverse()) {
      if (!entry.signature || entry.err) continue;
      const raw = await this.fetchLog(entry.signature);
      if (raw) batch.push(raw);
    }
    await this.ingest(batch);
  }

  /** Single-flight ingest: bursts of log callbacks collapse into one batch. */
  async ingest(raw: readonly RawLog[]): Promise<number> {
    this.pending.push(...raw);
    if (this.busy) return 0;
    this.busy = true;
    try {
      let applied = 0;
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        const rows = toEventRows(batch, this.decode, this.config.programId);
        const dataLines = batch.reduce(
          (total, entry) =>
            total +
            entry.logs.filter((line) => line.startsWith("Program data: "))
              .length,
          0,
        );
        metrics.inc(
          METRIC_NAMES.decodeFailures,
          dataLines - rows.events.length,
        );
        if (rows.events.length === 0) continue;
        applied += await this.store.applyBatch(rows.events);
        metrics.inc(METRIC_NAMES.batchesApplied);
        metrics.inc(METRIC_NAMES.eventsProcessed, rows.events.length);
        await this.syncPools(rows.events);
      }
      return applied;
    } finally {
      this.busy = false;
    }
  }

  /**
   * PoolCreated carries only the pool id, so the account itself is fetched once
   * to populate the vault/mint columns the API and reconciler depend on.
   */
  private async syncPools(events: readonly EventRow[]): Promise<void> {
    const created = new Set(
      events
        .filter((event) => event.name === "PoolCreated")
        .map((event) => event.pool),
    );
    for (const pool of created) {
      const data = await fetchPoolAccount(this.connection, new PublicKey(pool));
      if (!data) continue;
      const [sql, params] = POOL_UPDATES(pool, decodePool(this.idl, data));
      await this.pg.query(sql, params);
      log.info({ pool }, "pool account synced");
    }
  }

  async runReconciliation(): Promise<void> {
    const reconciler = new Reconciler({
      connection: this.connection,
      pg: this.pg,
      snapshots: this.snapshots,
      log: (obj, msg) => log.info(obj, msg),
    });
    const outcomes = await reconciler.runAll();
    for (const outcome of outcomes) {
      metrics.inc(
        outcome.ok
          ? METRIC_NAMES.reconciliationOk
          : METRIC_NAMES.reconciliationFailed,
        1,
        { check: outcome.check },
      );
      if (outcome.check === "cursor_freshness") {
        const age = outcome.detail.age_seconds;
        if (typeof age === "number") {
          metrics.setGauge(METRIC_NAMES.cursorAgeSeconds, age);
        }
      }
    }
  }

  get metricsText(): string {
    return metrics.render();
  }

  get snapshotService(): SnapshotService {
    return this.snapshots;
  }

  get storeHandle(): Store {
    return this.store;
  }
}

export const createIndexer = async (): Promise<Indexer> => {
  const config = configFromEnv();
  const pg = new PgPool({ connectionString: config.databaseUrl, max: 5 });
  const indexer = new Indexer(config, pg);
  await indexer.start();
  return indexer;
};

if (process.argv[1]?.endsWith("index.ts")) {
  createIndexer().catch((error) => {
    log.error({ error: String(error) }, "indexer failed to start");
    process.exit(1);
  });
}
