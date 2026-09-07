import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";

import { AppModule } from "./app.module";
import type { HexVaultEnv } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get<ConfigService<HexVaultEnv, true>>(ConfigService);
  app.enableCors({ origin: config.get("CORS_ORIGIN", { infer: true }) });
  const port = Number(config.get("PORT", { infer: true }));
  await app.listen(port, "0.0.0.0");
}

bootstrap();
