-- Ticket 09: OPERATOR_FAILING, EPOCH_NO_PROGRESS and DRAWN_UNPAID need the
-- operator to remember these across ticks; additive, no backfill needed.
ALTER TABLE "OperatorState" ADD COLUMN "lastSuccessAt" BIGINT;
ALTER TABLE "OperatorState" ADD COLUMN "epochNoProgress" BOOLEAN;
ALTER TABLE "OperatorState" ADD COLUMN "drawnUnpaid" BOOLEAN;
