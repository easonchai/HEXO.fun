// ticket 13: security headers via the Fastify Helmet plugin, registered in
// main.ts the same way this test registers it here — a minimal Nest app so
// the header set is verified without booting the whole backend (real chain,
// real Postgres) that main.ts's bootstrap() otherwise requires.
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import helmet from "@fastify/helmet";

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

describe("Fastify Helmet (ticket 13)", () => {
  let app: NestFastifyApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      PingModule,
      new FastifyAdapter({ trustProxy: true }),
    );
    // SAFETY: see main.ts's own registration — two duplicate `fastify`
    // package versions in the workspace, structurally identical at runtime.
    await app.register(helmet as unknown as Parameters<typeof app.register>[0]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets nosniff and HSTS on every response", async () => {
    const response = await http.get("/ping").expect(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });
});
