-- ADR 0016 (docs/plan/pool-cutover ticket 01): every pool-scoped table gains
-- poolAddress as part of its key, so a Pool cutover keeps the database.
-- Assumes empty pool-scoped tables (fresh database). A database with rows
-- fails on NOT NULL; run `prisma migrate reset` on it.

ALTER TABLE "Epoch" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "Round" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "Player" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "Position" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "Event" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "Cursor" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "OperatorState" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "ReferralGrant" ADD COLUMN "poolAddress" TEXT NOT NULL;
ALTER TABLE "ReferralGrantShare" ADD COLUMN "poolAddress" TEXT NOT NULL;

-- Primary keys.
ALTER TABLE "Epoch" DROP CONSTRAINT "Epoch_pkey",
ADD CONSTRAINT "Epoch_pkey" PRIMARY KEY ("poolAddress", "id");

ALTER TABLE "Round" DROP CONSTRAINT "Round_pkey",
ADD CONSTRAINT "Round_pkey" PRIMARY KEY ("poolAddress", "id");

ALTER TABLE "Player" DROP CONSTRAINT "Player_pkey",
ADD CONSTRAINT "Player_pkey" PRIMARY KEY ("poolAddress", "owner");

ALTER TABLE "Cursor" DROP CONSTRAINT "Cursor_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "Cursor_pkey" PRIMARY KEY ("poolAddress");

ALTER TABLE "OperatorState" DROP CONSTRAINT "OperatorState_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "OperatorState_pkey" PRIMARY KEY ("poolAddress");

-- Unique indexes.
DROP INDEX "ReferralGrant_epochId_referrer_key";
CREATE UNIQUE INDEX "ReferralGrant_poolAddress_epochId_referrer_key" ON "ReferralGrant"("poolAddress", "epochId", "referrer");

DROP INDEX "ReferralGrantShare_epochId_referrer_referee_key";
CREATE UNIQUE INDEX "ReferralGrantShare_poolAddress_epochId_referrer_referee_key" ON "ReferralGrantShare"("poolAddress", "epochId", "referrer", "referee");

-- Indexes.
CREATE INDEX "Event_poolAddress_slot_idx" ON "Event"("poolAddress", "slot");
CREATE INDEX "Player_owner_idx" ON "Player"("owner");
CREATE INDEX "Position_poolAddress_roundId_idx" ON "Position"("poolAddress", "roundId");

-- Foreign keys.
ALTER TABLE "Epoch" ADD CONSTRAINT "Epoch_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Round" ADD CONSTRAINT "Round_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Position" ADD CONSTRAINT "Position_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cursor" ADD CONSTRAINT "Cursor_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperatorState" ADD CONSTRAINT "OperatorState_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralGrant" ADD CONSTRAINT "ReferralGrant_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralGrantShare" ADD CONSTRAINT "ReferralGrantShare_poolAddress_fkey" FOREIGN KEY ("poolAddress") REFERENCES "Pool"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
