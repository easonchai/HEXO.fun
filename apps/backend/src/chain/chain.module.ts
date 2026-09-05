import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection } from "@solana/web3.js";

import type { HexVaultEnv } from "../config/env";
import { ChainService, SOLANA_CONNECTION } from "./chain.service";

@Module({
  providers: [
    {
      provide: SOLANA_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<HexVaultEnv, true>) =>
        new Connection(config.get("RPC_URL", { infer: true }), "confirmed"),
    },
    ChainService,
  ],
  exports: [ChainService],
})
export class ChainModule {}
