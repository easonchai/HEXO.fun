import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { ChainModule } from "../chain/chain.module";
import { AccessController } from "./access.controller";
import { AlertsController } from "./alerts.controller";
import { ApiController } from "./api.controller";
import { ApiService } from "./api.service";
import { FaucetController } from "./faucet.controller";
import { ReferralsController } from "./referrals.controller";
import { SerializationInterceptor } from "./serialization.interceptor";

/**
 * spec.md §3.5. The interceptor and the guard are registered here rather than
 * in main.ts so importing this module is the whole wiring. `skipIf` keeps the
 * global guard off every route but the faucet and access: the frontend polls
 * the read routes every 2 s and /healthz is a container probe. Access is
 * throttled too, same limit: a script trying invite codes against POST
 * /access/redeem is exactly what this guards against (ticket 06).
 */
@Module({
  imports: [
    ChainModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 10,
        skipIf: (context) => {
          const controller = context.getClass();
          return controller !== FaucetController && controller !== AccessController;
        },
      },
    ]),
  ],
  controllers: [
    ApiController,
    AlertsController,
    FaucetController,
    AccessController,
    ReferralsController,
  ],
  providers: [
    ApiService,
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class ApiModule {}
