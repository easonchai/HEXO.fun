-- beta-launch-fixes ticket 07: one more nullable OperatorState column, same
-- shape as withdrawSkippedCount (null until a tick has looked).

-- AlterTable
ALTER TABLE "OperatorState" ADD COLUMN     "registrationIndexerStale" BOOLEAN;
