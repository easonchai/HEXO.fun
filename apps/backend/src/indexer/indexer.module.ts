import { Module } from "@nestjs/common";

import { ChainModule } from "../chain/chain.module";
import { IndexerService } from "./indexer.service";

// PrismaModule is @Global(), so PrismaService needs no import here.
@Module({
  imports: [ChainModule],
  providers: [IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
