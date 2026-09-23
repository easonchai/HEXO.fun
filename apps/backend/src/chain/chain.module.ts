import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection } from "@solana/web3.js";

import type { HexVaultEnv } from "../config/env";
import { ChainService, SOLANA_CONNECTION } from "./chain.service";
import { withRpcFallback } from "./rpc-fallback";

@Module({
  providers: [
    {
      provide: SOLANA_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<HexVaultEnv, true>) => {
        const primary = new Connection(config.get("RPC_URL", { infer: true }), "confirmed");
        const fallbackUrl = config.get("RPC_FALLBACK_URL", { infer: true });
        const fallback = fallbackUrl ? new Connection(fallbackUrl, "confirmed") : undefined;
        return withRpcFallback(
          primary,
          fallback,
          config.get("RPC_TIMEOUT_MS", { infer: true }),
        );
      },
    },
    ChainService,
  ],
  exports: [ChainService],
})
export class ChainModule {}
