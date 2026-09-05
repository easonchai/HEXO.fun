import { Module } from "@nestjs/common";

import { ChainModule } from "./chain/chain.module";
import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [ConfigModule, ChainModule],
  controllers: [HealthController],
})
export class AppModule {}
