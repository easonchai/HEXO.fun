import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import helmet from "@fastify/helmet";

import { AppModule } from "./app.module";
import type { HexVaultEnv } from "./config/env";

async function bootstrap(): Promise<void> {
  // trustProxy: the API sits behind Traefik, so every request's remote
  // address is Traefik's; trusting the forwarded header is what lets the
  // throttler (api.module.ts) key on the real client (ticket 13).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  // SAFETY: the workspace has two copies of `fastify` at different patch
  // versions (@nestjs/platform-fastify's own dependency vs. the root
  // devDependency @fastify/helmet's bundled types resolve against), so
  // TypeScript sees two structurally different `FastifyInstance` types for
  // what is, at runtime, the same fastify 5.x plugin API.
  await app.register(helmet as unknown as Parameters<typeof app.register>[0]);
  const config = app.get<ConfigService<HexVaultEnv, true>>(ConfigService);
  // Comma-separated list, e.g. "https://app.vercel.app,http://localhost:5173".
  app.enableCors({
    origin: config
      .get("CORS_ORIGIN", { infer: true })
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  const port = Number(config.get("PORT", { infer: true }));
  await app.listen(port, "0.0.0.0");
}

bootstrap();
