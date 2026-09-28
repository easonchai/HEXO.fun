-- ADR 0016 (docs/plan/pool-cutover ticket 01): every pool-scoped table gains
-- poolAddress as part of its key, so a Pool cutover keeps the database.
--
-- Hand-edited from `prisma migrate diff`. Existing rows belong to the one
-- Pool the boot guard has allowed until now, so they are backfilled from it.
-- An empty database (first boot) backfills nothing.

-- The backfill below is only correct with at most one Pool row. The old boot
-- guard enforced that; refuse loudly if something slipped past it.
DO $$
BEGIN
  IF (SELECT count(*) FROM "Pool") > 1 THEN
    RAISE EXCEPTION 'pool_address_scoping: Pool holds % rows, expected at most 1; cannot tell which pool existing rows belong to', (SELECT count(*) FROM "Pool");
  END IF;
END $$;

-- Add nullable, backfill, then NOT NULL.
ALTER TABLE "Epoch" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "Round" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "Player" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "Position" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "Event" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "Cursor" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "OperatorState" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "ReferralGrant" ADD COLUMN "poolAddress" TEXT;
ALTER TABLE "ReferralGrantShare" ADD COLUMN "poolAddress" TEXT;

UPDATE "Epoch" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "Round" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "Player" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "Position" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "Event" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "Cursor" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "OperatorState" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "ReferralGrant" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);
UPDATE "ReferralGrantShare" SET "poolAddress" = (SELECT "address" FROM "Pool" LIMIT 1);

-- Rows with no Pool to belong to (an empty Pool table beside non-empty
-- scoped tables) would fail NOT NULL with a bare constraint error. Say why.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Epoch" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "Round" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "Player" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "Position" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "Event" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "Cursor" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "OperatorState" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "ReferralGrant" WHERE "poolAddress" IS NULL)
     OR EXISTS (SELECT 1 FROM "ReferralGrantShare" WHERE "poolAddress" IS NULL) THEN
    RAISE EXCEPTION 'pool_address_scoping: pool-scoped rows exist but the Pool table is empty; cannot backfill poolAddress';
  END IF;
END $$;

ALTER TABLE "Epoch" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "Round" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "Player" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "Position" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "Event" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "Cursor" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "OperatorState" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "ReferralGrant" ALTER COLUMN "poolAddress" SET NOT NULL;
ALTER TABLE "ReferralGrantShare" ALTER COLUMN "poolAddress" SET NOT NULL;

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
