import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { ChainModule } from "../chain/chain.module";
import { IndexerModule } from "../indexer/indexer.module";
import { IndexerService } from "../indexer/indexer.service";
import { INDEXER_QUERIES } from "./indexer-queries";
import { OperatorService } from "./operator.service";

/**
 * `ScheduleModule.forRoot()` is imported here rather than in AppModule so the
 * crank brings its own scheduler. The indexer runs on a plain setInterval, so
 * this is the only `forRoot()` in the graph and no job double-fires.
 *
 * The INDEXER_QUERIES binding lives here, not in AppModule: Nest resolves a
 * provider's dependencies from its own module and the exports of that
 * module's imports, never from the parent. The token still exists so the two
 * modules never import each other's implementation.
 */
@Module({
  imports: [ScheduleModule.forRoot(), ChainModule, IndexerModule],
  providers: [
    OperatorService,
    { provide: INDEXER_QUERIES, useExisting: IndexerService },
  ],
  exports: [OperatorService],
})
export class OperatorModule {}
