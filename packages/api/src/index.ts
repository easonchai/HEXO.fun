import { Pool } from "pg";
import Fastify from "fastify";
import pino from "pino";
import { createServer } from "./server.ts";
import { fromPg, healthCheck } from "./queries.ts";

const PORT = Number(process.env.PORT ?? 8081);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const client = fromPg(pool);
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const app = await createServer({ client, logLevel: log.level });

/** Prometheus text format, computed from the same tables the routes read. */
app.get("/metrics", async (_request, reply) => {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::text FROM events) AS events,
       (SELECT COUNT(*)::text FROM pools) AS pools,
       (SELECT COUNT(*)::text FROM epochs) AS epochs,
       (SELECT COUNT(*)::text FROM rounds) AS rounds,
       (SELECT COUNT(*)::text FROM positions) AS positions,
       (SELECT COUNT(*)::text FROM reconciliation_runs WHERE ok) AS checks_ok,
       (SELECT COUNT(*)::text FROM reconciliation_runs WHERE NOT ok) AS checks_failed,
       (SELECT COALESCE(MAX(slot),0)::text FROM events) AS max_slot`,
  );
  const row = rows[0]!;
  const health = await healthCheck(client);
  const lines = [
    "# TYPE hexvault_api_events_stored gauge",
    `hexvault_api_events_stored ${row.events}`,
    "# TYPE hexvault_api_pools gauge",
    `hexvault_api_pools ${row.pools}`,
    "# TYPE hexvault_api_epochs gauge",
    `hexvault_api_epochs ${row.epochs}`,
    "# TYPE hexvault_api_rounds gauge",
    `hexvault_api_rounds ${row.rounds}`,
    "# TYPE hexvault_api_positions gauge",
    `hexvault_api_positions ${row.positions}`,
    "# TYPE hexvault_api_reconciliation_ok gauge",
    `hexvault_api_reconciliation_ok ${row.checks_ok}`,
    "# TYPE hexvault_api_reconciliation_failed gauge",
    `hexvault_api_reconciliation_failed ${row.checks_failed}`,
    "# TYPE hexvault_indexer_cursor_age_seconds gauge",
    `hexvault_indexer_cursor_age_seconds ${health.cursorAgeSeconds ?? -1}`,
    "",
  ];
  return reply.type("text/plain").send(lines.join("\n"));
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => log.info({ port: PORT }, "api listening"))
  .catch((error) => {
    log.error({ error: String(error) }, "api failed to start");
    process.exit(1);
  });
