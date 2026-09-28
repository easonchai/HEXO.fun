-- beta-launch-fixes ticket 06: one more nullable OperatorState column, same
-- shape as the existing withdrawShortfall (null until a tick has looked, so
-- /status can tell "never checked" from "checked and clean").

-- AlterTable
ALTER TABLE "OperatorState" ADD COLUMN     "withdrawSkippedCount" INTEGER;
