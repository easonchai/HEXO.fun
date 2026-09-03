import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import pino from "pino";
import {
  getPool,
  getPlayer,
  getSnapshot,
  healthCheck,
  listEpochs,
  listEvents,
  listJackpots,
  listPrizes,
  listReconciliations,
  listPools,
  listRounds,
  type Client,
} from "./queries.ts";

export interface ServerOptions {
  readonly client: Client;
  readonly logLevel?: string;
}

const badRequest = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 400 });

const address = (value: unknown): string => {
  const text = String(value ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
    throw badRequest("address must be a base58 public key");
  }
  return text;
};

const u64 = (value: unknown): string => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw badRequest("epoch must be a u64");
  return text;
};

const uint = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Read-only Fastify app. `client` is injected so tests can stub Postgres. */
export const createServer = async (options: ServerOptions) => {
  const app = Fastify({
    loggerInstance: pino({ level: options.logLevel ?? "info" }),
  });
  // The read API is consumed by the web app from another origin in dev;
  // reflect the caller so localnet/devnet frontends can read the cache.
  await app.register(cors, { origin: true });
  const client = options.client;

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const health = await healthCheck(client);
      // Ready once the indexer has ingested at least one finalized event.
      if (health.events === 0)
        return reply.code(503).send({ ready: false, ...health });
      return { ready: true, ...health };
    } catch (error) {
      return reply.code(503).send({ ready: false, error: String(error) });
    }
  });

  app.get("/pools", async () => ({ pools: await listPools(client) }));

  app.get("/pools/:address", async (request, reply) => {
    const target = await getPool(
      client,
      address((request.params as { address: string }).address),
    );
    if (!target) return reply.code(404).send({ error: "pool not found" });
    return target;
  });

  app.get("/pools/:address/epochs", async (request) => ({
    epochs: await listEpochs(
      client,
      address((request.params as { address: string }).address),
    ),
  }));

  app.get("/pools/:address/rounds", async (request) => {
    const query = request.query as { epoch?: string };
    return {
      rounds: await listRounds(
        client,
        address((request.params as { address: string }).address),
        query.epoch ? u64(query.epoch) : undefined,
      ),
    };
  });

  app.get("/players/:pool/:owner", async (request) => {
    const params = request.params as { pool: string; owner: string };
    return getPlayer(client, address(params.pool), address(params.owner));
  });

  app.get("/prizes/:pool", async (request) => ({
    prizes: await listPrizes(
      client,
      address((request.params as { pool: string }).pool),
    ),
  }));

  app.get("/jackpots/:pool", async (request) => ({
    jackpots: await listJackpots(
      client,
      address((request.params as { pool: string }).pool),
    ),
  }));

  app.get("/snapshot/:pool/:epoch", async (request) => {
    const params = request.params as { pool: string; epoch: string };
    const snapshot = await getSnapshot(
      client,
      address(params.pool),
      u64(params.epoch),
    );
    if (!snapshot) return { snapshot: null };
    return { snapshot };
  });

  app.get("/reconciliations", async (request) => {
    const query = request.query as { limit?: string };
    return {
      runs: await listReconciliations(client, uint(query.limit, 50)),
    };
  });

  app.get("/events", async (request) => {
    const query = request.query as { limit?: string; pool?: string };
    return {
      events: await listEvents(
        client,
        uint(query.limit, 30),
        query.pool ? address(query.pool) : undefined,
      ),
    };
  });

  // Validation helpers throw; map them to JSON rather than a 500 HTML page.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500)
      app.log.error({ error: error.message }, "request failed");
    return reply.code(statusCode).send({ error: error.message });
  });

  return app;
};

export default createServer;
